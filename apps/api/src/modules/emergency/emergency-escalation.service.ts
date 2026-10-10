import { Injectable, Logger } from '@nestjs/common';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MessageWriter } from '../messaging/message-writer.service';
import { OutboxService, type PendingOutboxEvent } from '../outbox/outbox.service';
import { AWAITING_ACK_STATUSES } from './emergency.mapper';
import { EmergencyQueryService } from './emergency-query.service';
import { metrics } from '../../infra/metrics/metrics';

const SWEEP_BATCH = 100;

/**
 * Alerting and escalation (docs/architecture/emergency.md). The database is the source of
 * truth for deadlines: the worker sweeps `ackDeadlineAt <= now()` so escalation survives
 * Redis outages and worker restarts. Every transition is a conditional update on
 * (status, level) under a row lock, so duplicate or late sweeps are no-ops.
 */
@Injectable()
export class EmergencyEscalationService {
  private readonly logger = new Logger(EmergencyEscalationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly writer: MessageWriter,
    private readonly queries: EmergencyQueryService,
    private readonly audit: AuditService,
  ) {}

  /** Adds users to the emergency conversation with full history. Returns who was added. */
  async addMembersTx(
    tx: Tx,
    conversationId: string,
    userIds: string[],
    addedById: string,
  ): Promise<string[]> {
    if (userIds.length === 0) return [];
    const existing = await tx.conversationMember.findMany({
      where: { conversationId, userId: { in: userIds } },
      select: { userId: true, leftAt: true },
    });
    const active = new Set(existing.filter((m) => !m.leftAt).map((m) => m.userId));
    const toAdd = userIds.filter((id) => !active.has(id));
    for (const userId of toAdd) {
      // Responders need the whole conversation, including what happened before they joined.
      await tx.conversationMember.upsert({
        where: { conversationId_userId: { conversationId, userId } },
        create: { conversationId, userId, role: 'MEMBER', addedById, historyFromSeq: 0 },
        update: { leftAt: null, historyFromSeq: 0, joinedAt: new Date(), addedById },
      });
    }
    if (toAdd.length > 0) {
      await tx.conversation.update({
        where: { id: conversationId },
        data: { memberCount: { increment: toAdd.length } },
      });
    }
    return toAdd;
  }

  /**
   * Alerts one escalation level: QUEUED (never "delivered" — the worker and the device move
   * the state forward), adds them to the conversation, and records the outbox event.
   */
  async alertLevelTx(
    tx: Tx,
    incident: { id: string; businessId: string; conversationId: string; reporterId: string },
    level: number,
    userIds: string[],
    now: Date,
  ): Promise<PendingOutboxEvent[]> {
    await tx.emergencyIncidentRecipient.updateMany({
      where: { incidentId: incident.id, userId: { in: userIds }, state: 'PENDING' },
      data: { state: 'QUEUED', notifiedAt: now },
    });
    await this.addMembersTx(tx, incident.conversationId, userIds, incident.reporterId);
    await tx.emergencyIncidentEvent.create({
      data: { incidentId: incident.id, type: 'NOTIFIED', level, userIds },
    });
    return [
      await this.outbox.add(
        tx,
        'emergency.notify',
        { incidentId: incident.id, level, userIds },
        incident.businessId,
      ),
    ];
  }

  /** Escalates every incident whose acknowledgement deadline has passed. */
  async sweepOnce(now = new Date()): Promise<number> {
    const due = await this.prisma.emergencyIncident.findMany({
      where: { status: { in: [...AWAITING_ACK_STATUSES] }, ackDeadlineAt: { lte: now } },
      orderBy: { ackDeadlineAt: 'asc' },
      select: { id: true, level: true },
      take: SWEEP_BATCH,
    });
    let escalated = 0;
    for (const incident of due) {
      try {
        if (await this.escalate(incident.id, incident.level, now)) escalated += 1;
      } catch (error) {
        this.logger.error({ err: error, incidentId: incident.id }, 'Emergency escalation failed');
      }
    }
    return escalated;
  }

