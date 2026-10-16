import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  canAssignRole,
  EXPORT_ROLE_KEY,
  SALES_ROLE_KEYS,
  STORE_STAFF_ROLE_KEYS,
  SYSTEM_ROLES,
  type AdminSetPasswordRequest,
  type AdminUserDto,
  type AuthorizationContext,
  type CreateUserRequest,
  type Permission,
  type SetUserRoleRequest,
  type SystemRoleDefinition,
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
      deletedAt: null,
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
      where: {
        id: userId,
        deletedAt: null,
        businessMemberships: { some: { businessId, status: 'ACTIVE' } },
      },
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
    const role = SYSTEM_ROLES[request.roleKey];
    await this.requireRoleFitsBusiness(businessId, role.key);
    const storeScoped = role.allowedScopes.includes('STORE');
    // Business-wide user.create, or (store managers) user.create at every chosen store.
    const businessWide = await this.authz.can(actor, 'user.create', { businessId });
    if (!businessWide) {
      if (!storeScoped || request.storeIds.length === 0) {
        await this.authz.require(actor, 'user.create', { businessId });
      }
      if (!STORE_STAFF_ROLE_KEYS.includes(role.key)) {
        throw ApiError.forbidden('Store managers can add employees and security staff only.');
      }
      for (const storeId of request.storeIds)
        await this.authz.require(actor, 'user.create', { businessId, storeId });
    }
    if (business.status !== 'ACTIVE') throw ApiError.conflict('This business is not active.');

    if (request.kind === 'EXTERNAL' && request.roleKey !== 'CUSTOMER') {
      throw ApiError.validation('External users can only have the Customer role.', 'roleKey');
    }
    if (request.kind === 'INTERNAL' && request.roleKey === 'CUSTOMER') {
      throw ApiError.validation('The Customer role is for external users.', 'roleKey');
    }
    if (storeScoped && request.storeIds.length === 0) {
      throw ApiError.validation('Choose at least one store for this role.', 'storeIds');
    }
    const stores = await this.loadStores(businessId, request.storeIds);

    // Granting the role at each target scope must not exceed the actor's own privileges.
    const ctx = await this.authz.context(actor);
    const targetScopes = this.scopesFor(role, businessId, stores);
    this.requireCanGrant(ctx, role, targetScopes);

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
            mustChangePassword: request.mustChangePassword,
            contact: { create: { email: request.email, phone: request.phone ?? null } },
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
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: userId },
          data: { displayName: request.displayName, username: request.username },
        });
        await this.audit.record(
          actor,
          {
            action: 'user.updated',
            businessId,
            targetType: 'User',
            targetId: userId,
            metadata: { fields: Object.keys(request), username: request.username ?? null },
          },
          tx,
        );
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw ApiError.conflict('This username is already taken.');
      throw error;
    }
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
    const events = await this.prisma.$transaction((tx) =>
      this.syncStoresTx(tx, actor, businessId, userId, stores),
    );
    await this.outbox.dispatch(events);
    return this.get(actor, businessId, userId);
  }

  /**
   * Changes a person's role in one business: revokes their system roles there and grants the
   * new one (at the business, or at each chosen store). Needs authority over both roles.
   */
  async setRole(
    actor: Actor,
    businessId: string,
    userId: string,
    request: SetUserRoleRequest,
  ): Promise<AdminUserDto> {
    await this.requireMember(businessId, userId);
    await this.authz.require(actor, 'user.update', { businessId });
    if (userId === actor.userId) throw ApiError.conflict('You cannot change your own role.');
    const role = SYSTEM_ROLES[request.roleKey];
    await this.requireRoleFitsBusiness(businessId, role.key);
    const target = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { kind: true },
    });
    if (target.kind === 'EXTERNAL' && role.key !== 'CUSTOMER')
      throw ApiError.validation('External users can only have the Customer role.', 'roleKey');
    if (target.kind === 'INTERNAL' && role.key === 'CUSTOMER')
      throw ApiError.validation('The Customer role is for external users.', 'roleKey');
    const storeScoped = role.allowedScopes.includes('STORE');
    if (storeScoped && request.storeIds.length === 0)
      throw ApiError.validation('Choose at least one store for this role.', 'storeIds');
    const stores = await this.loadStores(businessId, request.storeIds);

    const ctx = await this.authz.context(actor);
    const targetScopes = this.scopesFor(role, businessId, stores);
    this.requireCanGrant(ctx, role, targetScopes);
    const current = await this.prisma.roleAssignment.findMany({
      where: { userId, businessId, revokedAt: null, role: { isSystem: true } },
      select: {
        id: true,
        scopeType: true,
        storeId: true,
        role: { select: { key: true } },
      },
    });
    // Taking a role away needs the same authority as giving it (no demoting a superior).
    for (const a of current) {
      const old = SYSTEM_ROLES[a.role.key as keyof typeof SYSTEM_ROLES];
      if (!old) continue;
      const scope: Scope =
        a.scopeType === 'STORE' && a.storeId
          ? { type: 'STORE', businessId, storeId: a.storeId }
          : { type: 'BUSINESS', businessId };
      this.requireCanGrant(ctx, old, [scope]);
    }
    const roleRow = await this.prisma.role.findFirstOrThrow({
      where: { key: role.key, businessId: null },
      select: { id: true },
    });

    const events = await this.prisma.$transaction(async (tx) => {
      const pending =
        storeScoped || stores.length > 0
          ? await this.syncStoresTx(tx, actor, businessId, userId, stores)
          : [];
      await tx.roleAssignment.updateMany({
        where: { id: { in: current.map((a) => a.id) }, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.roleAssignment.createMany({
        data: targetScopes.map((scope) => ({
          userId,
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
          action: 'user.role_changed',
          businessId,
          targetType: 'User',
          targetId: userId,
          metadata: {
            from: [...new Set(current.map((a) => a.role.key))],
            to: role.key,
            storeIds: stores.map((s) => s.id),
          },
        },
        tx,
      );
      return pending;
    });
    await this.outbox.dispatch(events);
    return this.get(actor, businessId, userId);
  }

  /**
   * Makes someone manager of one store (on) or stops it (off) without touching their other
   * stores, so one person can manage several stores. Stopping keeps them as an employee there.
   */
  async setStoreManager(
    actor: Actor,
    businessId: string,
    userId: string,
    storeId: string,
    on: boolean,
  ): Promise<AdminUserDto> {
    await this.requireMember(businessId, userId);
    await this.authz.require(actor, 'user.update', { businessId });
    const [store] = await this.loadStores(businessId, [storeId]);
    const target = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { kind: true, status: true },
    });
    if (target.kind !== 'INTERNAL' || target.status !== 'ACTIVE')
      throw ApiError.validation('Only active staff can manage a store.', 'userId');
    const ctx = await this.authz.context(actor);
    const scope: Scope = { type: 'STORE', businessId, storeId: store!.id };
    this.requireCanGrant(ctx, SYSTEM_ROLES.STORE_MANAGER, [scope]);
    const roleIds = Object.fromEntries(
      (
        await this.prisma.role.findMany({
          where: { businessId: null, key: { in: ['STORE_MANAGER', 'EMPLOYEE'] } },
          select: { id: true, key: true },
        })
      ).map((r) => [r.key, r.id]),
    ) as Record<'STORE_MANAGER' | 'EMPLOYEE', string>;

    await this.prisma.$transaction(async (tx) => {
      const active = await tx.roleAssignment.findMany({
        where: { userId, storeId, revokedAt: null },
        select: { id: true, role: { select: { key: true } } },
      });
      const managerRows = active.filter((a) => a.role.key === 'STORE_MANAGER');
      if (on) {
        await tx.storeMembership.upsert({
          where: { storeId_userId: { storeId, userId } },
          create: { businessId, storeId, userId },
          update: { status: 'ACTIVE' },
        });
        if (managerRows.length === 0) {
          await tx.roleAssignment.create({
            data: {
              userId,
              roleId: roleIds.STORE_MANAGER,
              scopeType: 'STORE',
              businessId,
              storeId,
              grantedById: actor.userId,
            },
          });
        }
      } else {
        await tx.roleAssignment.updateMany({
          where: { id: { in: managerRows.map((a) => a.id) } },
          data: { revokedAt: new Date() },
        });
        if (active.length === managerRows.length) {
          await tx.roleAssignment.create({
            data: {
              userId,
              roleId: roleIds.EMPLOYEE,
              scopeType: 'STORE',
              businessId,
              storeId,
              grantedById: actor.userId,
            },
          });
        }
      }
      await this.audit.record(
        actor,
        {
          action: on ? 'store.manager_assigned' : 'store.manager_removed',
          businessId,
          storeId,
          targetType: 'User',
          targetId: userId,
        },
        tx,
      );
    });
    return this.get(actor, businessId, userId);
  }

  /** Sets a new password for someone else (admins, or the store manager of their stores). */
  async setPassword(actor: Actor, userId: string, request: AdminSetPasswordRequest): Promise<void> {
    if (userId === actor.userId) throw ApiError.conflict('Change your own password in Settings.');
    const businessIds = await this.requireAuthorityOver(actor, 'user.update', userId);
    const passwordHash = await this.passwords.hash(request.newPassword);
    const event = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          passwordHash,
          mustChangePassword: request.mustChangePassword,
          passwordChangedAt: new Date(),
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      await tx.passwordResetToken.updateMany({
        where: { userId, usedAt: null },
        data: { usedAt: new Date() },
      });
      for (const businessId of businessIds.length ? businessIds : [null]) {
        await this.audit.record(
          actor,
          { action: 'user.password_set', businessId, targetType: 'User', targetId: userId },
          tx,
        );
      }
      return this.sessions.revokeAllForUserTx(tx, userId, 'password_set_by_admin');
    });
    if (event) await this.outbox.dispatch([event]);
  }

  /** Turns two-step verification off for someone who lost their phone. */
  async resetMfa(actor: Actor, userId: string): Promise<void> {
    if (userId === actor.userId)
      throw ApiError.conflict('Turn your own two-step verification off in Settings.');
    const businessIds = await this.requireAuthorityOver(actor, 'user.update', userId);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          mfaSecretEnc: null,
          mfaPendingSecretEnc: null,
          mfaEnabledAt: null,
          mfaLastUsedStep: null,
        },
      });
      for (const businessId of businessIds.length ? businessIds : [null]) {
        await this.audit.record(
          actor,
          { action: 'user.mfa_reset', businessId, targetType: 'User', targetId: userId },
          tx,
        );
      }
    });
  }

  /**
   * Authority over a person in every business they belong to: the permission business-wide,
   * or — for staff who only hold store roles — the permission at every one of their stores
   * (their store manager). Returns the person's business ids. Platform staff need platform scope.
   */
  private async requireAuthorityOver(
    actor: Actor,
    permission: Permission,
    userId: string,
  ): Promise<string[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        businessMemberships: { where: { status: 'ACTIVE' }, select: { businessId: true } },
        storeMemberships: {
          where: { status: 'ACTIVE' },
          select: { businessId: true, storeId: true },
        },
        roleAssignments: {
          where: { revokedAt: null },
          select: { scopeType: true, businessId: true, role: { select: { key: true } } },
        },
      },
    });
    if (!user) throw ApiError.notFound('User');
    const businessIds = user.businessMemberships.map((m) => m.businessId);
    if (businessIds.length === 0 || user.roleAssignments.some((a) => a.scopeType === 'PLATFORM')) {
      await this.authz.require(actor, permission, null);
      return businessIds;
    }
    for (const businessId of businessIds) {
      if (await this.authz.can(actor, permission, { businessId })) continue;
      const roles = user.roleAssignments.filter((a) => a.businessId === businessId);
      const staffOnly = roles.every(
        (a) =>
          a.scopeType === 'STORE' &&
          (STORE_STAFF_ROLE_KEYS as readonly string[]).includes(a.role.key),
      );
      const stores = user.storeMemberships.filter((m) => m.businessId === businessId);
      let covered = staffOnly && stores.length > 0;
      for (const m of stores) {
        if (!covered) break;
        covered = await this.authz.can(actor, permission, { businessId, storeId: m.storeId });
      }
      if (!covered) await this.authz.require(actor, permission, { businessId });
    }
    return businessIds;
  }

  private scopesFor(
    role: SystemRoleDefinition,
    businessId: string,
    stores: Array<{ id: string }>,
  ): Scope[] {
    return role.allowedScopes.includes('STORE')
      ? stores.map((s) => ({ type: 'STORE', businessId, storeId: s.id }))
      : [{ type: 'BUSINESS', businessId }];
  }

  /** Granting a role at each scope must not exceed the actor's own privileges. */
  private requireCanGrant(
    ctx: AuthorizationContext,
    role: SystemRoleDefinition,
    scopes: Scope[],
  ): void {
    for (const scope of scopes) {
      const decision = canAssignRole(ctx, role, scope);
      if (!decision.allowed) {
        if (decision.reason === 'MFA_REQUIRED')
          throw new ApiError('MFA_REQUIRED', 'Turn on two-step verification first.');
        throw ApiError.forbidden(`You cannot give the ${role.name} role.`);
      }
    }
  }

  /** Sets the person's active stores in one business (leaving a store ends its roles and chats). */
  private async syncStoresTx(
    tx: Tx,
    actor: Actor,
    businessId: string,
    userId: string,
    stores: Array<{ id: string }>,
  ): Promise<PendingOutboxEvent[]> {
    const wanted = new Set(stores.map((s) => s.id));
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

  /**
   * Deletes an account (admins and Super Admins): it is removed from every business, store,
   * role and chat, its email, phone and password are erased and its name becomes
   * "Deleted user". Messages it sent stay in the chats' history under that name.
   */
  async deleteUser(actor: Actor, userId: string): Promise<void> {
    if (userId === actor.userId) throw ApiError.conflict('You cannot delete your own account.');
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        deletedAt: true,
        businessMemberships: { where: { status: 'ACTIVE' }, select: { businessId: true } },
        roleAssignments: {
          where: { revokedAt: null, scopeType: 'PLATFORM' },
          select: { role: { select: { key: true } } },
        },
      },
    });
    if (!user || user.deletedAt) throw ApiError.notFound('User');
    const businessIds = user.businessMemberships.map((m) => m.businessId);
    const platformStaff = user.roleAssignments.length > 0;
    // Business-wide authority only (store managers deactivate, they do not delete).
    if (platformStaff || businessIds.length === 0) {
      await this.authz.require(actor, 'user.deactivate', null);
    } else {
      for (const businessId of businessIds)
        await this.authz.require(actor, 'user.deactivate', { businessId });
    }
    if (user.roleAssignments.some((a) => a.role.key === 'SUPER_ADMIN')) {
      const others = await this.prisma.roleAssignment.count({
        where: {
          role: { key: 'SUPER_ADMIN', businessId: null },
          revokedAt: null,
          userId: { not: userId },
          user: { deletedAt: null, status: 'ACTIVE' },
        },
      });
      if (others === 0) throw ApiError.conflict('The platform needs at least one Super Admin.');
    }

    const events = await this.prisma.$transaction(async (tx) => {
      const pending = await this.access.removeUserFromConversationsTx(tx, userId, {}, actor.userId);
      const now = new Date();
      await tx.businessMembership.updateMany({ where: { userId }, data: { status: 'REVOKED' } });
      await tx.storeMembership.updateMany({ where: { userId }, data: { status: 'REVOKED' } });
      await tx.roleAssignment.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.userContact.deleteMany({ where: { userId } });
      await tx.passwordResetToken.deleteMany({ where: { userId } });
      await tx.user.update({
        where: { id: userId },
        data: {
          username: `deleted.${userId.replace(/-/g, '').slice(0, 16)}`,
          displayName: 'Deleted user',
          status: 'DEACTIVATED',
          deletedAt: now,
          // Not a valid hash: no password can ever match it again.
          passwordHash: 'deleted',
          mustChangePassword: false,
          mfaSecretEnc: null,
          mfaPendingSecretEnc: null,
          mfaEnabledAt: null,
          mfaLastUsedStep: null,
        },
      });
      const revoked = await this.sessions.revokeAllForUserTx(tx, userId, 'account_deleted');
      if (revoked) pending.push(revoked);
      for (const businessId of businessIds.length ? businessIds : [null]) {
        await this.audit.record(
          actor,
          { action: 'user.deleted', businessId, targetType: 'User', targetId: userId },
          tx,
        );
      }
      return pending;
    });
    await this.outbox.dispatch(events);
  }

  /** Account-wide deactivation requires authority over every business the user belongs to. */
  async setStatus(actor: Actor, userId: string, status: 'ACTIVE' | 'DEACTIVATED'): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) throw ApiError.notFound('User');
    if (userId === actor.userId)
      throw ApiError.conflict('You cannot change your own account status.');
    const businessIds = await this.requireAuthorityOver(actor, 'user.deactivate', userId);
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

  /**
   * "Can export data": lets someone who is not an admin export (leads, customers, reports).
   * Only people who can export themselves and manage people (admins) may give or take it.
   */
  async setExportAccess(
    actor: Actor,
    businessId: string,
    userId: string,
    allowed: boolean,
  ): Promise<AdminUserDto> {
    await this.requireMember(businessId, userId);
    await this.authz.require(actor, 'report.export', { businessId });
    await this.authz.require(actor, 'user.update', { businessId });
    const role =
      (await this.prisma.role.findFirst({
        where: { businessId, key: EXPORT_ROLE_KEY },
        select: { id: true },
      })) ??
      (await this.prisma.role.create({
        data: {
          businessId,
          key: EXPORT_ROLE_KEY,
          name: 'Can export data',
          description: 'Export leads, customers and reports to Excel/CSV.',
          allowedScopes: ['BUSINESS'],
          permissions: { create: [{ permission: 'report.export' }] },
        },
        select: { id: true },
      }));
    const current = await this.prisma.roleAssignment.findFirst({
      where: { userId, roleId: role.id, businessId, revokedAt: null },
      select: { id: true },
    });
    if (allowed && !current)
      await this.prisma.roleAssignment.create({
        data: {
          userId,
          roleId: role.id,
          scopeType: 'BUSINESS',
          businessId,
          grantedById: actor.userId,
        },
      });
    if (!allowed && current)
      await this.prisma.roleAssignment.update({
        where: { id: current.id },
        data: { revokedAt: new Date() },
      });
    await this.audit.record(actor, {
      action: 'user.export_access_changed',
      businessId,
      targetType: 'User',
      targetId: userId,
      metadata: { allowed },
    });
    return this.get(actor, businessId, userId);
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

  /**
   * Any business may have Sales Managers and Agents (its own CRM); SMA's internal sales team
   * holds only sales roles.
   */
  private async requireRoleFitsBusiness(businessId: string, roleKey: string): Promise<void> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { internal: true },
    });
    const salesRole = (SALES_ROLE_KEYS as readonly string[]).includes(roleKey);
    if (!salesRole && business?.internal)
      throw ApiError.validation(
        'The sales team only has Sales Manager, Sales Agent and Accountant roles.',
        'roleKey',
      );
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
