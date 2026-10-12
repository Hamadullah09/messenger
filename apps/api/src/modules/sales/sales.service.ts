import { Injectable } from '@nestjs/common';
import { Prisma, type LeadStage } from '@prisma/client';
import {
  DEFAULT_BUSINESS_POLICY,
  LEAD_SOURCES,
  LEAD_STAGES,
  OPEN_LEAD_STAGES,
  OUTBOUND_SOURCES,
  STUCK_AFTER_DAYS_IDLE,
  STUCK_AFTER_DAYS_IN_STAGE,
  type AddLeadActivityRequest,
  type ChangeLeadStageRequest,
  type ConvertLeadRequest,
  type CreateLeadRequest,
  type CreateSalesUserRequest,
  type LeadDetailDto,
  type LeadDto,
  type ListLeadsQuery,
  type Permission,
  type PublicLeadRequest,
  type SalesContextDto,
  type SalesOverviewDto,
  type SalesUserDto,
  type UpdateLeadRequest,
} from '@storeline/shared';
import { ApiError } from '../../infra/http/api-error';
import { isUniqueViolation, PrismaService } from '../../infra/prisma/prisma.service';
import { RATE_LIMITS, RateLimiterService } from '../../infra/redis/rate-limiter.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import type { ClientContext } from '../auth/auth.service';
import { PasswordService } from '../auth/password.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { publicUserSelect, toPublicUser } from '../users/user.mapper';
import { UsersService } from '../users/users.service';

const TEAM_SLUG = 'sma-sales-team';
const TEAM_NAME = 'SMA Sales & Marketing';
const TEAM_GROUP_TITLE = 'Sales & Marketing team';

const leadInclude = {
  owner: { select: publicUserSelect },
  convertedBusiness: { select: { id: true, name: true } },
} as const satisfies Prisma.LeadInclude;

type LeadRow = Prisma.LeadGetPayload<{ include: typeof leadInclude }>;

const DAY = 86_400_000;

/** Open, and too long in its stage or without any activity. */
function isStuck(row: Pick<LeadRow, 'stage' | 'stageChangedAt' | 'lastActivityAt'>): boolean {
  if (!(OPEN_LEAD_STAGES as readonly string[]).includes(row.stage)) return false;
  const now = Date.now();
  return (
    now - row.stageChangedAt.getTime() > STUCK_AFTER_DAYS_IN_STAGE * DAY ||
    now - row.lastActivityAt.getTime() > STUCK_AFTER_DAYS_IDLE * DAY
  );
}

/** Prisma filter for stuck leads (same rule as isStuck). */
function stuckWhere(): Prisma.LeadWhereInput {
  const now = Date.now();
  return {
    stage: { in: [...OPEN_LEAD_STAGES] },
    OR: [
      { stageChangedAt: { lt: new Date(now - STUCK_AFTER_DAYS_IN_STAGE * DAY) } },
      { lastActivityAt: { lt: new Date(now - STUCK_AFTER_DAYS_IDLE * DAY) } },
    ],
  };
}

