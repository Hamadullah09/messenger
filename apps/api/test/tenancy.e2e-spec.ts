import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, type Session } from './harness';

/**
 * End-to-end administrative journey and cross-tenant isolation:
 * Super Admin creates a business → Business Admin creates stores and employees → assigns a
 * Store Manager → other tenants cannot see or touch any of it.
 */
describe('Tenancy, users and roles', () => {
  let h: Harness;
  let superAdmin: Session;
  let adminA: Session;
  let adminB: Session;
  let businessA: string;
  let businessB: string;
  let storeA1: string;
  let storeA2: string;

  beforeAll(async () => {
    h = await Harness.start();
    await h.createUser({ username: 'root', role: 'SUPER_ADMIN' });
    superAdmin = await h.loginWithMfa('root');
    businessB = (await h.createBusiness('Other Co')).id;
    await h.createUser({ username: 'admin.b', role: 'BUSINESS_ADMIN', businessId: businessB });
    adminB = await h.loginWithMfa('admin.b');
  });
  afterAll(() => h.stop());

  it('Super Admin creates a business (audited)', async () => {
    const res = await superAdmin
      .post('/api/v1/businesses')
      .send({ name: 'ABC Retail', slug: 'abc-retail', timeZone: 'America/New_York' })
      .expect(201);
    businessA = res.body.id;
    expect(res.body).toMatchObject({ name: 'ABC Retail', status: 'ACTIVE', storeCount: 0 });
    await superAdmin
      .post('/api/v1/businesses')
      .send({ name: 'Dup', slug: 'abc-retail' })
      .expect(409);
    const audit = await h.prisma.auditLog.findFirst({
      where: { action: 'business.created', businessId: businessA },
    });
    expect(audit).not.toBeNull();
  });

  it('only the platform can create businesses', async () => {
    await adminB.post('/api/v1/businesses').send({ name: 'Nope', slug: 'nope-co' }).expect(403);
  });

  it('Business Admin creates stores and users within their business', async () => {
    const admin = await h.createUser({
      username: 'admin.a',
      role: 'BUSINESS_ADMIN',
      businessId: businessA,
    });
    expect(admin.id).toBeDefined();
    adminA = await h.loginWithMfa('admin.a');

    storeA1 = (
      await adminA
        .post(`/api/v1/businesses/${businessA}/stores`)
        .send({ name: 'Store A1', code: 'a1' })
        .expect(201)
    ).body.id;
    storeA2 = (
      await adminA
        .post(`/api/v1/businesses/${businessA}/stores`)
        .send({ name: 'Store A2', code: 'A2' })
        .expect(201)
    ).body.id;
    await adminA
      .post(`/api/v1/businesses/${businessA}/stores`)
      .send({ name: 'Dup', code: 'A1' })
      .expect(409);

    const employee = await adminA
      .post(`/api/v1/businesses/${businessA}/users`)
      .send({
        username: 'Erin.Employee',
        displayName: 'Erin Employee',
        initialPassword: 'initial-password-123',
        storeIds: [storeA1],
        roleKey: 'EMPLOYEE',
        email: 'erin@example.com',
      })
      .expect(201);
    expect(employee.body).toMatchObject({ username: 'erin.employee', mustChangePassword: true });
    expect(employee.body.stores).toEqual([expect.objectContaining({ id: storeA1 })]);
    expect(JSON.stringify(employee.body)).not.toContain('erin@example.com');
  });

  it('assigns a Store Manager who only sees their own store', async () => {
    const manager = await adminA
      .post(`/api/v1/businesses/${businessA}/users`)
      .send({
        username: 'mike.manager',
        displayName: 'Mike Manager',
        initialPassword: 'initial-password-123',
        storeIds: [storeA1],
        roleKey: 'STORE_MANAGER',
      })
      .expect(201);
    expect(manager.body.roles).toEqual([
      expect.objectContaining({ roleKey: 'STORE_MANAGER', storeId: storeA1 }),
    ]);

    const otherStoreUser = await h.createUser({
      role: 'EMPLOYEE',
      businessId: businessA,
      storeIds: [storeA2],
    });
    await h.prisma.user.update({
      where: { id: manager.body.id },
      data: { mustChangePassword: false },
    });
    const session = await h.login('mike.manager', 'initial-password-123');

    const stores = await session.get(`/api/v1/businesses/${businessA}/stores`).expect(200);
    expect(stores.body.map((s: { id: string }) => s.id)).toEqual([storeA1]);

    const users = await session.get(`/api/v1/businesses/${businessA}/users`).expect(200);
    const ids = users.body.items.map((u: { id: string }) => u.id);
    expect(ids).not.toContain(otherStoreUser.id);
    expect(users.body.items.every((u: { mfaEnabled: unknown }) => u.mfaEnabled === null)).toBe(
      true,
    );

    await session.get(`/api/v1/businesses/${businessA}/users?storeId=${storeA2}`).expect(403);
    await session.get(`/api/v1/stores/${storeA2}`).expect(403);
    await session
      .post(`/api/v1/businesses/${businessA}/stores`)
      .send({ name: 'Extra Store', code: 'X1' })
      .expect(403);
  });

  it('isolates tenants: another business admin cannot read or change business A', async () => {
    await adminB.get(`/api/v1/businesses/${businessA}`).expect(403);
    await adminB.get(`/api/v1/businesses/${businessA}/stores`).expect(403);
    await adminB.get(`/api/v1/businesses/${businessA}/users`).expect(403);
    await adminB.get(`/api/v1/stores/${storeA1}`).expect(403);
    await adminB.patch(`/api/v1/stores/${storeA1}`).send({ name: 'Hacked' }).expect(403);
    await adminB
      .post(`/api/v1/businesses/${businessA}/stores`)
      .send({ name: 'Hack', code: 'HK' })
      .expect(403);
    await adminB.get(`/api/v1/businesses/${businessA}/roles`).expect(403);
    await adminB.get(`/api/v1/audit?businessId=${businessA}`).expect(403);
    const list = await adminB.get('/api/v1/businesses').expect(200);
    expect(list.body.items.map((b: { id: string }) => b.id)).toEqual([businessB]);
  });

  it('rejects stores from another tenant when creating users', async () => {
    const storeB = (await h.createStore(businessB)).id;
    await adminA
      .post(`/api/v1/businesses/${businessA}/users`)
      .send({
        username: 'sneaky',
        displayName: 'Sneaky',
        initialPassword: 'initial-password-123',
        storeIds: [storeB],
        roleKey: 'EMPLOYEE',
      })
      .expect(400);
  });

  it('prevents privilege escalation through role assignment', async () => {
    const roles = await adminA.get(`/api/v1/businesses/${businessA}/roles`).expect(200);
    const keys = roles.body.map((r: { key: string }) => r.key);
    expect(keys).not.toContain('SUPER_ADMIN');

    const superRole = await h.prisma.role.findFirstOrThrow({
      where: { key: 'SUPER_ADMIN', businessId: null },
    });
    const target = await h.createUser({
      role: 'EMPLOYEE',
      businessId: businessA,
      storeIds: [storeA1],
    });
    await adminA
      .post(`/api/v1/users/${target.id}/role-assignments`)
      .send({ roleId: superRole.id, scopeType: 'PLATFORM' })
      .expect(403);

    const managerRole = await h.prisma.role.findFirstOrThrow({
      where: { key: 'STORE_MANAGER', businessId: null },
    });
    // Store-scoped role at business scope is invalid.
    await adminA
      .post(`/api/v1/users/${target.id}/role-assignments`)
      .send({ roleId: managerRole.id, scopeType: 'BUSINESS', businessId: businessA })
      .expect(400);
    // Must belong to the store first.
    await adminA
      .post(`/api/v1/users/${target.id}/role-assignments`)
      .send({ roleId: managerRole.id, scopeType: 'STORE', businessId: businessA, storeId: storeA2 })
      .expect(400);
    const ok = await adminA
      .post(`/api/v1/users/${target.id}/role-assignments`)
      .send({ roleId: managerRole.id, scopeType: 'STORE', businessId: businessA, storeId: storeA1 })
      .expect(201);
    // Another tenant's admin cannot revoke it.
    await adminB.delete(`/api/v1/role-assignments/${ok.body.id}`).expect(403);
    await adminA.delete(`/api/v1/role-assignments/${ok.body.id}`).expect(204);
  });

  it('custom roles cannot contain permissions the creator lacks', async () => {
    await adminA
      .post(`/api/v1/businesses/${businessA}/roles`)
      .send({
        key: 'SHIFT_LEAD',
        name: 'Shift Lead',
        allowedScopes: ['STORE'],
        permissions: ['message.send', 'group.create'],
      })
      .expect(201);
    await adminA
      .post(`/api/v1/businesses/${businessA}/roles`)
      .send({
        key: 'SNEAKY',
        name: 'Sneaky',
        allowedScopes: ['BUSINESS'],
        permissions: ['business.create'],
      })
      .expect(400);
  });

  it('suspending a business blocks its admins but not the platform', async () => {
    const business = await h.createBusiness('Suspend Me');
    await h.createUser({ username: 'admin.s', role: 'BUSINESS_ADMIN', businessId: business.id });
    const admin = await h.loginWithMfa('admin.s');
    await admin.get(`/api/v1/businesses/${business.id}/stores`).expect(200);
    await superAdmin.post(`/api/v1/businesses/${business.id}/suspend`).expect(200);
    await admin.get(`/api/v1/businesses/${business.id}/stores`).expect(403);
    await superAdmin.get(`/api/v1/businesses/${business.id}/stores`).expect(200);
    await adminA.post(`/api/v1/businesses/${business.id}/reactivate`).expect(403);
  });

  it('audit log is readable by business admins for their business only', async () => {
    const res = await adminA.get(`/api/v1/audit?businessId=${businessA}`).expect(200);
    const actions = res.body.items.map((i: { action: string }) => i.action);
    expect(actions).toEqual(
      expect.arrayContaining(['store.created', 'user.created', 'role.assigned', 'role.revoked']),
    );
    expect(res.body.items.every((i: { businessId: string }) => i.businessId === businessA)).toBe(
      true,
    );
    await adminA.get('/api/v1/audit').expect(403);
    await superAdmin.get('/api/v1/audit').expect(200);
  });
});
