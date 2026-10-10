import type { Prisma } from '@prisma/client';
import type {
  AlertState,
  IncidentDto,
  IncidentEventDto,
  IncidentRecipientDto,
} from '@storeline/shared';
import { publicUserSelect, toPublicUser, type PublicUserRow } from '../users/user.mapper';

/**
 * Everything needed to render an incident. People are selected through publicUserSelect only,
 * so private contact data cannot reach a DTO (ADR-0006, docs/architecture/emergency.md).
 */
export const incidentInclude = {
  store: { select: { id: true, code: true, name: true } },
  reporter: { select: publicUserSelect },
  acknowledgedBy: { select: publicUserSelect },
  resolvedBy: { select: publicUserSelect },
  recipients: {
    where: { state: { not: 'PENDING' } },
    orderBy: [{ level: 'asc' }, { notifiedAt: 'asc' }],
    include: { user: { select: publicUserSelect } },
  },
} as const satisfies Prisma.EmergencyIncidentInclude;

export type IncidentRow = Prisma.EmergencyIncidentGetPayload<{ include: typeof incidentInclude }>;

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

export function toIncidentDto(row: IncidentRow): IncidentDto {
  return {
    id: row.id,
    businessId: row.businessId,
    store: row.store,
    conversationId: row.conversationId,
    reporter: toPublicUser(row.reporter),
    category: row.category,
    description: row.description,
    status: row.status,
    level: row.level,
    maxLevel: row.maxLevel,
    ackTimeoutSeconds: row.ackTimeoutSeconds,
    ackDeadlineAt: iso(row.ackDeadlineAt),
    chainExhaustedAt: iso(row.chainExhaustedAt),
    acknowledgedBy: row.acknowledgedBy ? toPublicUser(row.acknowledgedBy) : null,
    acknowledgedAt: iso(row.acknowledgedAt),
    resolvedBy: row.resolvedBy ? toPublicUser(row.resolvedBy) : null,
    resolvedAt: iso(row.resolvedAt),
    resolutionNote: row.resolutionNote,
    cancelledAt: iso(row.cancelledAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    recipients: row.recipients.map((r): IncidentRecipientDto => ({
      user: toPublicUser(r.user),
      level: r.level,
      source: r.source,
      state: r.state,
      notifiedAt: iso(r.notifiedAt),
      sentAt: iso(r.sentAt),
      deliveredAt: iso(r.deliveredAt),
      readAt: iso(r.readAt),
      acknowledgedAt: iso(r.acknowledgedAt),
      failedAt: iso(r.failedAt),
    })),
  };
}

export function toIncidentEventDto(
  row: {
    id: string;
    type: IncidentEventDto['type'];
    actorId: string | null;
    level: number | null;
    userIds: string[];
    createdAt: Date;
  },
  users: ReadonlyMap<string, PublicUserRow>,
): IncidentEventDto {
  const user = (id: string) => users.get(id);
  return {
    id: row.id,
    type: row.type,
    actor: row.actorId && user(row.actorId) ? toPublicUser(user(row.actorId)!) : null,
    level: row.level,
    users: row.userIds.flatMap((id) => {
      const u = user(id);
      return u ? [toPublicUser(u)] : [];
    }),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Delivery states ordered for monotonic updates; FAILED may be superseded by a later receipt. */
export const ALERT_STATE_RANK: Record<AlertState, number> = {
  PENDING: 0,
  SKIPPED: 0,
  FAILED: 1,
  QUEUED: 1,
  SENT_TO_GATEWAY: 2,
  DELIVERED_TO_DEVICE: 3,
  READ: 4,
  ACKNOWLEDGED: 5,
};

/** States that may be moved forward to `target` (never backwards, never out of PENDING/SKIPPED). */
export function statesBelow(target: AlertState): AlertState[] {
  const rank = ALERT_STATE_RANK[target];
  return (Object.keys(ALERT_STATE_RANK) as AlertState[]).filter(
    (s) => s !== 'PENDING' && s !== 'SKIPPED' && ALERT_STATE_RANK[s] < rank,
  );
}

export const ACTIVE_STATUSES = ['OPEN', 'ESCALATED', 'ACKNOWLEDGED'] as const;
export const AWAITING_ACK_STATUSES = ['OPEN', 'ESCALATED'] as const;