  /**
   * Moves an incident from `fromLevel` to the next level that still has an eligible person.
   * No-op (false) if it was acknowledged, closed, already escalated, or is locked by a
   * concurrent sweep.
   */
  async escalate(incidentId: string, fromLevel: number, now = new Date()): Promise<boolean> {
    const events = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "EmergencyIncident"
        WHERE id = ${incidentId}::uuid
          AND status IN ('OPEN', 'ESCALATED')
          AND level = ${fromLevel}
          AND "ackDeadlineAt" <= ${now}
        FOR UPDATE SKIP LOCKED`;
      if (locked.length === 0) return null;

      const incident = await tx.emergencyIncident.findUniqueOrThrow({
        where: { id: incidentId },
        select: {
          id: true,
          businessId: true,
          storeId: true,
          reporterId: true,
          conversationId: true,
          ackTimeoutSeconds: true,
        },
      });
      const pending = await tx.emergencyIncidentRecipient.findMany({
        where: { incidentId, state: 'PENDING', level: { gt: fromLevel } },
        orderBy: { level: 'asc' },
        select: { userId: true, level: true, source: true },
      });
      const eligible = await this.queries.stillEligible(tx, incident, pending);

      let next: { level: number; userIds: string[] } | null = null;
      for (const level of [...new Set(pending.map((p) => p.level))]) {
        const atLevel = pending.filter((p) => p.level === level);
        const skipped = atLevel.filter((p) => !eligible.has(p.userId)).map((p) => p.userId);
        if (skipped.length > 0) {
          await tx.emergencyIncidentRecipient.updateMany({
            where: { incidentId, userId: { in: skipped } },
            data: { state: 'SKIPPED', failureReason: 'no_longer_eligible' },
          });
          await tx.emergencyIncidentEvent.create({
            data: { incidentId, type: 'RECIPIENT_SKIPPED', level, userIds: skipped },
          });
        }
        const userIds = atLevel.filter((p) => eligible.has(p.userId)).map((p) => p.userId);
        if (userIds.length > 0) {
          next = { level, userIds };
          break;
        }
      }

      const out: PendingOutboxEvent[] = [];
      if (!next) {
        // Everyone in the chain has been alerted. Stop sweeping; the alert stays visible and
        // unacknowledged to everyone already alerted and to store watchers.
        await tx.emergencyIncident.update({
          where: { id: incidentId },
          data: { ackDeadlineAt: null, chainExhaustedAt: now },
        });
        await tx.emergencyIncidentEvent.create({
          data: { incidentId, type: 'CHAIN_EXHAUSTED', level: fromLevel, userIds: [] },
        });
        await this.audit.record(
          null,
          {
            action: 'emergency.incident.chain_exhausted',
            outcome: 'FAILURE',
            businessId: incident.businessId,
            storeId: incident.storeId,
            targetType: 'EmergencyIncident',
            targetId: incidentId,
            metadata: { level: fromLevel },
          },
          tx,
        );
        this.logger.error(
          { incidentId, level: fromLevel },
          'Emergency alert unacknowledged after the whole escalation chain',
        );
      } else {
        await tx.emergencyIncident.update({
          where: { id: incidentId },
          data: {
            status: 'ESCALATED',
            level: next.level,
            ackDeadlineAt: new Date(now.getTime() + incident.ackTimeoutSeconds * 1000),
          },
        });
        await tx.emergencyIncidentEvent.create({
          data: { incidentId, type: 'ESCALATED', level: next.level, userIds: next.userIds },
        });
        out.push(...(await this.alertLevelTx(tx, incident, next.level, next.userIds, now)));
        const system = await this.writer.createSystem(
          tx,
          { id: incident.conversationId, businessId: incident.businessId },
          incident.reporterId,
          {
            type: 'emergency_escalated',
            actorId: incident.reporterId,
            level: next.level,
            userIds: next.userIds,
          },
        );
        out.push(system.event);
        await this.audit.record(
          null,
          {
            action: 'emergency.incident.escalated',
            businessId: incident.businessId,
            storeId: incident.storeId,
            targetType: 'EmergencyIncident',
            targetId: incidentId,
            metadata: { fromLevel, toLevel: next.level, alerted: next.userIds.length },
          },
          tx,
        );
      }
      out.push(
        await this.outbox.add(tx, 'emergency.updated', { incidentId }, incident.businessId),
        await this.outbox.add(
          tx,
          'conversation.updated',
          { conversationId: incident.conversationId },
          incident.businessId,
        ),
      );
      return { out, exhausted: !next };
    });
    if (!events) return false;
    metrics.emergencyEscalations.inc({
      result: events.exhausted ? 'chain_exhausted' : 'escalated',
    });
    await this.outbox.dispatch(events.out);
    return true;
  }
}
