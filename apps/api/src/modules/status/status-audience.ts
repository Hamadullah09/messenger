import type { Prisma } from '@prisma/client';

/**
 * Who sees a status update: its author, and active members of its business, limited to the
 * store's people (plus business-level staff) when it was posted for one store. Expired and
 * removed posts are never visible. Platform admins get no implicit access.
 */
export function visibleStatusWhere(userId: string, now = new Date()): Prisma.StatusPostWhereInput {
  return {
    deletedAt: null,
    expiresAt: { gt: now },
    business: { status: 'ACTIVE', deletedAt: null },
    OR: [
      { authorId: userId },
      {
        business: { memberships: { some: { userId, status: 'ACTIVE' } } },
        OR: [
          { storeId: null },
          { store: { memberships: { some: { userId, status: 'ACTIVE' } } } },
          {
            business: {
              roleAssignments: { some: { userId, scopeType: 'BUSINESS', revokedAt: null } },
            },
          },
        ],
      },
    ],
  };
}

/** Everyone who may see a post in this business/store (for live "status.changed" events). */
export function statusAudienceUsersWhere(
  businessId: string,
  storeId: string | null,
): Prisma.UserWhereInput {
  return {
    status: 'ACTIVE',
    deletedAt: null,
    businessMemberships: { some: { businessId, status: 'ACTIVE' } },
    ...(storeId
      ? {
          OR: [
            { storeMemberships: { some: { storeId, status: 'ACTIVE' } } },
            {
              roleAssignments: { some: { businessId, scopeType: 'BUSINESS', revokedAt: null } },
            },
          ],
        }
      : {}),
  };
}
