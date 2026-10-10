import { describe, expect, it } from 'vitest';
import {
  canAssignRole,
  coverage,
  evaluate,
  scopeCovers,
  type AuthorizationContext,
  type Grant,
  type Scope,
} from './evaluate';
import { SYSTEM_ROLES, type Permission, type SystemRoleKey } from './permissions';

const BIZ_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const BIZ_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const STORE_A1 = 'aaaaaaaa-1111-4000-8000-000000000001';
const STORE_A2 = 'aaaaaaaa-2222-4000-8000-000000000002';
const STORE_B1 = 'bbbbbbbb-1111-4000-8000-000000000001';

function grant(role: SystemRoleKey, scope: Scope): Grant {
  return { scope, permissions: new Set(SYSTEM_ROLES[role].permissions) };
}

function ctx(
  grants: readonly Grant[],
  overrides: Partial<AuthorizationContext> = {},
): AuthorizationContext {
  return {
    userKind: 'INTERNAL',
    mfaVerified: true,
    grants,
    inactiveBusinessIds: new Set(),
    ...overrides,
  };
}

const superAdmin = ctx([grant('SUPER_ADMIN', { type: 'PLATFORM' })]);
const businessAdminA = ctx([grant('BUSINESS_ADMIN', { type: 'BUSINESS', businessId: BIZ_A })]);
const managerA1 = ctx([
  grant('STORE_MANAGER', { type: 'STORE', businessId: BIZ_A, storeId: STORE_A1 }),
]);
const employeeA1 = ctx([
  grant('EMPLOYEE', { type: 'STORE', businessId: BIZ_A, storeId: STORE_A1 }),
]);

describe('scopeCovers', () => {
  it('platform scope covers every resource including platform-level ones', () => {
    expect(scopeCovers({ type: 'PLATFORM' }, null)).toBe(true);
    expect(scopeCovers({ type: 'PLATFORM' }, { businessId: BIZ_B, storeId: STORE_B1 })).toBe(true);
  });

  it('business scope covers its own business and stores only', () => {
    const scope: Scope = { type: 'BUSINESS', businessId: BIZ_A };
    expect(scopeCovers(scope, { businessId: BIZ_A })).toBe(true);
    expect(scopeCovers(scope, { businessId: BIZ_A, storeId: STORE_A2 })).toBe(true);
    expect(scopeCovers(scope, { businessId: BIZ_B })).toBe(false);
    expect(scopeCovers(scope, null)).toBe(false);
  });

  it('store scope never covers sibling stores or business-level resources', () => {
    const scope: Scope = { type: 'STORE', businessId: BIZ_A, storeId: STORE_A1 };
    expect(scopeCovers(scope, { businessId: BIZ_A, storeId: STORE_A1 })).toBe(true);
    expect(scopeCovers(scope, { businessId: BIZ_A, storeId: STORE_A2 })).toBe(false);
    expect(scopeCovers(scope, { businessId: BIZ_A })).toBe(false);
    expect(scopeCovers(scope, { businessId: BIZ_A, storeId: null })).toBe(false);
  });

  it('store scope rejects a store id paired with a different business', () => {
    const scope: Scope = { type: 'STORE', businessId: BIZ_A, storeId: STORE_A1 };
    expect(scopeCovers(scope, { businessId: BIZ_B, storeId: STORE_A1 })).toBe(false);
  });

  it('suspended businesses are not covered by tenant scopes', () => {
    const inactive = new Set([BIZ_A]);
    expect(
      scopeCovers({ type: 'BUSINESS', businessId: BIZ_A }, { businessId: BIZ_A }, inactive),
    ).toBe(false);
    expect(scopeCovers({ type: 'PLATFORM' }, { businessId: BIZ_A }, inactive)).toBe(true);
  });
});

