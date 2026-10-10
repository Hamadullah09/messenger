import { PERMISSIONS, type Permission, type ScopeType } from './permissions';

export type Scope =
  | { readonly type: 'PLATFORM' }
  | { readonly type: 'BUSINESS'; readonly businessId: string }
  | { readonly type: 'STORE'; readonly businessId: string; readonly storeId: string };

/** A role assignment flattened to its permission set and scope. */
export interface Grant {
  readonly scope: Scope;
  readonly permissions: ReadonlySet<Permission>;
}

/**
 * The tenant location of a resource, always loaded from the database by the server.
 * `null` means a platform-level resource (e.g. the list of all businesses).
 */
export type ResourceScope = {
  readonly businessId: string;
  readonly storeId?: string | null;
} | null;

export interface AuthorizationContext {
  readonly userKind: 'INTERNAL' | 'EXTERNAL';
  readonly mfaVerified: boolean;
  readonly grants: readonly Grant[];
  /** Businesses that are suspended/archived. Only PLATFORM grants still apply inside them. */
  readonly inactiveBusinessIds: ReadonlySet<string>;
}

export type DenyReason = 'NO_GRANT' | 'MFA_REQUIRED' | 'EXTERNAL_USER_RESTRICTED';

export type Decision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: DenyReason };

const ALLOW: Decision = { allowed: true };

/** True when an assignment at `scope` applies to `resource`. */
export function scopeCovers(
  scope: Scope,
  resource: ResourceScope,
  inactiveBusinessIds: ReadonlySet<string> = new Set(),
): boolean {
  if (scope.type === 'PLATFORM') return true;
  if (resource === null) return false;
  if (inactiveBusinessIds.has(resource.businessId)) return false;
  if (scope.businessId !== resource.businessId) return false;
  if (scope.type === 'BUSINESS') return true;
  return resource.storeId != null && resource.storeId === scope.storeId;
}

/** Evaluate whether the context may perform `permission` on `resource`. Deny by default. */
export function evaluate(
  ctx: AuthorizationContext,
  permission: Permission,
  resource: ResourceScope,
): Decision {
  const definition = PERMISSIONS[permission];

  if (ctx.userKind === 'EXTERNAL' && !definition.externalAllowed) {
    return { allowed: false, reason: 'EXTERNAL_USER_RESTRICTED' };
  }

  const platformOnly = definition.platformOnly === true;
  const covered = ctx.grants.some(
    (grant) =>
      grant.permissions.has(permission) &&
      (!platformOnly || grant.scope.type === 'PLATFORM') &&
      scopeCovers(grant.scope, resource, ctx.inactiveBusinessIds),
  );
  if (!covered) return { allowed: false, reason: 'NO_GRANT' };

  if (definition.privileged && !ctx.mfaVerified) {
    return { allowed: false, reason: 'MFA_REQUIRED' };
  }
  return ALLOW;
}

/**
 * Which tenants a permission is usable in — for list endpoints that must filter rows
 * rather than check a single resource. MFA is not considered here; callers evaluating
 * privileged permissions must use `evaluate` per resource or check MFA separately.
 */
export type CoverageSet =
  | { readonly all: true }
  | {
      readonly all: false;
      readonly businessIds: ReadonlySet<string>;
      /** storeId -> businessId for store-scoped grants. */
      readonly stores: ReadonlyMap<string, string>;
    };

export function coverage(ctx: AuthorizationContext, permission: Permission): CoverageSet {
  const definition = PERMISSIONS[permission];
  if (ctx.userKind === 'EXTERNAL' && !definition.externalAllowed) {
    return { all: false, businessIds: new Set(), stores: new Map() };
  }
  const businessIds = new Set<string>();
  const stores = new Map<string, string>();
  for (const grant of ctx.grants) {
    if (!grant.permissions.has(permission)) continue;
    if (grant.scope.type === 'PLATFORM') return { all: true };
    if (definition.platformOnly) continue;
    if (ctx.inactiveBusinessIds.has(grant.scope.businessId)) continue;
    if (grant.scope.type === 'BUSINESS') businessIds.add(grant.scope.businessId);
    else stores.set(grant.scope.storeId, grant.scope.businessId);
  }
  return { all: false, businessIds, stores };
}

export function scopeAsResource(scope: Scope): ResourceScope {
  switch (scope.type) {
    case 'PLATFORM':
      return null;
    case 'BUSINESS':
      return { businessId: scope.businessId };
    case 'STORE':
      return { businessId: scope.businessId, storeId: scope.storeId };
  }
}

export type AssignmentDenyReason =
  DenyReason | 'SCOPE_NOT_ALLOWED_FOR_ROLE' | 'PRIVILEGE_ESCALATION';

/**
 * Whether `ctx` may grant a role with `rolePermissions` at `targetScope`.
 * Rules: the assigner needs `role.assign` covering the target scope, the role must allow
 * that scope type, and the assigner must already hold every permission of the role at a
 * scope covering the target (no privilege escalation).
 */
export function canAssignRole(
  ctx: AuthorizationContext,
  role: {
    readonly allowedScopes: readonly ScopeType[];
    readonly permissions: Iterable<Permission>;
  },
  targetScope: Scope,
): { allowed: true } | { allowed: false; reason: AssignmentDenyReason } {
  if (!role.allowedScopes.includes(targetScope.type)) {
    return { allowed: false, reason: 'SCOPE_NOT_ALLOWED_FOR_ROLE' };
  }
  const resource = scopeAsResource(targetScope);
  const base = evaluate(ctx, 'role.assign', resource);
  if (!base.allowed) return base;
  for (const permission of role.permissions) {
    const held = ctx.grants.some(
      (grant) =>
        grant.permissions.has(permission) &&
        // A platform-scoped role can only be granted by someone holding it platform-wide.
        (targetScope.type !== 'PLATFORM' || grant.scope.type === 'PLATFORM') &&
        scopeCovers(grant.scope, resource, ctx.inactiveBusinessIds),
    );
    if (!held) return { allowed: false, reason: 'PRIVILEGE_ESCALATION' };
  }
  return ALLOW;
}
