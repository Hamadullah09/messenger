import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { resolveBusinessPolicy, type DirectoryQuery, type PublicUserDto } from '@storeline/shared';
import { ApiError } from '../../infra/http/api-error';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RATE_LIMITS, RateLimiterService } from '../../infra/redis/rate-limiter.service';
import type { Actor } from '../auth/actor';
import { AuthorizationService } from '../authorization/authorization.service';
import { publicUserSelect, toPublicUser } from '../users/user.mapper';

/**
 * Who the actor may start a direct conversation with (docs D1): active internal members of
 * the same business who share a store with the actor — or anyone in the business when the
 * actor has business-wide directory access or the business allows cross-store messages.
 * External users are never listed.
 */
@Injectable()
export class DirectoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  async search(actor: Actor, query: DirectoryQuery): Promise<PublicUserDto[]> {
    await this.rateLimiter.consume(RATE_LIMITS.directoryPerUser, actor.userId);
    const where = await this.reachableWhere(actor, query.businessId);
    if (!where) throw ApiError.forbidden();
    const rows = await this.prisma.user.findMany({
      where: {
        AND: [
          where,
          { id: { not: actor.userId } },
          query.query
            ? {
                OR: [
                  { username: { contains: query.query.toLowerCase() } },
                  { displayName: { contains: query.query, mode: 'insensitive' } },
                ],
              }
            : {},
        ],
      },
      select: publicUserSelect,
      orderBy: { displayName: 'asc' },
      take: query.limit,
    });
    return rows.map(toPublicUser);
  }

  async canStartDirect(actor: Actor, businessId: string, userId: string): Promise<boolean> {
    const where = await this.reachableWhere(actor, businessId);
    if (!where) return false;
    const match = await this.prisma.user.count({ where: { AND: [where, { id: userId }] } });
    return match === 1;
  }

  /** Which of these people the actor may message directly in the business. */
  async reachableIds(actor: Actor, businessId: string, userIds: string[]): Promise<Set<string>> {
    const where = await this.reachableWhere(actor, businessId);
    if (!where || userIds.length === 0) return new Set();
    const rows = await this.prisma.user.findMany({
      where: { AND: [where, { id: { in: userIds } }] },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  /** Prisma filter for users reachable by the actor in a business, or null if none are. */
  private async reachableWhere(
    actor: Actor,
    businessId: string,
  ): Promise<Prisma.UserWhereInput | null> {
    if (actor.kind !== 'INTERNAL') return null;
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { status: true, policy: true },
    });
    if (!business || business.status !== 'ACTIVE') return null;

    const dm = await this.authz.coverage(actor, 'conversation.direct.create');
    const canDmInBusiness =
      dm.all || dm.businessIds.has(businessId) || [...dm.stores.values()].includes(businessId);
    if (!canDmInBusiness) return null;

    const base: Prisma.UserWhereInput = {
      status: 'ACTIVE',
      kind: 'INTERNAL',
      businessMemberships: { some: { businessId, status: 'ACTIVE' } },
    };
    const wholeBusiness =
      resolveBusinessPolicy(business.policy).directMessagesAcrossStores ||
      (await this.authz.can(actor, 'user.read', { businessId }));
    if (wholeBusiness) return base;

    const myStores = await this.prisma.storeMembership.findMany({
      where: { userId: actor.userId, businessId, status: 'ACTIVE', store: { status: 'ACTIVE' } },
      select: { storeId: true },
    });
    if (myStores.length === 0) return null;
    return {
      ...base,
      OR: [
        {
          storeMemberships: {
            some: { storeId: { in: myStores.map((s) => s.storeId) }, status: 'ACTIVE' },
          },
        },
        // Business-level staff (e.g. Business Admins) are reachable from every store.
        { roleAssignments: { some: { businessId, scopeType: 'BUSINESS', revokedAt: null } } },
      ],
    };
  }
}
