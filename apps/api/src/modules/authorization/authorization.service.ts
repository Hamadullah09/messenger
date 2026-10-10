import { Injectable } from '@nestjs/common';
import {
  coverage,
  evaluate,
  isPermission,
  PERMISSIONS,
  type AuthorizationContext,
  type CoverageSet,
  type Grant,
  type GrantDto,
  type Permission,
  type ResourceScope,
  type Scope,
} from '@storeline/shared';
import { ApiError } from '../../infra/http/api-error';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { metrics } from '../../infra/metrics/metrics';

export interface LoadedGrants {
  grants: Grant[];
  dtos: GrantDto[];
  inactiveBusinessIds: Set<string>;
}

/**
 * Server-side authorization: loads the actor's role assignments from the database and
 * delegates the decision to the pure evaluator in @storeline/shared (unit tested there).
 */
@Injectable()
export class AuthorizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  context(actor: Actor): Promise<AuthorizationContext> {
    actor.authz ??= this.loadGrants(actor.userId).then((loaded) => ({
      userKind: actor.kind,
      mfaVerified: actor.mfaVerified,
      grants: loaded.grants,
      inactiveBusinessIds: loaded.inactiveBusinessIds,
    }));
    return actor.authz;
  }

  async loadGrants(userId: string): Promise<LoadedGrants> {
    const [assignments, memberships] = await Promise.all([
      this.prisma.roleAssignment.findMany({
        where: { userId, revokedAt: null },
        select: {
          scopeType: true,
          businessId: true,
          storeId: true,
          store: { select: { status: true } },
          business: { select: { status: true } },
          role: {
            select: { key: true, name: true, permissions: { select: { permission: true } } },
          },
        },
      }),
      this.prisma.businessMembership.findMany({
        where: { userId, status: 'ACTIVE' },
        select: { businessId: true },
      }),
    ]);
    const memberOf = new Set(memberships.map((m) => m.businessId));
    const inactiveBusinessIds = new Set<string>();
    const grants: Grant[] = [];
    const dtos: GrantDto[] = [];

    for (const a of assignments) {
      let scope: Scope;
      if (a.scopeType === 'PLATFORM') {
        scope = { type: 'PLATFORM' };
      } else {
        if (!a.businessId || !memberOf.has(a.businessId)) continue; // defence in depth
        if (a.business && a.business.status !== 'ACTIVE') inactiveBusinessIds.add(a.businessId);
        if (a.scopeType === 'BUSINESS') {
          scope = { type: 'BUSINESS', businessId: a.businessId };
        } else {
          if (!a.storeId || a.store?.status !== 'ACTIVE') continue;
          scope = { type: 'STORE', businessId: a.businessId, storeId: a.storeId };
        }
      }
      const permissions = a.role.permissions.map((p) => p.permission).filter(isPermission);
      grants.push({ scope, permissions: new Set(permissions) });
      dtos.push({
        roleKey: a.role.key,
        roleName: a.role.name,
        scope: { type: a.scopeType, businessId: a.businessId, storeId: a.storeId },
        permissions,
      });
    }
    return { grants, dtos, inactiveBusinessIds };
  }

  async can(actor: Actor, permission: Permission, resource: ResourceScope): Promise<boolean> {
    return evaluate(await this.context(actor), permission, resource).allowed;
  }

  async coverage(actor: Actor, permission: Permission): Promise<CoverageSet> {
    return coverage(await this.context(actor), permission);
  }

  /** Throws FORBIDDEN / MFA_REQUIRED. Denials of privileged permissions are audited. */
  async require(actor: Actor, permission: Permission, resource: ResourceScope): Promise<void> {
    const decision = evaluate(await this.context(actor), permission, resource);
    if (decision.allowed) return;
    metrics.authzDenials.inc({ permission, reason: decision.reason });
    const definition = PERMISSIONS[permission] as { privileged?: boolean };
    if (definition.privileged) {
      await this.audit.recordSafely(actor, {
        action: 'authz.denied',
        outcome: 'DENIED',
        businessId: resource?.businessId ?? null,
        storeId: resource?.storeId ?? null,
        metadata: { permission, reason: decision.reason },
      });
    }
    if (decision.reason === 'MFA_REQUIRED') {
      throw new ApiError(
        'MFA_REQUIRED',
        'Turn on two-step verification to use administrator features.',
      );
    }
    throw ApiError.forbidden();
  }

  /** Every business/store id where the permission applies, or 'all' for platform holders. */
  async scopedFilter(
    actor: Actor,
    permission: Permission,
  ): Promise<{ all: true } | { all: false; businessIds: string[]; storeIds: string[] }> {
    const c = await this.coverage(actor, permission);
    if (c.all) return { all: true };
    return { all: false, businessIds: [...c.businessIds], storeIds: [...c.stores.keys()] };
  }
}
