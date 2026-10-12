import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  AlertState,
  CreateIncidentRequest,
  CreateIncidentResponseDto,
  EmergencySettingsDto,
  IncidentDetailDto,
  IncidentListItemDto,
  IncidentViewerDto,
  ListIncidentsQuery,
  Page,
  UpdateEmergencySettingsRequest,
} from '@storeline/shared';
import { ApiError } from '../../infra/http/api-error';
import { isUniqueViolation, PrismaService, type Tx } from '../../infra/prisma/prisma.service';
import { RATE_LIMITS, RateLimiterService } from '../../infra/redis/rate-limiter.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { AuthorizationService } from '../authorization/authorization.service';
import { MessageWriter } from '../messaging/message-writer.service';
import { OutboxService, type PendingOutboxEvent } from '../outbox/outbox.service';
import { publicUserSelect, toPublicUser } from '../users/user.mapper';
import {
  ACTIVE_STATUSES,
  AWAITING_ACK_STATUSES,
  incidentInclude,
  statesBelow,
  toIncidentDto,
  toIncidentEventDto,
  type IncidentRow,
} from './emergency.mapper';
import { EmergencyEscalationService } from './emergency-escalation.service';
import { EmergencyQueryService, type StoreRef } from './emergency-query.service';
import { metrics } from '../../infra/metrics/metrics';

const NOT_ALERTED: AlertState[] = ['PENDING', 'SKIPPED'];

interface ResolvedStore extends StoreRef {
  name: string;
  ackTimeoutSeconds: number;
}

/**
 * Emergency help (docs/architecture/emergency.md). The caller never chooses who is alerted:
 * the server resolves the store from their own memberships and the chain from store settings.
 * Responses identify people by public profile only — contact details never leave the server.
 */