describe('evaluate', () => {
  it('denies by default with no grants', () => {
    expect(evaluate(ctx([]), 'message.send', { businessId: BIZ_A })).toEqual({
      allowed: false,
      reason: 'NO_GRANT',
    });
  });

  it('business admin manages stores in their business only', () => {
    expect(evaluate(businessAdminA, 'store.create', { businessId: BIZ_A }).allowed).toBe(true);
    expect(evaluate(businessAdminA, 'store.create', { businessId: BIZ_B }).allowed).toBe(false);
  });

  it('business admin cannot use platform-only permissions even inside their business', () => {
    expect(evaluate(businessAdminA, 'business.create', null).allowed).toBe(false);
    expect(evaluate(businessAdminA, 'business.suspend', { businessId: BIZ_A }).allowed).toBe(false);
  });

  it('a custom business-scoped role carrying a platform-only permission still cannot use it', () => {
    const custom = ctx([
      {
        scope: { type: 'BUSINESS', businessId: BIZ_A },
        permissions: new Set<Permission>(['business.suspend']),
      },
    ]);
    expect(evaluate(custom, 'business.suspend', { businessId: BIZ_A }).allowed).toBe(false);
  });

  it('store manager is limited to the assigned store', () => {
    expect(
      evaluate(managerA1, 'group.create', { businessId: BIZ_A, storeId: STORE_A1 }).allowed,
    ).toBe(true);
    expect(
      evaluate(managerA1, 'group.create', { businessId: BIZ_A, storeId: STORE_A2 }).allowed,
    ).toBe(false);
    expect(evaluate(managerA1, 'group.create', { businessId: BIZ_A }).allowed).toBe(false);
  });

  it('employees cannot create groups or manage users', () => {
    const r = { businessId: BIZ_A, storeId: STORE_A1 };
    expect(evaluate(employeeA1, 'group.create', r).allowed).toBe(false);
    expect(evaluate(employeeA1, 'user.create', r).allowed).toBe(false);
    expect(evaluate(employeeA1, 'message.send', r).allowed).toBe(true);
  });

  it('privileged permissions require an MFA-verified session', () => {
    const noMfa = ctx(businessAdminA.grants, { mfaVerified: false });
    expect(evaluate(noMfa, 'user.create', { businessId: BIZ_A })).toEqual({
      allowed: false,
      reason: 'MFA_REQUIRED',
    });
    // Non-privileged permissions still work without MFA.
    expect(evaluate(noMfa, 'message.send', { businessId: BIZ_A }).allowed).toBe(true);
  });

  it('reports NO_GRANT rather than MFA_REQUIRED when the permission is not held at all', () => {
    const noMfa = ctx(employeeA1.grants, { mfaVerified: false });
    expect(evaluate(noMfa, 'user.create', { businessId: BIZ_A })).toEqual({
      allowed: false,
      reason: 'NO_GRANT',
    });
  });

  it('external users are restricted to externally allowed permissions', () => {
    const misconfigured = ctx([grant('BUSINESS_ADMIN', { type: 'BUSINESS', businessId: BIZ_A })], {
      userKind: 'EXTERNAL',
    });
    expect(evaluate(misconfigured, 'user.read', { businessId: BIZ_A })).toEqual({
      allowed: false,
      reason: 'EXTERNAL_USER_RESTRICTED',
    });
    expect(evaluate(misconfigured, 'message.send', { businessId: BIZ_A }).allowed).toBe(true);
  });

  it('super admin is denied tenant access only through other rules, not scope', () => {
    expect(evaluate(superAdmin, 'business.create', null).allowed).toBe(true);
    expect(evaluate(superAdmin, 'user.create', { businessId: BIZ_B }).allowed).toBe(true);
  });

  it('suspended business blocks its admins but not the platform', () => {
    const suspended = new Set([BIZ_A]);
    expect(
      evaluate(ctx(businessAdminA.grants, { inactiveBusinessIds: suspended }), 'store.read', {
        businessId: BIZ_A,
      }).allowed,
    ).toBe(false);
    expect(
      evaluate(ctx(superAdmin.grants, { inactiveBusinessIds: suspended }), 'store.read', {
        businessId: BIZ_A,
      }).allowed,
    ).toBe(true);
  });
});

describe('coverage', () => {
  it('collects business and store scopes', () => {
    const multi = ctx([
      grant('BUSINESS_ADMIN', { type: 'BUSINESS', businessId: BIZ_A }),
      grant('EMPLOYEE', { type: 'STORE', businessId: BIZ_B, storeId: STORE_B1 }),
    ]);
    const c = coverage(multi, 'user.read');
    expect(c.all).toBe(false);
    if (!c.all) {
      expect([...c.businessIds]).toEqual([BIZ_A]);
      expect(c.stores.get(STORE_B1)).toBe(BIZ_B);
    }
  });

  it('returns all for platform grants', () => {
    expect(coverage(superAdmin, 'user.read')).toEqual({ all: true });
  });
});

describe('canAssignRole', () => {
  const managerRole = SYSTEM_ROLES.STORE_MANAGER;
  const businessAdminRole = SYSTEM_ROLES.BUSINESS_ADMIN;
  const superAdminRole = SYSTEM_ROLES.SUPER_ADMIN;

  it('business admin can assign a store manager in their own store', () => {
    expect(
      canAssignRole(businessAdminA, managerRole, {
        type: 'STORE',
        businessId: BIZ_A,
        storeId: STORE_A1,
      }),
    ).toEqual({ allowed: true });
  });

  it('business admin cannot assign roles in another business', () => {
    expect(
      canAssignRole(businessAdminA, managerRole, {
        type: 'STORE',
        businessId: BIZ_B,
        storeId: STORE_B1,
      }).allowed,
    ).toBe(false);
  });

  it('business admin cannot grant platform roles (escalation)', () => {
    expect(canAssignRole(businessAdminA, superAdminRole, { type: 'PLATFORM' })).toEqual({
      allowed: false,
      reason: 'NO_GRANT',
    });
  });

  it('roles cannot be assigned at scopes they do not allow', () => {
    expect(canAssignRole(superAdmin, managerRole, { type: 'BUSINESS', businessId: BIZ_A })).toEqual(
      { allowed: false, reason: 'SCOPE_NOT_ALLOWED_FOR_ROLE' },
    );
  });

  it('a custom role containing permissions the assigner lacks is an escalation', () => {
    const limitedAssigner = ctx([
      {
        scope: { type: 'BUSINESS', businessId: BIZ_A },
        permissions: new Set<Permission>(['role.assign', 'message.send']),
      },
    ]);
    expect(
      canAssignRole(
        limitedAssigner,
        { allowedScopes: ['BUSINESS'], permissions: ['message.send', 'audit.read'] },
        { type: 'BUSINESS', businessId: BIZ_A },
      ),
    ).toEqual({ allowed: false, reason: 'PRIVILEGE_ESCALATION' });
  });

  it('store managers cannot assign roles', () => {
    expect(
      canAssignRole(managerA1, SYSTEM_ROLES.EMPLOYEE, {
        type: 'STORE',
        businessId: BIZ_A,
        storeId: STORE_A1,
      }).allowed,
    ).toBe(false);
  });

  it('business admin can assign another business admin in the same business', () => {
    expect(
      canAssignRole(businessAdminA, businessAdminRole, { type: 'BUSINESS', businessId: BIZ_A }),
    ).toEqual({
      allowed: true,
    });
  });
});