function toLeadDto(row: LeadRow): LeadDto {
  return {
    id: row.id,
    companyName: row.companyName,
    contactName: row.contactName,
    contactTitle: row.contactTitle,
    email: row.email,
    phone: row.phone,
    website: row.website,
    industry: row.industry,
    city: row.city,
    country: row.country,
    storeCount: row.storeCount,
    estimatedValue: row.estimatedValue,
    currency: row.currency,
    source: row.source,
    direction: row.direction,
    sourceDetail: row.sourceDetail,
    stage: row.stage,
    stageChangedAt: row.stageChangedAt.toISOString(),
    daysInStage: Math.floor((Date.now() - row.stageChangedAt.getTime()) / DAY),
    stuck: isStuck(row),
    callCount: row.callCount,
    messageCount: row.messageCount,
    meetingCount: row.meetingCount,
    lastOutcome: row.lastOutcome,
    lostReason: row.lostReason,
    notes: row.notes,
    owner: row.owner ? toPublicUser(row.owner) : null,
    nextFollowUpAt: row.nextFollowUpAt?.toISOString() ?? null,
    lastActivityAt: row.lastActivityAt.toISOString(),
    customer:
      row.convertedBusiness && row.convertedAt
        ? {
            businessId: row.convertedBusiness.id,
            businessName: row.convertedBusiness.name,
            convertedAt: row.convertedAt.toISOString(),
          }
        : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Sales & Marketing: SMA's own lead funnel (prospects that may buy SMA), from first contact to
 * an SMA customer business. Separate from the customers of a business (Store Customer role).
 * Rights come only from the Sales roles, which exist only in SMA's internal sales team.
 */
@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
    private readonly users: UsersService,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  // ───────────────────────────── Team and access ─────────────────────────────

  /** SMA's internal sales team (a hidden business holding the team's chats), created once. */
  async team(): Promise<{ businessId: string; groupId: string | null }> {
    let business = await this.prisma.business.findFirst({
      where: { internal: true, deletedAt: null },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!business) {
      business = await this.prisma.business.create({
        data: {
          name: TEAM_NAME,
          slug: TEAM_SLUG,
          internal: true,
          timeZone: 'Asia/Karachi',
          policy: DEFAULT_BUSINESS_POLICY,
          quota: { create: {} },
          conversations: { create: { type: 'GROUP', title: TEAM_GROUP_TITLE } },
        },
        select: { id: true },
      });
    }
    const group = await this.prisma.conversation.findFirst({
      where: { businessId: business.id, type: 'GROUP', title: TEAM_GROUP_TITLE },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    return { businessId: business.id, groupId: group?.id ?? null };
  }

  private async can(actor: Actor, permission: Permission, teamId?: string): Promise<boolean> {
    const businessId = teamId ?? (await this.team()).businessId;
    return this.authz.can(actor, permission, { businessId });
  }

  private async require(actor: Actor, permission: Permission): Promise<string> {
    const { businessId } = await this.team();
    await this.authz.require(actor, permission, { businessId });
    return businessId;
  }

  async context(actor: Actor): Promise<SalesContextDto> {
    const team = await this.team();
    await this.authz.require(actor, 'sales.access', { businessId: team.businessId });
    const [canSeeAll, canAssign, canConvert, canManageTeam] = await Promise.all([
      this.can(actor, 'sales.lead.read_all', team.businessId),
      this.can(actor, 'sales.lead.assign', team.businessId),
      this.can(actor, 'sales.lead.convert', team.businessId),
      this.can(actor, 'sales.team.manage', team.businessId),
    ]);
    return {
      teamBusinessId: team.businessId,
      teamGroupId: team.groupId,
      canSeeAll,
      canAssign,
      canConvert,
      canManageTeam,
    };
  }

  /** Agents see their own leads and the unassigned queue; managers see everything. */
  private async visibleWhere(actor: Actor): Promise<Prisma.LeadWhereInput> {
    await this.require(actor, 'sales.access');
    if (await this.can(actor, 'sales.lead.read_all')) return { deletedAt: null };
    return { deletedAt: null, OR: [{ ownerId: actor.userId }, { ownerId: null }] };
  }

  private async requireVisible(actor: Actor, leadId: string): Promise<LeadRow> {
    const row = await this.prisma.lead.findFirst({
      where: { AND: [{ id: leadId }, await this.visibleWhere(actor)] },
      include: leadInclude,
    });
    if (!row) throw ApiError.notFound('Lead');
    return row;
  }

  /** Editing a lead: managers any lead; agents only their own. */
  private async requireEditable(actor: Actor, leadId: string): Promise<LeadRow> {
    const row = await this.requireVisible(actor, leadId);
    await this.require(actor, 'sales.lead.manage');
    if (row.ownerId !== actor.userId && !(await this.can(actor, 'sales.lead.read_all')))
      throw ApiError.forbidden('Claim this lead first to work on it.');
    return row;
  }

  /** Sales users who can own leads. */
  private async requireSalesUser(userId: string): Promise<void> {
    const { businessId } = await this.team();
    const ok = await this.prisma.roleAssignment.count({
      where: {
        userId,
        businessId,
        revokedAt: null,
        role: { key: { in: ['SALES_MANAGER', 'SALES_AGENT'] }, isSystem: true },
        user: { status: 'ACTIVE', deletedAt: null },
      },
    });
    if (!ok) throw ApiError.validation('Choose someone from the sales team.', 'ownerId');
  }

  // ───────────────────────────── Leads ─────────────────────────────

  async list(actor: Actor, query: ListLeadsQuery): Promise<LeadDto[]> {
    const visible = await this.visibleWhere(actor);
    const q = query.q?.trim();
    const rows = await this.prisma.lead.findMany({
      where: {
        AND: [
          visible,
          query.stage ? { stage: query.stage } : {},
          query.source ? { source: query.source } : {},
          query.direction ? { direction: query.direction } : {},
          query.stuck === true ? stuckWhere() : {},
          query.open === true ? { stage: { in: [...OPEN_LEAD_STAGES] } } : {},
          query.open === false ? { stage: { in: ['WON', 'LOST'] } } : {},
          query.ownerId === 'me'
            ? { ownerId: actor.userId }
            : query.ownerId === 'unassigned'
              ? { ownerId: null }
              : query.ownerId
                ? { ownerId: query.ownerId }
                : {},
          q
            ? {
                OR: [
                  { companyName: { contains: q, mode: 'insensitive' } },
                  { contactName: { contains: q, mode: 'insensitive' } },
                  { email: { contains: q, mode: 'insensitive' } },
                  { phone: { contains: q } },
                  { city: { contains: q, mode: 'insensitive' } },
                ],
              }
            : {},
        ],
      },
      include: leadInclude,
      orderBy: [{ lastActivityAt: 'desc' }],
      take: query.limit,
    });
    return rows.map(toLeadDto);
  }

  async get(actor: Actor, leadId: string): Promise<LeadDetailDto> {
    const row = await this.requireVisible(actor, leadId);
    const activities = await this.prisma.leadActivity.findMany({
      where: { leadId },
      include: { actor: { select: publicUserSelect } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return {
      ...toLeadDto(row),
      activities: activities.map((a) => ({
        id: a.id,
        type: a.type,
        body: a.body,
        outcome: a.outcome,
        fromStage: a.fromStage,
        toStage: a.toStage,
        actor: a.actor ? toPublicUser(a.actor) : null,
        createdAt: a.createdAt.toISOString(),
      })),
    };
  }

  async create(actor: Actor, request: CreateLeadRequest): Promise<LeadDetailDto> {
    await this.require(actor, 'sales.lead.manage');
    // Agents' new leads are their own; managers may assign or leave them in the queue.
    let ownerId: string | null = actor.userId;
    if (request.ownerId !== undefined && request.ownerId !== actor.userId) {
      await this.require(actor, 'sales.lead.assign');
      if (request.ownerId) await this.requireSalesUser(request.ownerId);
      ownerId = request.ownerId;
    }
    const { ownerId: _ignored, direction, ...fields } = request;
    const lead = await this.prisma.$transaction(async (tx) => {
      const created = await tx.lead.create({
        data: {
          ...fields,
          direction:
            direction ?? (OUTBOUND_SOURCES.includes(request.source) ? 'OUTBOUND' : 'INBOUND'),
          ownerId,
          createdById: actor.userId,
        },
        select: { id: true },
      });
      await tx.leadActivity.create({
        data: { leadId: created.id, type: 'CREATED', actorId: actor.userId, toStage: 'NEW' },
      });
      return created;
    });
    return this.get(actor, lead.id);
  }

  async update(actor: Actor, leadId: string, request: UpdateLeadRequest): Promise<LeadDetailDto> {
    await this.requireEditable(actor, leadId);
    await this.prisma.lead.update({
      where: { id: leadId },
      data: { ...request, lastActivityAt: new Date() },
    });
    return this.get(actor, leadId);
  }

  async changeStage(
    actor: Actor,
    leadId: string,
    request: ChangeLeadStageRequest,
  ): Promise<LeadDetailDto> {
    const lead = await this.requireEditable(actor, leadId);
    if (lead.stage === request.stage) return this.get(actor, leadId);
    if (lead.convertedBusinessId && request.stage !== 'WON')
      throw ApiError.conflict('This lead is already an SMA customer.');
    const closed = request.stage === 'WON' || request.stage === 'LOST';
    await this.prisma.$transaction([
      this.prisma.lead.update({
        where: { id: leadId },
        data: {
          stage: request.stage,
          lostReason: request.stage === 'LOST' ? request.lostReason : null,
          closedAt: closed ? new Date() : null,
          stageChangedAt: new Date(),
          lastActivityAt: new Date(),
        },
      }),
      this.prisma.leadActivity.create({
        data: {
          leadId,
          type: 'STAGE_CHANGED',
          fromStage: lead.stage,
          toStage: request.stage,
          body: request.stage === 'LOST' ? request.lostReason : null,
          actorId: actor.userId,
        },
      }),
    ]);
    return this.get(actor, leadId);
  }

  async assign(actor: Actor, leadId: string, ownerId: string | null): Promise<LeadDetailDto> {
    const lead = await this.requireVisible(actor, leadId);
    await this.require(actor, 'sales.lead.assign');
    if (ownerId) await this.requireSalesUser(ownerId);
    if (lead.ownerId === ownerId) return this.get(actor, leadId);
    const owner = ownerId
      ? await this.prisma.user.findUnique({ where: { id: ownerId }, select: { displayName: true } })
      : null;
    await this.prisma.$transaction([
      this.prisma.lead.update({
        where: { id: leadId },
        data: { ownerId, lastActivityAt: new Date() },
      }),
      this.prisma.leadActivity.create({
        data: {
          leadId,
          type: 'ASSIGNED',
          body: owner ? `Assigned to ${owner.displayName}` : 'Moved to the unassigned queue',
          actorId: actor.userId,
        },
      }),
    ]);
    return this.get(actor, leadId);
  }

  /** An agent takes an unassigned lead. */
  async claim(actor: Actor, leadId: string): Promise<LeadDetailDto> {
    await this.requireVisible(actor, leadId);
    await this.require(actor, 'sales.lead.manage');
    const taken = await this.prisma.lead.updateMany({
      where: { id: leadId, ownerId: null },
      data: { ownerId: actor.userId, lastActivityAt: new Date() },
    });
    if (taken.count !== 1) throw ApiError.conflict('Someone else already took this lead.');
    await this.prisma.leadActivity.create({
      data: { leadId, type: 'ASSIGNED', body: 'Claimed the lead', actorId: actor.userId },
    });
    return this.get(actor, leadId);
  }

  async addActivity(
    actor: Actor,
    leadId: string,
    request: AddLeadActivityRequest,
  ): Promise<LeadDetailDto> {
    await this.requireEditable(actor, leadId);
    await this.prisma.$transaction([
      this.prisma.leadActivity.create({
        data: {
          leadId,
          type: request.type,
          body: request.body,
          outcome: request.outcome ?? null,
          actorId: actor.userId,
        },
      }),
      this.prisma.lead.update({
        where: { id: leadId },
        data: {
          lastActivityAt: new Date(),
          ...(request.type === 'CALL' ? { callCount: { increment: 1 } } : {}),
          ...(request.type === 'EMAIL' || request.type === 'WHATSAPP'
            ? { messageCount: { increment: 1 } }
            : {}),
          ...(request.type === 'MEETING' ? { meetingCount: { increment: 1 } } : {}),
          ...(request.outcome ? { lastOutcome: request.outcome } : {}),
          ...(request.nextFollowUpAt !== undefined
            ? { nextFollowUpAt: request.nextFollowUpAt }
            : {}),
        },
      }),
    ]);
    return this.get(actor, leadId);
  }

  async remove(actor: Actor, leadId: string): Promise<void> {
    const lead = await this.requireVisible(actor, leadId);
    await this.require(actor, 'sales.lead.assign');
    await this.prisma.lead.update({ where: { id: leadId }, data: { deletedAt: new Date() } });
    await this.audit.record(actor, {
      action: 'sales.lead_deleted',
      targetType: 'Lead',
      targetId: leadId,
      metadata: { company: lead.companyName },
    });
  }

  /**
   * Won lead → SMA customer: creates the customer's business (and optionally its first
   * admin), marks the lead WON and links the two.
   */
  async convert(actor: Actor, leadId: string, request: ConvertLeadRequest): Promise<LeadDetailDto> {
    const lead = await this.requireVisible(actor, leadId);
    await this.require(actor, 'sales.lead.convert');
    if (lead.convertedBusinessId) throw ApiError.conflict('This lead is already an SMA customer.');
    const passwordHash = request.admin ? await this.passwords.hash(request.admin.password) : null;
    const roleId = request.admin
      ? (
          await this.prisma.role.findFirstOrThrow({
            where: { key: 'BUSINESS_ADMIN', businessId: null },
            select: { id: true },
          })
        ).id
      : null;
    try {
      await this.prisma.$transaction(async (tx) => {
        const business = await tx.business.create({
          data: {
            name: request.businessName,
            slug: request.slug,
            policy: DEFAULT_BUSINESS_POLICY,
            quota: { create: {} },
            email: lead.email,
            phone: lead.phone,
            website: lead.website,
            ...(lead.city || lead.country
              ? {
                  address: {
                    ...(lead.city ? { city: lead.city } : {}),
                    ...(lead.country ? { country: lead.country } : {}),
                  },
                }
              : {}),
          },
          select: { id: true },
        });
        if (request.admin && passwordHash && roleId) {
          const admin = await tx.user.create({
            data: {
              username: request.admin.username,
              displayName: request.admin.displayName,
              passwordHash,
              contact: { create: { email: request.admin.email } },
            },
            select: { id: true },
          });
          await tx.businessMembership.create({
            data: { businessId: business.id, userId: admin.id },
          });
          await tx.roleAssignment.create({
            data: {
              userId: admin.id,
              roleId,
              scopeType: 'BUSINESS',
              businessId: business.id,
              grantedById: actor.userId,
            },
          });
        }
        await tx.lead.update({
          where: { id: leadId },
          data: {
            stage: 'WON',
            closedAt: lead.closedAt ?? new Date(),
            convertedBusinessId: business.id,
            convertedAt: new Date(),
            ...(lead.stage === 'WON' ? {} : { stageChangedAt: new Date() }),
            lastActivityAt: new Date(),
          },
        });
        // Deals and invoices of the lead now belong to the new customer.
        await tx.deal.updateMany({
          where: { leadId, businessId: null },
          data: { businessId: business.id },
        });
        await tx.invoice.updateMany({
          where: { leadId, businessId: null },
          data: { businessId: business.id },
        });
        await tx.leadActivity.create({
          data: {
            leadId,
            type: 'CONVERTED',
            fromStage: lead.stage,
            toStage: 'WON',
            body: `Became the SMA customer “${request.businessName}”`,
            actorId: actor.userId,
          },
        });
        await this.audit.record(
          actor,
          {
            action: 'sales.lead_converted',
            businessId: business.id,
            targetType: 'Lead',
            targetId: leadId,
            metadata: { slug: request.slug, withAdmin: Boolean(request.admin) },
          },
          tx,
        );
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const target = String((error.meta as { target?: unknown } | undefined)?.target ?? '');
        throw ApiError.conflict(
          target.includes('slug')
            ? 'A business with this short name already exists.'
            : target.includes('email')
              ? 'This email address is already in use.'
              : 'This username is already taken.',
        );
      }
      throw error;
    }
    return this.get(actor, leadId);
  }

  /** Leads (or only SMA customers) as CSV for campaigns and reports. Managers only. */
  async exportCsv(actor: Actor, customersOnly: boolean): Promise<string> {
    await this.require(actor, 'sales.lead.read_all');
    const rows = await this.prisma.lead.findMany({
      where: { deletedAt: null, ...(customersOnly ? { stage: 'WON' } : {}) },
      include: leadInclude,
      orderBy: { createdAt: 'asc' },
      take: 50_000,
    });
    await this.audit.record(actor, {
      action: 'sales.leads_exported',
      metadata: { count: rows.length, customersOnly },
    });
    const header = [
      'Company',
      'Contact',
      'Title',
      'Phone',
      'Email',
      'City',
      'Country',
      'Stores',
      'Stage',
      'Direction',
      'Source',
      'Source details',
      'Owner',
      'Monthly value',
      'Currency',
      'Calls',
      'Messages',
      'Meetings',
      'SMA customer business',
      'Created',
    ];
    const lines = rows.map((r) =>
      [
        r.companyName,
        r.contactName,
        r.contactTitle,
        r.phone,
        r.email,
        r.city,
        r.country,
        r.storeCount,
        r.stage,
        r.direction,
        r.source,
        r.sourceDetail,
        r.owner?.displayName,
        r.estimatedValue,
        r.currency,
        r.callCount,
        r.messageCount,
        r.meetingCount,
        r.convertedBusiness?.name,
        r.createdAt.toISOString(),
      ]
        .map(csvCell)
        .join(','),
    );
    return [header.map(csvCell).join(','), ...lines].join('\r\n');
  }

  // ───────────────────────────── Reports ─────────────────────────────

  async overview(actor: Actor): Promise<SalesOverviewDto> {
    const visible = await this.visibleWhere(actor);
    const rows = await this.prisma.lead.findMany({
      where: visible,
      select: {
        stage: true,
        source: true,
        direction: true,
        stageChangedAt: true,
        lastActivityAt: true,
        callCount: true,
        messageCount: true,
        estimatedValue: true,
        closedAt: true,
        nextFollowUpAt: true,
        createdAt: true,
        owner: { select: publicUserSelect },
      },
      take: 20_000,
    });
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
    const byStage = Object.fromEntries(LEAD_STAGES.map((s) => [s, 0])) as Record<LeadStage, number>;
    const bySource = new Map(LEAD_SOURCES.map((s) => [s, { source: s, total: 0, won: 0 }]));
    const byOwner = new Map<string, SalesOverviewDto['byOwner'][number]>();
    let openValue = 0;
    let wonThisMonth = 0;
    let wonValueThisMonth = 0;
    let followUpsDue = 0;
    let newThisWeek = 0;
    let stuck = 0;
    let callsLogged = 0;
    let messagesLogged = 0;
    const byDirection = { INBOUND: { total: 0, won: 0 }, OUTBOUND: { total: 0, won: 0 } };
    for (const r of rows) {
      byStage[r.stage] += 1;
      byDirection[r.direction].total += 1;
      if (r.stage === 'WON') byDirection[r.direction].won += 1;
      if (isStuck(r)) stuck += 1;
      callsLogged += r.callCount;
      messagesLogged += r.messageCount;
      const src = bySource.get(r.source)!;
      src.total += 1;
      if (r.stage === 'WON') src.won += 1;
      const key = r.owner?.id ?? 'unassigned';
      const owner = byOwner.get(key) ?? {
        owner: r.owner ? toPublicUser(r.owner) : null,
        open: 0,
        won: 0,
        lost: 0,
      };
      const open = (OPEN_LEAD_STAGES as readonly string[]).includes(r.stage);
      if (open) owner.open += 1;
      else if (r.stage === 'WON') owner.won += 1;
      else owner.lost += 1;
      byOwner.set(key, owner);
      if (open) {
        openValue += r.estimatedValue ?? 0;
        if (r.nextFollowUpAt && r.nextFollowUpAt <= now) followUpsDue += 1;
      }
      if (r.stage === 'WON' && r.closedAt && r.closedAt >= monthStart) {
        wonThisMonth += 1;
        wonValueThisMonth += r.estimatedValue ?? 0;
      }
      if (r.createdAt >= weekAgo) newThisWeek += 1;
    }
    const closed = byStage.WON + byStage.LOST;
    return {
      byStage,
      bySource: [...bySource.values()].filter((s) => s.total > 0),
      byOwner: [...byOwner.values()].sort((a, b) => b.open + b.won - (a.open + a.won)),
      openPipelineValue: openValue,
      wonThisMonth,
      wonValueThisMonth,
      winRate: closed > 0 ? byStage.WON / closed : null,
      followUpsDue,
      newThisWeek,
      stuck,
      byDirection,
      callsLogged,
      messagesLogged,
    };
  }

  // ───────────────────────────── Team ─────────────────────────────

  async teamMembers(actor: Actor): Promise<SalesUserDto[]> {
    const { businessId } = await this.team();
    await this.authz.require(actor, 'sales.access', { businessId });
    const assignments = await this.prisma.roleAssignment.findMany({
      where: {
        businessId,
        revokedAt: null,
        role: { key: { in: ['SALES_MANAGER', 'SALES_AGENT'] }, isSystem: true },
        user: { deletedAt: null },
      },
      select: { role: { select: { key: true } }, user: { select: publicUserSelect } },
    });
    const counts = await this.prisma.lead.groupBy({
      by: ['ownerId', 'stage'],
      where: { deletedAt: null, ownerId: { in: assignments.map((a) => a.user.id) } },
      _count: { _all: true },
    });
    const people = new Map<string, SalesUserDto>();
    for (const a of assignments) {
      const existing = people.get(a.user.id);
      const roleKey = a.role.key as SalesUserDto['roleKey'];
      if (existing && existing.roleKey === 'SALES_MANAGER') continue;
      people.set(a.user.id, { ...toPublicUser(a.user), roleKey, openLeads: 0, wonLeads: 0 });
    }
    for (const c of counts) {
      const person = c.ownerId ? people.get(c.ownerId) : undefined;
      if (!person) continue;
      if (c.stage === 'WON') person.wonLeads += c._count._all;
      else if ((OPEN_LEAD_STAGES as readonly string[]).includes(c.stage))
        person.openLeads += c._count._all;
    }
    return [...people.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  /** Adds a Sales Manager or Sales Agent and puts them in the sales team chat. */
  async addTeamMember(actor: Actor, request: CreateSalesUserRequest): Promise<SalesUserDto[]> {
    const team = await this.team();
    await this.authz.require(actor, 'sales.team.manage', { businessId: team.businessId });
    const user = await this.users.create(actor, team.businessId, {
      username: request.username,
      displayName: request.displayName,
      initialPassword: request.password,
      kind: 'INTERNAL',
      storeIds: [],
      roleKey: request.roleKey,
      email: request.email,
      mustChangePassword: false,
    });
    if (team.groupId) {
      await this.prisma.$transaction(async (tx) => {
        const { lastSeq } = await tx.conversation.update({
          where: { id: team.groupId! },
          data: { memberCount: { increment: 1 } },
          select: { lastSeq: true },
        });
        await tx.conversationMember.create({
          data: {
            conversationId: team.groupId!,
            userId: user.id,
            role: request.roleKey === 'SALES_MANAGER' ? 'ADMIN' : 'MEMBER',
            historyFromSeq: lastSeq,
            lastReadSeq: lastSeq,
            lastDeliveredSeq: lastSeq,
            addedById: actor.userId,
          },
        });
      });
    }
    return this.teamMembers(actor);
  }

  // ───────────────────────────── Website ─────────────────────────────

  /** "Request a demo" on the website: lands in the unassigned queue as a WEBSITE lead. */
  async publicLead(request: PublicLeadRequest, client: ClientContext): Promise<void> {
    await this.rateLimiter.consume(RATE_LIMITS.publicLeadPerIp, client.ipHash);
    // Bots fill the hidden "website" field; accept silently and drop.
    if (request.website) return;
    const lead = await this.prisma.lead.create({
      data: {
        companyName: request.companyName,
        contactName: request.contactName,
        email: request.email,
        phone: request.phone ?? null,
        city: request.city ?? null,
        country: request.country ?? null,
        storeCount: request.storeCount ?? null,
        notes: request.message ?? null,
        source: 'WEBSITE',
        direction: 'INBOUND',
        sourceDetail: request.sourceDetail ?? 'Request a demo form',
      },
      select: { id: true },
    });
    await this.prisma.leadActivity.create({
      data: { leadId: lead.id, type: 'CREATED', toStage: 'NEW', body: 'From the website form' },
    });
  }
}

/** CSV cell, quoted; leading = + - @ are neutralised so spreadsheets never run them as formulas. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