@Injectable()
export class EmergencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly writer: MessageWriter,
    private readonly rateLimiter: RateLimiterService,
    private readonly queries: EmergencyQueryService,
    private readonly escalation: EmergencyEscalationService,
  ) {}

  /** Stores where the caller can raise an alert (for the store picker). */
  async myStores(actor: Actor): Promise<Array<{ id: string; code: string; name: string }>> {
    const stores = await this.activeStores(actor);
    const allowed = [];
    for (const s of stores) {
      if (await this.authz.can(actor, 'emergency.trigger', s))
        allowed.push({ id: s.storeId, code: s.code, name: s.name });
    }
    return allowed;
  }

  async create(
    actor: Actor,
    request: CreateIncidentRequest,
    retried = false,
  ): Promise<CreateIncidentResponseDto> {
    // Idempotent retry of the same press.
    const prior = await this.prisma.emergencyIncident.findUnique({
      where: {
        reporterId_clientIncidentId: {
          reporterId: actor.userId,
          clientIncidentId: request.clientIncidentId,
        },
      },
      select: { id: true },
    });
    if (prior) return { incident: await this.detail(actor, prior.id), existing: false };

    const store = await this.resolveStore(actor, request.storeId);
    await this.authz.require(actor, 'emergency.trigger', store);

    // A second press while an alert is still active re-opens it (and keeps the new details).
    const active = await this.prisma.emergencyIncident.findFirst({
      where: {
        reporterId: actor.userId,
        storeId: store.storeId,
        status: { in: [...ACTIVE_STATUSES] },
      },
      select: { id: true, businessId: true, conversationId: true },
    });
    if (active) {
      if (request.description) await this.appendDescription(actor, active, request);
      return { incident: await this.detail(actor, active.id), existing: true };
    }

    await this.rateLimiter.consume(RATE_LIMITS.emergencyPerUser, actor.userId);

    let created: { id: string; events: PendingOutboxEvent[] } | null;
    try {
      created = await this.prisma.$transaction((tx) => this.createTx(tx, actor, store, request));
    } catch (error) {
      // Lost a race with a concurrent press (active-incident or idempotency unique index).
      if (isUniqueViolation(error) && !retried) return this.create(actor, request, true);
      throw error;
    }
    if (!created) {
      await this.audit.recordSafely(actor, {
        action: 'emergency.incident.no_contact',
        outcome: 'FAILURE',
        businessId: store.businessId,
        storeId: store.storeId,
      });
      throw ApiError.conflict(
        'No one is set up to receive emergency alerts for this store. Call your local emergency number if you are in danger, and tell your administrator.',
      );
    }
    await this.outbox.dispatch(created.events);
    metrics.emergencyRaised.inc();
    return { incident: await this.detail(actor, created.id), existing: false };
  }

  private async createTx(
    tx: Tx,
    actor: Actor,
    store: ResolvedStore,
    request: CreateIncidentRequest,
  ): Promise<{ id: string; events: PendingOutboxEvent[] } | null> {
    const chain = await this.queries.buildChain(tx, store, actor.userId);
    if (chain.length === 0) return null;
    const now = new Date();

    const conversation = await tx.conversation.create({
      data: {
        businessId: store.businessId,
        storeId: store.storeId,
        type: 'EMERGENCY',
        title: `Emergency · ${store.name}`.slice(0, 100),
        createdById: actor.userId,
        memberCount: 1,
        members: { create: [{ userId: actor.userId, role: 'MEMBER', addedById: actor.userId }] },
      },
      select: { id: true, businessId: true },
    });
    const incident = await tx.emergencyIncident.create({
      data: {
        businessId: store.businessId,
        storeId: store.storeId,
        reporterId: actor.userId,
        clientIncidentId: request.clientIncidentId,
        conversationId: conversation.id,
        category: request.category,
        description: request.description || null,
        maxLevel: chain.length,
        ackTimeoutSeconds: store.ackTimeoutSeconds,
        ackDeadlineAt: new Date(now.getTime() + store.ackTimeoutSeconds * 1000),
      },
      select: { id: true, businessId: true, conversationId: true, reporterId: true },
    });
    await tx.emergencyIncidentRecipient.createMany({
      data: chain.flatMap((level) =>
        level.userIds.map((userId) => ({
          incidentId: incident.id,
          userId,
          level: level.level,
          source: level.source,
        })),
      ),
    });
    await tx.emergencyIncidentEvent.create({
      data: { incidentId: incident.id, type: 'CREATED', actorId: actor.userId, userIds: [] },
    });

    const events: PendingOutboxEvent[] = [];
    const raised = await this.writer.createSystem(tx, conversation, actor.userId, {
      type: 'emergency_raised',
      actorId: actor.userId,
      category: request.category,
      storeName: store.name,
    });
    events.push(raised.event);
    if (request.description) {
      const message = await this.writer.create(tx, {
        conversationId: conversation.id,
        businessId: conversation.businessId,
        senderId: actor.userId,
        clientMessageId: request.clientIncidentId,
        kind: 'TEXT',
        body: request.description,
      });
      events.push(message.event);
    }
    const first = chain[0]!;
    events.push(...(await this.escalation.alertLevelTx(tx, incident, 1, first.userIds, now)));
    events.push(
      await this.outbox.add(tx, 'emergency.updated', { incidentId: incident.id }, store.businessId),
      await this.outbox.add(
        tx,
        'conversation.updated',
        { conversationId: conversation.id },
        store.businessId,
      ),
    );
    await this.audit.record(
      actor,
      {
        action: 'emergency.incident.created',
        businessId: store.businessId,
        storeId: store.storeId,
        targetType: 'EmergencyIncident',
        targetId: incident.id,
        metadata: {
          category: request.category,
          levels: chain.length,
          alerted: first.userIds.length,
          source: first.source,
        },
      },
      tx,
    );
    return { id: incident.id, events };
  }

  private async appendDescription(
    actor: Actor,
    incident: { businessId: string; conversationId: string },
    request: CreateIncidentRequest,
  ): Promise<void> {
    try {
      const event = await this.prisma.$transaction(async (tx) => {
        const message = await this.writer.create(tx, {
          conversationId: incident.conversationId,
          businessId: incident.businessId,
          senderId: actor.userId,
          clientMessageId: request.clientIncidentId,
          kind: 'TEXT',
          body: request.description!,
        });
        return message.event;
      });
      await this.outbox.dispatch([event]);
    } catch (error) {
      // Same clientIncidentId already appended: the retry is a no-op.
      if (!isUniqueViolation(error)) throw error;
    }
  }

  async list(actor: Actor, query: ListIncidentsQuery): Promise<Page<IncidentListItemDto>> {
    // Platform-wide coverage is deliberately ignored: incidents are tenant data, visible
    // only to people in the business/store (the platform role has no implicit content access).
    const coverage = await this.authz.coverage(actor, 'incident.read');
    const visibility: Prisma.EmergencyIncidentWhereInput[] = [
      { reporterId: actor.userId },
      { recipients: { some: { userId: actor.userId, state: { notIn: NOT_ALERTED } } } },
    ];
    if (!coverage.all) {
      if (coverage.businessIds.size > 0)
        visibility.push({ businessId: { in: [...coverage.businessIds] } });
      if (coverage.stores.size > 0)
        visibility.push({ storeId: { in: [...coverage.stores.keys()] } });
    }
    const rows = await this.prisma.emergencyIncident.findMany({
      where: {
        OR: visibility,
        business: { status: 'ACTIVE' },
        ...(query.active ? { status: { in: [...ACTIVE_STATUSES] } } : {}),
        ...(query.storeId ? { storeId: query.storeId } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      take: query.limit + 1,
      include: incidentInclude,
    });
    const page = rows.slice(0, query.limit);
    const ids = page.map((r) => r.id);
    const [mine, memberships] = await Promise.all([
      this.prisma.emergencyIncidentRecipient.findMany({
        where: { userId: actor.userId, incidentId: { in: ids } },
        select: { incidentId: true, state: true },
      }),
      this.prisma.conversationMember.findMany({
        where: {
          userId: actor.userId,
          leftAt: null,
          conversationId: { in: page.map((r) => r.conversationId) },
        },
        select: { conversationId: true },
      }),
    ]);
    const stateOf = new Map(mine.map((r) => [r.incidentId, r.state]));
    const memberOf = new Set(memberships.map((m) => m.conversationId));
    const items: IncidentListItemDto[] = [];
    for (const row of page) {
      const me = await this.viewer(
        actor,
        row,
        stateOf.get(row.id) ?? null,
        memberOf.has(row.conversationId),
      );
      items.push({ ...toIncidentDto(row), me });
    }
    return { items, nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null };
  }

  async detail(actor: Actor, incidentId: string): Promise<IncidentDetailDto> {
    const row = await this.queries.incident(incidentId);
    const me = row ? await this.viewerFor(actor, row) : null;
    if (!row || !me) throw ApiError.notFound('Incident');
    const events = await this.prisma.emergencyIncidentEvent.findMany({
      where: { incidentId },
      orderBy: { seq: 'asc' },
      take: 200,
    });
    const userIds = [
      ...new Set(events.flatMap((e) => [...(e.actorId ? [e.actorId] : []), ...e.userIds])),
    ];
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: publicUserSelect,
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return {
      ...toIncidentDto(row),
      events: events.map((e) => toIncidentEventDto(e, byId)),
      me,
    };
  }

  async acknowledge(actor: Actor, incidentId: string): Promise<IncidentDetailDto> {
    const row = await this.requireResponder(actor, incidentId);
    const now = new Date();
    const events = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.emergencyIncident.updateMany({
        where: { id: incidentId, status: { in: [...AWAITING_ACK_STATUSES] } },
        data: {
          status: 'ACKNOWLEDGED',
          acknowledgedAt: now,
          acknowledgedById: actor.userId,
          ackDeadlineAt: null,
        },
      });
      if (count === 0) return null;
      await tx.emergencyIncidentRecipient.upsert({
        where: { incidentId_userId: { incidentId, userId: actor.userId } },
        create: {
          incidentId,
          userId: actor.userId,
          level: row.level,
          source: 'RESPONDER',
          state: 'ACKNOWLEDGED',
          acknowledgedAt: now,
        },
        update: { state: 'ACKNOWLEDGED', acknowledgedAt: now, failureReason: null },
      });
      return this.recordResponseTx(tx, actor, row, 'ACKNOWLEDGED', 'emergency_acknowledged');
    });
    if (events) {
      await this.outbox.dispatch(events);
      metrics.emergencyAckLatency.observe((now.getTime() - row.createdAt.getTime()) / 1000);
    } else {
      // Lost a race or repeated: fine if it is acknowledged; closed incidents conflict.
      const current = await this.prisma.emergencyIncident.findUniqueOrThrow({
        where: { id: incidentId },
        select: { status: true },
      });
      if (current.status !== 'ACKNOWLEDGED')
        throw ApiError.conflict('This alert is already closed.');
    }
    return this.detail(actor, incidentId);
  }

  /** A responder (e.g. security on shift) joins the incident conversation without acknowledging. */
  async join(actor: Actor, incidentId: string): Promise<IncidentDetailDto> {
    const row = await this.requireResponder(actor, incidentId);
    if (!(ACTIVE_STATUSES as readonly string[]).includes(row.status))
      throw ApiError.conflict('This alert is already closed.');
    const events = await this.prisma.$transaction(async (tx) => {
      const added = await this.escalation.addMembersTx(
        tx,
        row.conversationId,
        [actor.userId],
        actor.userId,
      );
      if (added.length === 0) return null;
      const now = new Date();
      await tx.emergencyIncidentRecipient.upsert({
        where: { incidentId_userId: { incidentId, userId: actor.userId } },
        create: {
          incidentId,
          userId: actor.userId,
          level: row.level,
          source: 'RESPONDER',
          state: 'READ',
          readAt: now,
        },
        update: {},
      });
      return this.recordResponseTx(tx, actor, row, 'JOINED', 'emergency_joined');
    });
    if (events) await this.outbox.dispatch(events);
    return this.detail(actor, incidentId);
  }

  async resolve(actor: Actor, incidentId: string, note?: string): Promise<IncidentDetailDto> {
    const row = await this.requireResponder(actor, incidentId);
    const events = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.emergencyIncident.updateMany({
        where: { id: incidentId, status: { in: [...ACTIVE_STATUSES] } },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
          resolvedById: actor.userId,
          resolutionNote: note || null,
          ackDeadlineAt: null,
        },
      });
      if (count === 0) return null;
      return this.recordResponseTx(tx, actor, row, 'RESOLVED', 'emergency_resolved');
    });
    if (!events) {
      const current = await this.prisma.emergencyIncident.findUniqueOrThrow({
        where: { id: incidentId },
        select: { status: true },
      });
      if (current.status !== 'RESOLVED') throw ApiError.conflict('This alert is already closed.');
    } else {
      await this.outbox.dispatch(events);
    }
    return this.detail(actor, incidentId);
  }

  /** The reporter can withdraw an alert ("I'm safe") until someone acknowledges it. */
  async cancel(actor: Actor, incidentId: string): Promise<IncidentDetailDto> {
    const row = await this.queries.incident(incidentId);
    if (!row || !(await this.viewerFor(actor, row))) throw ApiError.notFound('Incident');
    if (row.reporterId !== actor.userId)
      throw ApiError.forbidden('Only the person who raised the alert can cancel it.');
    const events = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.emergencyIncident.updateMany({
        where: { id: incidentId, status: { in: [...AWAITING_ACK_STATUSES] } },
        data: { status: 'CANCELLED', cancelledAt: new Date(), ackDeadlineAt: null },
      });
      if (count === 0) return null;
      return this.recordResponseTx(tx, actor, row, 'CANCELLED', 'emergency_cancelled');
    });
    if (!events) {
      const current = await this.prisma.emergencyIncident.findUniqueOrThrow({
        where: { id: incidentId },
        select: { status: true },
      });
      if (current.status !== 'CANCELLED')
        throw ApiError.conflict(
          'Someone is already responding, so the alert can no longer be cancelled. Tell them in the conversation.',
        );
    } else {
      await this.outbox.dispatch(events);
    }
    return this.detail(actor, incidentId);
  }

  /** Device receipts from the alerted user. Monotonic; unknown or foreign ids are a silent no-op. */
  async receipt(actor: Actor, incidentId: string, state: 'DELIVERED' | 'READ'): Promise<void> {
    const target: AlertState = state === 'READ' ? 'READ' : 'DELIVERED_TO_DEVICE';
    const now = new Date();
    const where = {
      incidentId,
      userId: actor.userId,
      state: { in: statesBelow(target) },
    } satisfies Prisma.EmergencyIncidentRecipientWhereInput;
    const updated = await this.prisma.$transaction(async (tx) => {
      let changed = 0;
      if (target === 'READ') {
        changed += (
          await tx.emergencyIncidentRecipient.updateMany({
            where: { ...where, deliveredAt: null },
            data: { state: 'READ', deliveredAt: now, readAt: now, failureReason: null },
          })
        ).count;
        changed += (
          await tx.emergencyIncidentRecipient.updateMany({
            where,
            data: { state: 'READ', readAt: now, failureReason: null },
          })
        ).count;
      } else {
        changed += (
          await tx.emergencyIncidentRecipient.updateMany({
            where,
            data: { state: 'DELIVERED_TO_DEVICE', deliveredAt: now, failureReason: null },
          })
        ).count;
      }
      if (changed === 0) return null;
      const incident = await tx.emergencyIncident.findUniqueOrThrow({
        where: { id: incidentId },
        select: { businessId: true },
      });
      return this.outbox.add(tx, 'emergency.updated', { incidentId }, incident.businessId);
    });
    if (updated) await this.outbox.dispatch([updated]);
  }

  // ───────────────────────────── Settings ─────────────────────────────

  async getSettings(actor: Actor, storeId: string): Promise<EmergencySettingsDto> {
    const store = await this.requireSettingsAccess(actor, storeId);
    const [contacts, managers, admins] = await Promise.all([
      this.prisma.emergencyContact.findMany({
        where: { storeId },
        orderBy: { priority: 'asc' },
        select: { priority: true, user: { select: publicUserSelect } },
      }),
      this.prisma.roleAssignment.findMany({
        where: {
          revokedAt: null,
          scopeType: 'STORE',
          storeId,
          role: { key: 'STORE_MANAGER', isSystem: true },
        },
        select: { userId: true },
      }),
      this.queries.businessAdmins(this.prisma, store.businessId),
    ]);
    const eligible = await this.queries.eligibleAtStore(this.prisma, store, [
      ...contacts.map((c) => c.user.id),
      ...managers.map((m) => m.userId),
    ]);
    return {
      storeId,
      ackTimeoutSeconds: store.ackTimeoutSeconds,
      contacts: contacts.map((c) => ({
        priority: c.priority,
        user: toPublicUser(c.user),
        eligible: eligible.has(c.user.id),
      })),
      fallback: {
        storeManagers: new Set(managers.map((m) => m.userId).filter((id) => eligible.has(id))).size,
        businessAdmins: admins.length,
      },
    };
  }

  async updateSettings(
    actor: Actor,
    storeId: string,
    request: UpdateEmergencySettingsRequest,
  ): Promise<EmergencySettingsDto> {
    const store = await this.requireSettingsAccess(actor, storeId);
    const eligible = await this.queries.eligibleAtStore(this.prisma, store, request.contactUserIds);
    const index = request.contactUserIds.findIndex((id) => !eligible.has(id));
    if (index >= 0)
      throw ApiError.validation(
        'Emergency contacts must be active members of this store.',
        `contactUserIds.${index}`,
      );
    await this.prisma.$transaction(async (tx) => {
      await tx.store.update({
        where: { id: storeId },
        data: { emergencyAckTimeoutSeconds: request.ackTimeoutSeconds },
      });
      await tx.emergencyContact.deleteMany({ where: { storeId } });
      await tx.emergencyContact.createMany({
        data: request.contactUserIds.map((userId, i) => ({
          businessId: store.businessId,
          storeId,
          userId,
          priority: i + 1,
          createdById: actor.userId,
        })),
      });
      await this.audit.record(
        actor,
        {
          action: 'emergency.settings.updated',
          businessId: store.businessId,
          storeId,
          targetType: 'Store',
          targetId: storeId,
          metadata: {
            ackTimeoutSeconds: request.ackTimeoutSeconds,
            contactUserIds: request.contactUserIds,
          },
        },
        tx,
      );
    });
    return this.getSettings(actor, storeId);
  }

  // ───────────────────────────── Helpers ─────────────────────────────

  /**
   * Stores the person can raise an alert for: the stores they work at, plus every store of a
   * business where they hold a business-wide role with emergency.trigger (owners, admins).
   */
  private async activeStores(actor: Actor) {
    const coverage = await this.authz.coverage(actor, 'emergency.trigger');
    const businessWide = coverage.all ? [] : [...coverage.businessIds];
    const stores = await this.prisma.store.findMany({
      where: {
        status: 'ACTIVE',
        business: { status: 'ACTIVE' },
        OR: [
          { memberships: { some: { userId: actor.userId, status: 'ACTIVE' } } },
          ...(businessWide.length ? [{ businessId: { in: businessWide } }] : []),
        ],
      },
      select: {
        id: true,
        businessId: true,
        code: true,
        name: true,
        emergencyAckTimeoutSeconds: true,
      },
      orderBy: { name: 'asc' },
    });
    return stores.map((store) => ({
      businessId: store.businessId,
      storeId: store.id,
      code: store.code,
      name: store.name,
      ackTimeoutSeconds: store.emergencyAckTimeoutSeconds,
    }));
  }

  /** The store comes from the caller's own stores and roles, never from free client input. */
  private async resolveStore(actor: Actor, storeId?: string): Promise<ResolvedStore> {
    const stores = await this.activeStores(actor);
    if (storeId) {
      const store = stores.find((s) => s.storeId === storeId);
      if (!store) throw ApiError.notFound('Store');
      return store;
    }
    if (stores.length === 0)
      throw ApiError.conflict(
        'You are not assigned to a store, so there is no store team to alert. Call your local emergency number if you are in danger.',
      );
    if (stores.length > 1) throw ApiError.validation('Choose the store you are at.', 'storeId');
    return stores[0]!;
  }

  private async viewerFor(actor: Actor, row: IncidentRow): Promise<IncidentViewerDto | null> {
    const [recipient, member] = await Promise.all([
      this.prisma.emergencyIncidentRecipient.findUnique({
        where: { incidentId_userId: { incidentId: row.id, userId: actor.userId } },
        select: { state: true },
      }),
      this.prisma.conversationMember.findFirst({
        where: { conversationId: row.conversationId, userId: actor.userId, leftAt: null },
        select: { id: true },
      }),
    ]);
    const me = await this.viewer(actor, row, recipient?.state ?? null, !!member);
    const visible =
      me.isReporter ||
      (me.alertState !== null && !NOT_ALERTED.includes(me.alertState)) ||
      (await this.authz.can(actor, 'incident.read', row));
    return visible ? me : null;
  }

  private async viewer(
    actor: Actor,
    row: IncidentRow,
    alertState: AlertState | null,
    isConversationMember: boolean,
  ): Promise<IncidentViewerDto> {
    const isReporter = row.reporterId === actor.userId;
    const alerted = alertState !== null && !NOT_ALERTED.includes(alertState);
    const active = (ACTIVE_STATUSES as readonly string[]).includes(row.status);
    const canRespond =
      !isReporter &&
      active &&
      (alerted || (await this.authz.can(actor, 'incident.acknowledge', row)));
    return {
      isReporter,
      alertState,
      isConversationMember,
      canRespond,
      canCancel: isReporter && (AWAITING_ACK_STATUSES as readonly string[]).includes(row.status),
    };
  }

  /** Alerted users and incident.acknowledge holders for the store may respond (not the reporter). */
  private async requireResponder(actor: Actor, incidentId: string): Promise<IncidentRow> {
    const row = await this.queries.incident(incidentId);
    const me = row ? await this.viewerFor(actor, row) : null;
    if (!row || !me) throw ApiError.notFound('Incident');
    if (me.isReporter)
      throw ApiError.forbidden('You raised this alert; a responder must answer it.');
    const alerted = me.alertState !== null && !NOT_ALERTED.includes(me.alertState);
    if (!alerted && !(await this.authz.can(actor, 'incident.acknowledge', row)))
      throw ApiError.forbidden('You are not a responder for this alert.');
    return row;
  }

  /** Shared tail of acknowledge/join/resolve/cancel: membership, system message, timeline, audit, events. */
  private async recordResponseTx(
    tx: Tx,
    actor: Actor,
    row: IncidentRow,
    type: 'ACKNOWLEDGED' | 'JOINED' | 'RESOLVED' | 'CANCELLED',
    systemType:
      'emergency_acknowledged' | 'emergency_joined' | 'emergency_resolved' | 'emergency_cancelled',
  ): Promise<PendingOutboxEvent[]> {
    if (type === 'ACKNOWLEDGED')
      await this.escalation.addMembersTx(tx, row.conversationId, [actor.userId], actor.userId);
    await tx.emergencyIncidentEvent.create({
      data: { incidentId: row.id, type, actorId: actor.userId, level: row.level, userIds: [] },
    });
    const system = await this.writer.createSystem(
      tx,
      { id: row.conversationId, businessId: row.businessId },
      actor.userId,
      { type: systemType, actorId: actor.userId },
    );
    await this.audit.record(
      actor,
      {
        action: `emergency.incident.${type.toLowerCase()}`,
        businessId: row.businessId,
        storeId: row.storeId,
        targetType: 'EmergencyIncident',
        targetId: row.id,
        metadata: { level: row.level },
      },
      tx,
    );
    return [
      system.event,
      await this.outbox.add(tx, 'emergency.updated', { incidentId: row.id }, row.businessId),
      await this.outbox.add(
        tx,
        'conversation.updated',
        { conversationId: row.conversationId },
        row.businessId,
      ),
    ];
  }

  private async requireSettingsAccess(
    actor: Actor,
    storeId: string,
  ): Promise<StoreRef & { ackTimeoutSeconds: number }> {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, businessId: true, status: true, emergencyAckTimeoutSeconds: true },
    });
    if (!store) throw ApiError.notFound('Store');
    const scope = { businessId: store.businessId, storeId };
    // Hide stores outside the caller's tenant entirely.
    if (!(await this.authz.can(actor, 'store.read', scope))) throw ApiError.notFound('Store');
    await this.authz.require(actor, 'emergency_contact.manage', scope);
    return { ...scope, ackTimeoutSeconds: store.emergencyAckTimeoutSeconds };
  }
}
