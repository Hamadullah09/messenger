import { Injectable } from '@nestjs/common';
import { Prisma, type ScopeType } from '@prisma/client';
import {
  canAssignRole,
  evaluate,
  isPermission,
  PERMISSIONS,
  type CreateRoleAssignmentRequest,
  type CreateRoleRequest,
  type Permission,
  type RoleDto,
  type Scope,
} from '@storeline/shared';
import { ApiError } from '../../infra/http/api-error';
import { isUniqueViolation, PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { AuthorizationService } from '../authorization/authorization.service';

const roleSelect = {
  id: true,
  key: true,
  name: true,
  description: true,
  businessId: true,
  isSystem: true,
  allowedScopes: true,
  permissions: { select: { permission: true } },
} as const satisfies Prisma.RoleSelect;

type RoleRow = Prisma.RoleGetPayload<{ select: typeof roleSelect }>;

function toDto(row: RoleRow): RoleDto {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    businessId: row.businessId,
    isSystem: row.isSystem,
    allowedScopes: row.allowedScopes,
    permissions: row.permissions.map((p) => p.permission).filter(isPermission),
  };
}

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  catalog(): Array<{ key: Permission; description: string; privileged: boolean }> {
    return (Object.keys(PERMISSIONS) as Permission[]).map((key) => {
      const def = PERMISSIONS[key] as { description: string; privileged?: boolean };
      return { key, description: def.description, privileged: def.privileged === true };
    });
  }

  async list(actor: Actor, businessId: string): Promise<RoleDto[]> {
    await this.authz.require(actor, 'role.read', { businessId });
    const rows = await this.prisma.role.findMany({
      where: { OR: [{ businessId: null, NOT: { key: 'SUPER_ADMIN' } }, { businessId }] },
      select: roleSelect,
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    });
    return rows.map(toDto);
  }

  async create(actor: Actor, businessId: string, request: CreateRoleRequest): Promise<RoleDto> {
    await this.authz.require(actor, 'role.manage', { businessId });
    const ctx = await this.authz.context(actor);
    const permissions = [...new Set(request.permissions)] as Permission[];
    for (const permission of permissions) {
      const def = PERMISSIONS[permission] as { platformOnly?: boolean };
      if (def.platformOnly)
        throw ApiError.validation(
          `"${permission}" cannot be part of a business role.`,
          'permissions',
        );
      // No escalation: a custom role may only contain permissions the creator holds business-wide.
      if (!evaluate(ctx, permission, { businessId }).allowed) {
        throw ApiError.forbidden(`You cannot create a role with "${permission}".`);
      }
    }
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.role.create({
          data: {
            businessId,
            key: request.key,
            name: request.name,
            description: request.description,
            allowedScopes: request.allowedScopes,
            permissions: { create: permissions.map((permission) => ({ permission })) },
          },
          select: roleSelect,
        });
        await this.audit.record(
          actor,
          {
            action: 'role.created',
            businessId,
            targetType: 'Role',
            targetId: created.id,
            metadata: { key: created.key, permissions },
          },
          tx,
        );
        return created;
      });
      return toDto(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw ApiError.conflict('A role with this key already exists.');
      throw error;
    }
  }

  async assign(
    actor: Actor,
    userId: string,
    request: CreateRoleAssignmentRequest,
  ): Promise<{ id: string }> {
    const role = await this.prisma.role.findUnique({
      where: { id: request.roleId },
      select: roleSelect,
    });
    if (!role) throw ApiError.notFound('Role');
    const scope = await this.resolveScope(request, userId);
    if (role.businessId && (scope.type === 'PLATFORM' || scope.businessId !== role.businessId)) {
      throw ApiError.validation('This role belongs to another business.', 'roleId');
    }
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { kind: true },
    });
    if (!target) throw ApiError.notFound('User');
    if (target.kind === 'EXTERNAL' && role.key !== 'CUSTOMER') {
      throw ApiError.validation('External users can only have the Customer role.', 'roleId');
    }

    await this.requireCanAssign(actor, toDto(role), scope);
    try {
      const assignment = await this.prisma.$transaction(async (tx) => {
        const created = await tx.roleAssignment.create({
          data: {
            userId,
            roleId: role.id,
            scopeType: scope.type,
            businessId: scope.type === 'PLATFORM' ? null : scope.businessId,
            storeId: scope.type === 'STORE' ? scope.storeId : null,
            grantedById: actor.userId,
          },
          select: { id: true },
        });
        await this.audit.record(
          actor,
          {
            action: 'role.assigned',
            businessId: scope.type === 'PLATFORM' ? null : scope.businessId,
            storeId: scope.type === 'STORE' ? scope.storeId : null,
            targetType: 'User',
            targetId: userId,
            metadata: { role: role.key, scope: scope.type, assignmentId: created.id },
          },
          tx,
        );
        return created;
      });
      return assignment;
    } catch (error) {
      if (isUniqueViolation(error)) throw ApiError.conflict('The user already has this role here.');
      throw error;
    }
  }

  async revoke(actor: Actor, assignmentId: string): Promise<void> {
    const assignment = await this.prisma.roleAssignment.findUnique({
      where: { id: assignmentId },
      select: {
        id: true,
        userId: true,
        scopeType: true,
        businessId: true,
        storeId: true,
        revokedAt: true,
        role: { select: roleSelect },
      },
    });
    if (!assignment || assignment.revokedAt) throw ApiError.notFound('Role assignment');
    const scope = scopeOf(assignment.scopeType, assignment.businessId, assignment.storeId);
    // Revoking requires the same authority as granting.
    await this.requireCanAssign(actor, toDto(assignment.role), scope);
    if (assignment.role.key === 'SUPER_ADMIN') {
      const remaining = await this.prisma.roleAssignment.count({
        where: {
          role: { key: 'SUPER_ADMIN', businessId: null },
          revokedAt: null,
          id: { not: assignment.id },
        },
      });
      if (remaining === 0) throw ApiError.conflict('The platform needs at least one Super Admin.');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.roleAssignment.update({
        where: { id: assignmentId },
        data: { revokedAt: new Date() },
      });
      await this.audit.record(
        actor,
        {
          action: 'role.revoked',
          businessId: assignment.businessId,
          storeId: assignment.storeId,
          targetType: 'User',
          targetId: assignment.userId,
          metadata: { role: assignment.role.key, scope: assignment.scopeType, assignmentId },
        },
        tx,
      );
    });
  }

  private async requireCanAssign(actor: Actor, role: RoleDto, scope: Scope): Promise<void> {
    const decision = canAssignRole(await this.authz.context(actor), role, scope);
    if (decision.allowed) return;
    await this.audit.recordSafely(actor, {
      action: 'authz.denied',
      outcome: 'DENIED',
      businessId: scope.type === 'PLATFORM' ? null : scope.businessId,
      metadata: { permission: 'role.assign', role: role.key, reason: decision.reason },
    });
    if (decision.reason === 'MFA_REQUIRED')
      throw new ApiError('MFA_REQUIRED', 'Turn on two-step verification first.');
    if (decision.reason === 'SCOPE_NOT_ALLOWED_FOR_ROLE') {
      throw ApiError.validation('This role cannot be given at that level.', 'scopeType');
    }
    throw ApiError.forbidden('You cannot give this role.');
  }

  /** Validates the target scope against the database: the store must belong to the business, and the user to both. */
  private async resolveScope(request: CreateRoleAssignmentRequest, userId: string): Promise<Scope> {
    if (request.scopeType === 'PLATFORM') return { type: 'PLATFORM' };
    const membership = await this.prisma.businessMembership.findUnique({
      where: { businessId_userId: { businessId: request.businessId, userId } },
      select: { status: true },
    });
    if (!membership || membership.status !== 'ACTIVE') {
      throw ApiError.validation('The user is not a member of this business.', 'businessId');
    }
    if (request.scopeType === 'BUSINESS')
      return { type: 'BUSINESS', businessId: request.businessId };
    const storeMembership = await this.prisma.storeMembership.findFirst({
      where: {
        storeId: request.storeId,
        businessId: request.businessId,
        userId,
        status: 'ACTIVE',
        store: { status: 'ACTIVE' },
      },
      select: { id: true },
    });
    if (!storeMembership) throw ApiError.validation('Add the user to this store first.', 'storeId');
    return { type: 'STORE', businessId: request.businessId, storeId: request.storeId };
  }
}

function scopeOf(type: ScopeType, businessId: string | null, storeId: string | null): Scope {
  if (type === 'PLATFORM') return { type: 'PLATFORM' };
  if (type === 'BUSINESS' && businessId) return { type: 'BUSINESS', businessId };
  if (type === 'STORE' && businessId && storeId) return { type: 'STORE', businessId, storeId };
  throw new Error('Corrupt role assignment scope');
}
