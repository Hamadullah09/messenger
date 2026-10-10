import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  canAssignRole,
  SYSTEM_ROLES,
  type AdminUserDto,
  type CreateUserRequest,
  type ListUsersQuery,
  type Page,
  type Scope,
  type UpdateUserContactRequest,
  type UpdateUserRequest,
  type UserContactDto,
} from '@storeline/shared';
import { ApiError } from '../../infra/http/api-error';
import { decodeCursor, encodeCursor } from '../../infra/http/cursor';
import { isUniqueViolation, PrismaService, type Tx } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { PasswordService } from '../auth/password.service';
import { SessionService } from '../auth/session.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { ConversationAccessService } from '../messaging/conversation-access.service';
import { OutboxService, type PendingOutboxEvent } from '../outbox/outbox.service';
import { publicUserSelect } from './user.mapper';

const isUsernameCursor = (v: Record<string, unknown>): v is { u: string } =>
  typeof v.u === 'string';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly outbox: OutboxService,
    private readonly access: ConversationAccessService,
  ) {}

  /** Users of a business visible to the actor: the whole business, or only members of their stores. */
  async list(actor: Actor, businessId: string, query: ListUsersQuery): Promise<Page<AdminUserDto>> {
    await this.requireBusiness(businessId);
    const coverage = await this.authz.coverage(actor, 'user.read');
    const wholeBusiness = coverage.all || coverage.businessIds.has(businessId);
    const storeIds = coverage.all
      ? []
      : [...coverage.stores].filter(([, b]) => b === businessId).map(([s]) => s);
    if (!wholeBusiness && storeIds.length === 0) throw ApiError.forbidden();
    if (query.storeId && !wholeBusiness && !storeIds.includes(query.storeId))
      throw ApiError.forbidden();

    const visibleStoreFilter = query.storeId ? [query.storeId] : wholeBusiness ? null : storeIds;
    const cursor = decodeCursor(query.cursor, isUsernameCursor);
    const where: Prisma.UserWhereInput = {
      businessMemberships: { some: { businessId, status: 'ACTIVE' } },
      ...(visibleStoreFilter
        ? { storeMemberships: { some: { storeId: { in: visibleStoreFilter }, status: 'ACTIVE' } } }
        : {}),
      // Store-level viewers only see internal staff; customers are visible to business-level admins.
      ...(wholeBusiness ? {} : { kind: 'INTERNAL' }),
      ...(query.status ? { status: query.status } : {}),
      ...(query.query
        ? {
            OR: [
              { username: { contains: query.query.toLowerCase() } },
              { displayName: { contains: query.query, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(cursor ? { username: { gt: cursor.u } } : {}),
    };
    const rows = await this.prisma.user.findMany({
      where,
      orderBy: { username: 'asc' },
      take: query.limit + 1,
      select: this.adminSelect(businessId),
    });
    const canManage = await this.authz.can(actor, 'user.update', { businessId });
    const items = rows.slice(0, query.limit).map((row) => this.toAdminDto(row, canManage));
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > query.limit && last ? encodeCursor({ u: last.username }) : null,
    };
  }

  async get(actor: Actor, businessId: string, userId: string): Promise<AdminUserDto> {
    const row = await this.prisma.user.findFirst({
      where: { id: userId, businessMemberships: { some: { businessId, status: 'ACTIVE' } } },
      select: this.adminSelect(businessId),
    });
    if (!row) throw ApiError.notFound('User');
    const storeIds = row.storeMemberships.map((m) => m.store.id);
    const visible =
      (await this.authz.can(actor, 'user.read', { businessId })) ||
      (row.kind === 'INTERNAL' &&
        (
          await Promise.all(
            storeIds.map((storeId) => this.authz.can(actor, 'user.read', { businessId, storeId })),
          )
        ).some(Boolean));
    if (!visible) throw ApiError.notFound('User');
    return this.toAdminDto(row, await this.authz.can(actor, 'user.update', { businessId }));
  }

  async create(
    actor: Actor,
    businessId: string,
    request: CreateUserRequest,
  ): Promise<AdminUserDto> {
    const business = await this.requireBusiness(businessId);
    await this.authz.require(actor, 'user.create', { businessId });
    if (business.status !== 'ACTIVE') throw ApiError.conflict('This business is not active.');

    const role = SYSTEM_ROLES[request.roleKey];
    if (request.kind === 'EXTERNAL' && request.roleKey !== 'CUSTOMER') {
      throw ApiError.validation('External users can only have the Customer role.', 'roleKey');
    }
    if (request.kind === 'INTERNAL' && request.roleKey === 'CUSTOMER') {
      throw ApiError.validation('The Customer role is for external users.', 'roleKey');
    }
    const storeScoped = role.allowedScopes.includes('STORE');
    if (storeScoped && request.storeIds.length === 0) {
      throw ApiError.validation('Choose at least one store for this role.', 'storeIds');
    }
    const stores = await this.loadStores(businessId, request.storeIds);

    // Granting the role at each target scope must not exceed the actor's own privileges.
    const ctx = await this.authz.context(actor);
    const targetScopes: Scope[] = storeScoped
      ? stores.map((s) => ({ type: 'STORE', businessId, storeId: s.id }))
      : [{ type: 'BUSINESS', businessId }];
    for (const scope of targetScopes) {
      const decision = canAssignRole(ctx, role, scope);
      if (!decision.allowed) {
        if (decision.reason === 'MFA_REQUIRED')
          throw new ApiError('MFA_REQUIRED', 'Turn on two-step verification first.');
        throw ApiError.forbidden('You cannot give this role.');
      }
    }

    const activeUsers = await this.prisma.businessMembership.count({
      where: { businessId, status: 'ACTIVE' },
    });
    if (business.quota && activeUsers >= business.quota.maxUsers) {
      throw ApiError.conflict(
        `This business has reached its limit of ${business.quota.maxUsers} users.`,
      );
    }

    const passwordHash = await this.passwords.hash(request.initialPassword);
    const roleRow = await this.prisma.role.findFirstOrThrow({
      where: { key: role.key, businessId: null },
      select: { id: true },
    });
    try {
      const userId = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            username: request.username,
            displayName: request.displayName,
            kind: request.kind,
            passwordHash,
            mustChangePassword: true,
            ...(request.email || request.phone
              ? {
                  contact: {
                    create: { email: request.email ?? null, phone: request.phone ?? null },
                  },
                }
              : {}),
          },
          select: { id: true },
        });
        await tx.businessMembership.create({ data: { businessId, userId: user.id } });
        if (stores.length > 0) {
          await tx.storeMembership.createMany({
            data: stores.map((s) => ({ businessId, storeId: s.id, userId: user.id })),
          });
        }
        await tx.roleAssignment.createMany({
          data: targetScopes.map((scope) => ({
            userId: user.id,
            roleId: roleRow.id,
            scopeType: scope.type,
            businessId,
            storeId: scope.type === 'STORE' ? scope.storeId : null,
            grantedById: actor.userId,
          })),
        });
        await this.audit.record(
          actor,
          {
            action: 'user.created',
            businessId,
            targetType: 'User',
            targetId: user.id,
            metadata: {
              username: request.username,
              kind: request.kind,
              role: role.key,
              storeIds: stores.map((s) => s.id),
              hasEmail: Boolean(request.email),
              hasPhone: Boolean(request.phone),
            },
          },
          tx,
        );
        return user.id;
      });
      return this.get(actor, businessId, userId);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const target = String((error.meta as { target?: unknown } | undefined)?.target ?? '');
        throw ApiError.conflict(
          target.includes('email')
            ? 'This email address is already in use.'
            : 'This username is already taken.',
        );
      }
      throw error;
    }
  }

  async update(
    actor: Actor,
    businessId: string,
    userId: string,
    request: UpdateUserRequest,
  ): Promise<AdminUserDto> {
    await this.requireMember(businessId, userId);
    await this.authz.require(actor, 'user.update', { businessId });
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { displayName: request.displayName } });
      await this.audit.record(
        actor,
        {
          action: 'user.updated',
          businessId,
          targetType: 'User',
          targetId: userId,
          metadata: { fields: Object.keys(request) },
        },
        tx,
      );
    });
    return this.get(actor, businessId, userId);
  }

  /**
   * Replaces the user's store memberships within one business. Leaving a store revokes the
   * store-scoped roles and removes the user from that store's conversations.
   */
  async setStores(
    actor: Actor,
    businessId: string,
    userId: string,
    storeIds: string[],
  ): Promise<AdminUserDto> {
    await this.requireMember(businessId, userId);
    await this.authz.require(actor, 'user.update', { businessId });
    const stores = await this.loadStores(businessId, storeIds);
    const wanted = new Set(stores.map((s) => s.id));

    const events = await this.prisma.$transaction(async (tx) => {
      const current = await tx.storeMembership.findMany({
        where: { businessId, userId },
        select: { id: true, storeId: true, status: true },
      });
      const removed = current
        .filter((m) => m.status === 'ACTIVE' && !wanted.has(m.storeId))
        .map((m) => m.storeId);
      const toActivate = [...wanted].filter(
        (id) => !current.some((m) => m.storeId === id && m.status === 'ACTIVE'),
      );

      for (const storeId of toActivate) {
        await tx.storeMembership.upsert({
          where: { storeId_userId: { storeId, userId } },
          create: { businessId, storeId, userId },
          update: { status: 'ACTIVE' },
        });
      }
      const pending: PendingOutboxEvent[] = [];
      if (removed.length > 0) {
        await tx.storeMembership.updateMany({
          where: { userId, storeId: { in: removed } },
          data: { status: 'REVOKED' },
        });
        await tx.roleAssignment.updateMany({
          where: { userId, storeId: { in: removed }, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        pending.push(
          ...(await this.access.removeUserFromConversationsTx(
            tx,
            userId,
            { businessId, storeId: { in: removed } },
            actor.userId,
          )),
        );
      }
      await this.audit.record(
        actor,
        {
          action: 'user.stores_changed',
          businessId,
          targetType: 'User',
          targetId: userId,
          metadata: { added: toActivate, removed },
        },
        tx,
      );
      return pending;
    });
    await this.outbox.dispatch(events);
    return this.get(actor, businessId, userId);
  }

  /** Removes a user from one business: memberships, roles and conversations of that business. */
  async removeFromBusiness(actor: Actor, businessId: string, userId: string): Promise<void> {
    await this.requireMember(businessId, userId);
    await this.authz.require(actor, 'user.deactivate', { businessId });
    if (userId === actor.userId) throw ApiError.conflict('You cannot remove yourself.');
    const events = await this.prisma.$transaction(async (tx) => {
      await tx.businessMembership.update({
        where: { businessId_userId: { businessId, userId } },
        data: { status: 'REVOKED' },
      });
      await tx.storeMembership.updateMany({
        where: { businessId, userId },
        data: { status: 'REVOKED' },
      });
      await tx.roleAssignment.updateMany({
        where: { businessId, userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const pending = await this.access.removeUserFromConversationsTx(
        tx,
        userId,
        { businessId },
        actor.userId,
      );
      const remaining = await tx.businessMembership.count({ where: { userId, status: 'ACTIVE' } });
      if (remaining === 0) {
        const revoked = await this.sessions.revokeAllForUserTx(tx, userId, 'removed_from_business');
        if (revoked) pending.push(revoked);
      }
      await this.audit.record(
        actor,
        { action: 'user.removed_from_business', businessId, targetType: 'User', targetId: userId },
        tx,
      );
      return pending;
    });
    await this.outbox.dispatch(events);
  }

  /** Account-wide deactivation requires authority over every business the user belongs to. */
  async setStatus(actor: Actor, userId: string, status: 'ACTIVE' | 'DEACTIVATED'): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        status: true,
        businessMemberships: { where: { status: 'ACTIVE' }, select: { businessId: true } },
      },
    });
    if (!user) throw ApiError.notFound('User');
    if (userId === actor.userId)
      throw ApiError.conflict('You cannot change your own account status.');
    const businessIds = user.businessMemberships.map((m) => m.businessId);
    if (businessIds.length === 0) {
      await this.authz.require(actor, 'user.deactivate', null);
    } else {
      for (const businessId of businessIds)
        await this.authz.require(actor, 'user.deactivate', { businessId });
    }
    const events = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { status } });
      const pending: PendingOutboxEvent[] = [];
      if (status === 'DEACTIVATED') {
        const revoked = await this.sessions.revokeAllForUserTx(tx, userId, 'account_deactivated');
        if (revoked) pending.push(revoked);
      }
      for (const businessId of businessIds.length ? businessIds : [null]) {
        await this.audit.record(
          actor,
          {
            action: status === 'ACTIVE' ? 'user.reactivated' : 'user.deactivated',
            businessId,
            targetType: 'User',
            targetId: userId,
          },
          tx,
        );
      }
      return pending;
    });
    await this.outbox.dispatch(events);
  }

  async revokeSessions(actor: Actor, businessId: string, userId: string): Promise<void> {
    await this.requireMember(businessId, userId);
    await this.authz.require(actor, 'session.revoke', { businessId });
    const event = await this.prisma.$transaction(async (tx) => {
      const revoked = await this.sessions.revokeAllForUserTx(tx, userId, 'revoked_by_admin');
      await this.audit.record(
        actor,
        { action: 'user.sessions_revoked', businessId, targetType: 'User', targetId: userId },
        tx,
      );
      return revoked;
    });
    if (event) await this.outbox.dispatch([event]);
  }

  /** Privileged and audited: the only API path that returns private contact details. */
  async getContact(actor: Actor, businessId: string, userId: string): Promise<UserContactDto> {
    await this.requireMember(businessId, userId);
    await this.authz.require(actor, 'user.contact.read', { businessId });
    const contact = await this.prisma.userContact.findUnique({ where: { userId } });
    await this.audit.record(actor, {
      action: 'user.contact_viewed',
      businessId,
      targetType: 'User',
      targetId: userId,
    });
    return {
      userId,
      email: contact?.email ?? null,
      emailVerifiedAt: contact?.emailVerifiedAt?.toISOString() ?? null,
      phone: contact?.phone ?? null,
      phoneVerifiedAt: contact?.phoneVerifiedAt?.toISOString() ?? null,
    };
  }

  async updateContact(
    actor: Actor,
    businessId: string,
    userId: string,
    request: UpdateUserContactRequest,
  ): Promise<UserContactDto> {
    await this.requireMember(businessId, userId);
    await this.authz.require(actor, 'user.update', { businessId });
    await this.authz.require(actor, 'user.contact.read', { businessId });
    const data: Prisma.UserContactUncheckedUpdateInput = {};
    if (request.email !== undefined)
      Object.assign(data, { email: request.email, emailVerifiedAt: null });
    if (request.phone !== undefined)
      Object.assign(data, { phone: request.phone, phoneVerifiedAt: null });
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.userContact.upsert({
          where: { userId },
          create: { userId, email: request.email ?? null, phone: request.phone ?? null },
          update: data,
        });
        await this.audit.record(
          actor,
          {
            action: 'user.contact_updated',
            businessId,
            targetType: 'User',
            targetId: userId,
            metadata: { fields: Object.keys(request) },
          },
          tx,
        );
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw ApiError.conflict('This email address is already in use.');
      throw error;
    }
    return this.getContact(actor, businessId, userId);
  }

  private adminSelect(businessId: string) {
    return {
      ...publicUserSelect,
      mustChangePassword: true,
      mfaEnabledAt: true,
      lastActiveAt: true,
      createdAt: true,
      storeMemberships: {
        where: { businessId, status: 'ACTIVE' },
        select: { store: { select: { id: true, name: true, code: true } } },
      },
      roleAssignments: {
        where: { revokedAt: null, OR: [{ businessId }, { scopeType: 'PLATFORM' }] },
        select: {
          id: true,
          scopeType: true,
          storeId: true,
          role: { select: { key: true, name: true } },
        },
      },
    } as const satisfies Prisma.UserSelect;
  }

  private toAdminDto(
    row: Prisma.UserGetPayload<{ select: ReturnType<UsersService['adminSelect']> }>,
    canManage: boolean,
  ): AdminUserDto {
    return {
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      kind: row.kind,
      status: row.status,
      mustChangePassword: canManage ? row.mustChangePassword : null,
      mfaEnabled: canManage ? row.mfaEnabledAt !== null : null,
      lastActiveAt: canManage ? (row.lastActiveAt?.toISOString() ?? null) : null,
      createdAt: row.createdAt.toISOString(),
      stores: row.storeMemberships.map((m) => m.store),
      roles: row.roleAssignments.map((a) => ({
        assignmentId: a.id,
        roleKey: a.role.key,
        roleName: a.role.name,
        scopeType: a.scopeType,
        storeId: a.storeId,
      })),
    };
  }

  private async requireBusiness(businessId: string) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { status: true, quota: { select: { maxUsers: true } } },
    });
    if (!business) throw ApiError.notFound('Business');
    return business;
  }

  private async requireMember(businessId: string, userId: string, tx?: Tx): Promise<void> {
    const membership = await (tx ?? this.prisma).businessMembership.findUnique({
      where: { businessId_userId: { businessId, userId } },
      select: { status: true },
    });
    if (!membership || membership.status !== 'ACTIVE') throw ApiError.notFound('User');
  }

  /** Validates that every id is an active store of this business (never trust client tenant ids). */
  private async loadStores(businessId: string, storeIds: string[]) {
    const unique = [...new Set(storeIds)];
    if (unique.length === 0) return [];
    const stores = await this.prisma.store.findMany({
      where: { id: { in: unique }, businessId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (stores.length !== unique.length)
      throw ApiError.validation('One or more stores were not found.', 'storeIds');
    return stores;
  }
}
