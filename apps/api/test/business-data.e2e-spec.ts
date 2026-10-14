import type { INestApplicationContext } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BusinessPurger } from '../src/modules/tenancy/business-purger';
import { Harness, uuid, type Session } from './harness';

/** A business that leaves: full data export, closure request, and erasure 30 days after deletion. */
describe('Business data export and erasure', () => {
  let h: Harness;
  let superAdmin: Session;
  let owner: Session;
  let businessId: string;
  let otherBusinessId: string;
  let soloUserId: string;
  let sharedUserId: string;

  beforeAll(async () => {
    h = await Harness.start({ worker: true });
    superAdmin = await h.loginWithMfa((await h.createUser({ role: 'SUPER_ADMIN' })).username);
    businessId = (
      await superAdmin
        .post('/api/v1/businesses')
        .send({ name: 'Leaving Co', slug: 'leaving-co' })
        .expect(201)
    ).body.id;
    otherBusinessId = (await h.createBusiness('Staying Co')).id;
    const storeId = (await h.createStore(businessId)).id;
    const o = await h.createUser({
      role: 'BUSINESS_OWNER',
      businessId,
      email: 'owner@leaving.example.com',
    });
    owner = await h.loginWithMfa(o.username);
    const solo = await h.createUser({ role: 'EMPLOYEE', businessId, storeIds: [storeId] });
    soloUserId = solo.id;
    // Works for both businesses: must keep their account.
    const shared = await h.createUser({ role: 'EMPLOYEE', businessId, storeIds: [storeId] });
    sharedUserId = shared.id;
    await h.prisma.businessMembership.create({
      data: { businessId: otherBusinessId, userId: shared.id },
    });

    // Some data: a chat with messages, a customer, a lead and an invoice of its own CRM.
    const chat = (
      await owner
        .post('/api/v1/conversations/direct')
        .send({ businessId, userId: solo.id })
        .expect(201)
    ).body;
    for (const body of ['Hello', 'Stock count tomorrow'])
      await owner
        .post(`/api/v1/conversations/${chat.id}/messages`)
        .send({ clientMessageId: uuid(), body })
        .expect(201);
    await owner
      .post(`/api/v1/businesses/${businessId}/customers`)
      .send({ name: 'Walk-in Customer', phone: '+923005551234', marketingOptIn: false })
      .expect(201);
    const lead = (
      await owner
        .post('/api/v1/sales/leads')
        .set('X-Business-Id', businessId)
        .send({ companyName: 'Their Client', contactName: 'Z', source: 'WEBSITE' })
        .expect(201)
    ).body;
    await owner
      .post('/api/v1/sales/crm/invoices')
      .set('X-Business-Id', businessId)
      .send({ leadId: lead.id, items: [{ name: 'Service', quantity: 1, unitPrice: 100 }] })
      .expect(201);
  });
  afterAll(() => h.stop());

  it('exports everything to the owner, and to nobody else', async () => {
    const res = await owner
      .get(`/api/v1/businesses/${businessId}/export.json`)
      .buffer(true)
      .parse((r, cb) => {
        let text = '';
        r.on('data', (c: Buffer) => (text += c.toString()));
        r.on('end', () => cb(null, text));
      })
      .expect(200);
    expect(res.headers['content-disposition']).toContain('sma-export-leaving-co');
    const data = JSON.parse(res.body as string);
    expect(data.business.name).toBe('Leaving Co');
    expect(data.messages.map((m: { body: string }) => m.body)).toEqual(
      expect.arrayContaining(['Hello', 'Stock count tomorrow']),
    );
    expect(data.storeCustomers).toHaveLength(1);
    expect(data.leads).toHaveLength(1);
    expect(data.invoices).toHaveLength(1);
    expect(JSON.stringify(data.invoices)).not.toContain('payToken');
    const outsider = await h.login(
      (await h.createUser({ role: 'BUSINESS_ADMIN', businessId: otherBusinessId })).username,
    );
    await outsider.get(`/api/v1/businesses/${businessId}/export.json`).expect(404);
  });

  it('records and cancels a closure request', async () => {
    const asked = (
      await owner
        .post(`/api/v1/businesses/${businessId}/closure`)
        .send({ reason: 'Moving systems' })
        .expect(201)
    ).body;
    expect(asked.closureRequestedAt).not.toBeNull();
    const cancelled = (await owner.delete(`/api/v1/businesses/${businessId}/closure`).expect(200))
      .body;
    expect(cancelled.closureRequestedAt).toBeNull();
  });

  it('erases the data 30 days after deletion, keeping SMA invoices and shared people', async () => {
    const sma = await h.prisma.business.findFirstOrThrow({ where: { internal: true } });
    const smaInvoice = await h.prisma.invoice.create({
      data: {
        tenantId: sma.id,
        number: 'INV-SMA-1',
        businessId,
        billToName: 'Leaving Co',
        issueDate: new Date(),
        dueDate: new Date(),
        currency: 'USD',
        subtotal: 49,
        total: 49,
        status: 'PAID',
        amountPaid: 49,
      },
    });
    await superAdmin.delete(`/api/v1/businesses/${businessId}`).expect(204);
    const purger = (h.worker as INestApplicationContext).get(BusinessPurger);
    expect(await purger.runOnce()).toBe(0); // not before 30 days
    await h.prisma.business.update({
      where: { id: businessId },
      data: { deletedAt: new Date(Date.now() - 31 * 86_400_000) },
    });
    expect(await purger.runOnce()).toBe(1);

    const count = async (table: string, column = 'businessId') =>
      Number(
        (
          await h.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
            `SELECT count(*) AS n FROM "${table}" WHERE "${column}" = $1::uuid`,
            businessId,
          )
        )[0]!.n,
      );
    for (const table of [
      'Conversation',
      'Store',
      'StoreCustomer',
      'MediaAsset',
      'BusinessMembership',
      'RoleAssignment',
      'StoreTask',
    ])
      expect(await count(table), table).toBe(0);
    for (const table of ['Lead', 'Invoice', 'Deal', 'CrmService'])
      expect(await count(table, 'tenantId'), table).toBe(0);
    expect(await h.prisma.message.count({ where: { conversation: { businessId } } })).toBe(0);

    const business = await h.prisma.business.findUniqueOrThrow({ where: { id: businessId } });
    expect(business.name).toBe('Deleted business');
    expect(business.purgedAt).not.toBeNull();
    expect(await h.prisma.invoice.findUnique({ where: { id: smaInvoice.id } })).not.toBeNull();

    const solo = await h.prisma.user.findUniqueOrThrow({ where: { id: soloUserId } });
    expect(solo.displayName).toBe('Deleted user');
    expect(solo.username.startsWith('deleted-')).toBe(true);
    const shared = await h.prisma.user.findUniqueOrThrow({ where: { id: sharedUserId } });
    expect(shared.displayName).not.toBe('Deleted user');
    expect(
      await h.prisma.userContact.count({
        where: { user: { username: { startsWith: 'deleted-' } } },
      }),
    ).toBe(0);
    // Running again does nothing.
    expect(await purger.runOnce()).toBe(0);
  });
});
