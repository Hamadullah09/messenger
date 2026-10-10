import type { Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, uuid, type Session } from './harness';

const MANAGER_EMAIL = 'private.manager@example.com';
const MANAGER_PHONE = '+15555550199';

/**
 * Private contact details (email/phone) must never leave the server outside the dedicated,
 * privileged and audited endpoint — not in REST payloads, socket payloads, or search.
 */
describe('Contact privacy', () => {
  let h: Harness;
  let businessId: string;
  let managerId: string;
  let employee: Session;
  let manager: Session;
  const seen: string[] = [];

  const record = (body: unknown) => seen.push(JSON.stringify(body));

  beforeAll(async () => {
    h = await Harness.start({ worker: true });
    businessId = (await h.createBusiness()).id;
    const storeId = (await h.createStore(businessId)).id;
    const m = await h.createUser({
      role: 'STORE_MANAGER',
      businessId,
      storeIds: [storeId],
      email: MANAGER_EMAIL,
      phone: MANAGER_PHONE,
    });
    const e = await h.createUser({ role: 'EMPLOYEE', businessId, storeIds: [storeId] });
    managerId = m.id;
    manager = await h.login(m.username);
    employee = await h.login(e.username);
  });
  afterAll(() => h.stop());

  it('never exposes contact details through messaging flows', async () => {
    const socket: Socket = await h.socket(employee);
    socket.onAny((_event, payload) => record(payload));

    const dm = await employee
      .post('/api/v1/conversations/direct')
      .send({ businessId, userId: managerId })
      .expect(201);
    record(dm.body);
    record((await employee.get(`/api/v1/directory?businessId=${businessId}`).expect(200)).body);
    record((await employee.get('/api/v1/conversations').expect(200)).body);
    record((await employee.get(`/api/v1/conversations/${dm.body.id}`).expect(200)).body);
    await manager
      .post(`/api/v1/conversations/${dm.body.id}/messages`)
      .send({ clientMessageId: uuid(), body: 'call me if needed' })
      .expect(201);
    record((await employee.get(`/api/v1/conversations/${dm.body.id}/messages`).expect(200)).body);
    record((await employee.get('/api/v1/search/messages?q=call').expect(200)).body);
    record((await employee.get(`/api/v1/businesses/${businessId}/users`).expect(200)).body);
    record(
      (await employee.get(`/api/v1/businesses/${businessId}/users/${managerId}`).expect(200)).body,
    );
    record((await employee.get('/api/v1/me').expect(200)).body);
    await new Promise((r) => setTimeout(r, 1500)); // let socket events arrive

    const everything = seen.join('\n');
    expect(seen.length).toBeGreaterThan(8);
    expect(everything).not.toContain(MANAGER_EMAIL);
    expect(everything).not.toContain(MANAGER_PHONE);
    expect(everything).not.toMatch(/"(email|phone)"/);
  });

  it('employees cannot read contact details', async () => {
    await employee.get(`/api/v1/businesses/${businessId}/users/${managerId}/contact`).expect(403);
  });

  it('business admins can read them only with MFA, and each access is audited', async () => {
    const admin = await h.createUser({ role: 'BUSINESS_ADMIN', businessId });
    const noMfa = await h.login(admin.username);
    const blocked = await noMfa
      .get(`/api/v1/businesses/${businessId}/users/${managerId}/contact`)
      .expect(403);
    expect(blocked.body.error.code).toBe('MFA_REQUIRED');

    const withMfa = await h.loginWithMfa(admin.username);
    const res = await withMfa
      .get(`/api/v1/businesses/${businessId}/users/${managerId}/contact`)
      .expect(200);
    expect(res.body).toMatchObject({ email: MANAGER_EMAIL, phone: MANAGER_PHONE });
    const audit = await h.prisma.auditLog.findFirst({
      where: { action: 'user.contact_viewed', targetId: managerId },
    });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit?.metadata)).not.toContain(MANAGER_EMAIL);
  });

  it('another business cannot read the contact details', async () => {
    const other = (await h.createBusiness()).id;
    const otherAdmin = await h.loginWithMfa(
      (await h.createUser({ role: 'BUSINESS_ADMIN', businessId: other })).username,
    );
    await otherAdmin.get(`/api/v1/businesses/${businessId}/users/${managerId}/contact`).expect(403);
    await otherAdmin.get(`/api/v1/businesses/${other}/users/${managerId}/contact`).expect(404);
  });
});
