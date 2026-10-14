import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { FollowUpReminders } from '../src/modules/sales/follow-up-reminders';
import { Harness, type Session } from './harness';

/**
 * Every business has its own Sales & Marketing (CRM). Nothing of one business may be read,
 * changed or referenced by another — through ids, the X-Business-Id hint, or public links.
 */
describe('CRM per business (tenant isolation)', () => {
  let h: Harness;
  let a: { id: string; slug: string };
  let b: { id: string; slug: string };
  let adminA: Session;
  let adminB: Session;
  let agentA: Session;
  let agentAId: string;
  let adminBId: string;
  /** Business A's records, created through the API. */
  const ofA = {} as {
    serviceId: string;
    leadId: string;
    dealId: string;
    invoiceId: string;
    payToken: string;
    quoteId: string;
    quoteToken: string;
    subscriptionId: string;
  };

  const month = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  };

  beforeAll(async () => {
    h = await Harness.start({ worker: true });
    a = await h.createBusiness('Alpha Traders');
    b = await h.createBusiness('Bravo Foods');
    const ua = await h.createUser({ role: 'BUSINESS_ADMIN', businessId: a.id });
    const ub = await h.createUser({ role: 'BUSINESS_ADMIN', businessId: b.id });
    const ag = await h.createUser({ role: 'SALES_AGENT', businessId: a.id });
    agentAId = ag.id;
    adminBId = ub.id;
    adminA = await h.login(ua.username);
    adminB = await h.login(ub.username);
    agentA = await h.login(ag.username);

    // Business A's CRM: a service, a lead, a deal, a quote, an invoice with a payment, billing.
    ofA.serviceId = (
      await adminA
        .post('/api/v1/sales/crm/services')
        .send({ name: 'Bulk rice', price: 7800, currency: 'PKR', billing: 'ONE_TIME' })
        .expect(201)
    ).body.find((s: { name: string }) => s.name === 'Bulk rice').id;
    ofA.leadId = (
      await adminA
        .post('/api/v1/sales/leads')
        .send({ companyName: 'Alpha Customer', contactName: 'Sara', source: 'REFERRAL' })
        .expect(201)
    ).body.id;
    ofA.dealId = (
      await adminA
        .post('/api/v1/sales/crm/deals')
        .send({
          title: 'Rice order',
          type: 'NEW_BUSINESS',
          leadId: ofA.leadId,
          currency: 'PKR',
          items: [{ serviceId: ofA.serviceId, name: 'Bulk rice', quantity: 2, unitPrice: 7800 }],
        })
        .expect(201)
    ).body.id;
    const quote = (
      await adminA.post('/api/v1/sales/crm/quotes').send({ dealId: ofA.dealId }).expect(201)
    ).body;
    ofA.quoteId = quote.id;
    ofA.quoteToken = String(quote.publicUrl).split('/').pop()!;
    await adminA
      .post(`/api/v1/sales/crm/quotes/${ofA.quoteId}/send`)
      .send({ email: false })
      .expect(200);
    ofA.invoiceId = (
      await adminA.post('/api/v1/sales/crm/invoices').send({ dealId: ofA.dealId }).expect(201)
    ).body.id;
    const issued = (
      await adminA.post(`/api/v1/sales/crm/invoices/${ofA.invoiceId}/issue`).expect(200)
    ).body;
    ofA.payToken = String(issued.payUrl).split('/').pop()!;
    await adminA.put(`/api/v1/sales/leads/${ofA.leadId}/stage`).send({ stage: 'WON' }).expect(200);
    ofA.subscriptionId = (
      await adminA
        .post('/api/v1/sales/crm/subscriptions')
        .send({
          leadId: ofA.leadId,
          name: 'Monthly rice',
          interval: 'MONTHLY',
          startDate: new Date(Date.now() + 86_400_000).toISOString(),
          items: [{ name: 'Bulk rice', quantity: 1, unitPrice: 7800 }],
        })
        .expect(201)
    ).body.id;
  });
  afterAll(() => h.stop());

  it('opens each admin in their own business, whatever business the client names', async () => {
    const ctxA = (await adminA.get('/api/v1/sales/context').expect(200)).body;
    const ctxB = (await adminB.get('/api/v1/sales/context').expect(200)).body;
    expect(ctxA.teamBusinessId).toBe(a.id);
    expect(ctxB.teamBusinessId).toBe(b.id);
    expect(ctxA.platformTeam).toBe(false);
    // Naming another business (X-Business-Id) does not open its CRM.
    const spoofed = (
      await adminB.get('/api/v1/sales/context').set('X-Business-Id', a.id).expect(200)
    ).body;
    expect(spoofed.teamBusinessId).toBe(b.id);
    const leads = (await adminB.get('/api/v1/sales/leads').set('X-Business-Id', a.id).expect(200))
      .body;
    expect(leads).toEqual([]);
  });

  it("never lists another business's records", async () => {
    for (const path of [
      '/api/v1/sales/leads',
      '/api/v1/sales/crm/services',
      '/api/v1/sales/crm/deals',
      '/api/v1/sales/crm/invoices',
      '/api/v1/sales/crm/quotes',
      '/api/v1/sales/crm/subscriptions',
      '/api/v1/sales/crm/customers',
      '/api/v1/sales/crm/payment-claims',
    ]) {
      const body = (await adminB.get(path).expect(200)).body;
      expect(body, path).toEqual([]);
    }
    const agenda = await adminB
      .get(`/api/v1/sales/agenda?until=${new Date(Date.now() + 7 * 86_400_000).toISOString()}`)
      .expect(200);
    expect(agenda.body).toEqual([]);
    const overview = (await adminB.get('/api/v1/sales/crm/overview').expect(200)).body;
    expect(overview.openDeals).toBe(0);
    expect(overview.outstanding).toBe(0);
  });

  it("cannot read or change another business's records by id", async () => {
    await adminB.get(`/api/v1/sales/leads/${ofA.leadId}`).expect(404);
    await adminB.patch(`/api/v1/sales/leads/${ofA.leadId}`).send({ notes: 'x' }).expect(404);
    await adminB
      .put(`/api/v1/sales/leads/${ofA.leadId}/stage`)
      .send({ stage: 'LOST', lostReason: 'x' })
      .expect(404);
    await adminB
      .post(`/api/v1/sales/leads/${ofA.leadId}/activities`)
      .send({ type: 'NOTE', body: 'x' })
      .expect(404);
    await adminB.delete(`/api/v1/sales/leads/${ofA.leadId}`).expect(404);
    await adminB.get(`/api/v1/sales/crm/deals/${ofA.dealId}`).expect(404);
    await adminB.patch(`/api/v1/sales/crm/deals/${ofA.dealId}`).send({ title: 'x' }).expect(404);
    await adminB
      .put(`/api/v1/sales/crm/deals/${ofA.dealId}/status`)
      .send({ status: 'LOST', lostReason: 'x' })
      .expect(404);
    await adminB.get(`/api/v1/sales/crm/invoices/${ofA.invoiceId}`).expect(404);
    await adminB
      .patch(`/api/v1/sales/crm/invoices/${ofA.invoiceId}`)
      .send({ notes: 'x' })
      .expect(404);
    await adminB
      .post(`/api/v1/sales/crm/invoices/${ofA.invoiceId}/void`)
      .send({ reason: 'x' })
      .expect(404);
    await adminB
      .post(`/api/v1/sales/crm/invoices/${ofA.invoiceId}/payments`)
      .send({ amount: 1, method: 'CASH' })
      .expect(404);
    await adminB.get(`/api/v1/sales/crm/quotes/${ofA.quoteId}`).expect(404);
    await adminB.delete(`/api/v1/sales/crm/quotes/${ofA.quoteId}`).expect(404);
    await adminB
      .patch(`/api/v1/sales/crm/subscriptions/${ofA.subscriptionId}`)
      .send({ status: 'CANCELLED' })
      .expect(404);
    await adminB
      .patch(`/api/v1/sales/crm/services/${ofA.serviceId}`)
      .send({ name: 'Hijacked', price: 1, currency: 'PKR', billing: 'ONE_TIME' })
      .expect(404);
    // Business A's records are untouched.
    const lead = (await adminA.get(`/api/v1/sales/leads/${ofA.leadId}`).expect(200)).body;
    expect(lead.stage).toBe('WON');
    const invoice = (await adminA.get(`/api/v1/sales/crm/invoices/${ofA.invoiceId}`).expect(200))
      .body;
    expect(invoice.status).toBe('ISSUED');
    expect(invoice.amountPaid).toBe(0);
  });

  it("cannot use another business's leads, deals, services or people in its own records", async () => {
    await adminB
      .post('/api/v1/sales/crm/deals')
      .send({
        title: 'x',
        type: 'NEW_BUSINESS',
        leadId: ofA.leadId,
        items: [{ name: 'x', quantity: 1, unitPrice: 1 }],
      })
      .expect(400);
    await adminB
      .post('/api/v1/sales/crm/deals')
      .send({
        title: 'x',
        type: 'NEW_BUSINESS',
        leadId: (
          await adminB
            .post('/api/v1/sales/leads')
            .send({ companyName: 'Bravo Lead', contactName: 'Ali', source: 'WEBSITE' })
            .expect(201)
        ).body.id,
        items: [{ serviceId: ofA.serviceId, name: 'x', quantity: 1, unitPrice: 1 }],
      })
      .expect(400);
    await adminB.post('/api/v1/sales/crm/invoices').send({ dealId: ofA.dealId }).expect(404);
    await adminB.post('/api/v1/sales/crm/quotes').send({ dealId: ofA.dealId }).expect(404);
    await adminB
      .post('/api/v1/sales/crm/invoices')
      .send({ leadId: ofA.leadId, items: [{ name: 'x', quantity: 1, unitPrice: 1 }] })
      .expect(400);
    await adminB
      .post('/api/v1/sales/crm/subscriptions')
      .send({
        leadId: ofA.leadId,
        name: 'x',
        interval: 'MONTHLY',
        startDate: new Date(Date.now() + 86_400_000).toISOString(),
        items: [{ name: 'x', quantity: 1, unitPrice: 1 }],
      })
      .expect(400);
    // People of business A cannot own B's leads or get B's targets, and the reverse.
    await adminB
      .put('/api/v1/sales/crm/targets')
      .send({ userId: agentAId, month: month(), amount: 1000 })
      .expect(400);
    await adminA
      .put('/api/v1/sales/crm/targets')
      .send({ userId: adminBId, month: month(), amount: 1000 })
      .expect(400);
    await adminB
      .post('/api/v1/sales/leads')
      .send({ companyName: 'Owned', contactName: 'X', source: 'WEBSITE', ownerId: agentAId })
      .expect(400);
    await adminB
      .put('/api/v1/sales/crm/commission-plans')
      .send({ scope: agentAId, baseRate: 1, bonusRate: 2, basis: 'WON' })
      .expect(400);
  });

  it('keeps settings and invoice numbers per business', async () => {
    await adminA
      .put('/api/v1/sales/crm/settings')
      .send({ companyName: 'Alpha Traders Ltd', taxRate: 18 })
      .expect(200);
    await adminB
      .put('/api/v1/sales/crm/settings')
      .send({ companyName: 'Bravo Foods Pvt', taxRate: 5 })
      .expect(200);
    expect((await adminA.get('/api/v1/sales/crm/settings').expect(200)).body.companyName).toBe(
      'Alpha Traders Ltd',
    );
    expect((await adminB.get('/api/v1/sales/crm/settings').expect(200)).body.taxRate).toBe(5);
    // Public pay and quote pages show the issuing business.
    const pay = (await h.http().get(`/api/v1/public/invoices/${ofA.payToken}`).expect(200)).body;
    expect(pay.company.name).toBe('Alpha Traders Ltd');
    const quote = (await h.http().get(`/api/v1/public/quotes/${ofA.quoteToken}`).expect(200)).body;
    expect(quote.company.name).toBe('Alpha Traders Ltd');
    // Numbering restarts for each business.
    const bLead = (
      await adminB
        .post('/api/v1/sales/leads')
        .send({ companyName: 'Bravo Buyer', contactName: 'Z', source: 'WEBSITE' })
        .expect(201)
    ).body.id;
    const bInvoice = (
      await adminB
        .post('/api/v1/sales/crm/invoices')
        .send({ leadId: bLead, items: [{ name: 'Bread', quantity: 1, unitPrice: 100 }] })
        .expect(201)
    ).body;
    const aInvoice = (await adminA.get(`/api/v1/sales/crm/invoices/${ofA.invoiceId}`).expect(200))
      .body;
    expect(bInvoice.number.endsWith('00001')).toBe(true);
    expect(aInvoice.number.endsWith('00001')).toBe(true);
  });

  it("lands each website form's leads in that business only", async () => {
    await h
      .http()
      .post('/api/v1/public/leads')
      .send({
        companyName: 'Web Buyer',
        contactName: 'Nida',
        email: 'nida@example.com',
        business: b.slug,
      })
      .expect(202);
    const bLeads = (await adminB.get('/api/v1/sales/leads?q=Web%20Buyer').expect(200)).body;
    const aLeads = (await adminA.get('/api/v1/sales/leads?q=Web%20Buyer').expect(200)).body;
    expect(bLeads).toHaveLength(1);
    expect(aLeads).toHaveLength(0);
    await h
      .http()
      .post('/api/v1/public/leads')
      .send({
        companyName: 'Nobody',
        contactName: 'N',
        email: 'n@example.com',
        business: 'no-such-business',
      })
      .expect(404);
  });

  it('lets agents work only their own and unassigned leads, and keeps staff out', async () => {
    const own = (
      await agentA
        .post('/api/v1/sales/leads')
        .send({ companyName: 'Agent Lead', contactName: 'Q', source: 'COLD_CALL' })
        .expect(201)
    ).body;
    const visible = (await agentA.get('/api/v1/sales/leads').expect(200)).body.map(
      (l: { id: string }) => l.id,
    );
    expect(visible).toContain(own.id);
    expect(visible).not.toContain(ofA.leadId); // the admin's own lead
    await agentA.get(`/api/v1/sales/leads/${ofA.leadId}`).expect(404);
    const storeId = (await h.createStore(a.id)).id;
    const staff = await h.createUser({ role: 'EMPLOYEE', businessId: a.id, storeIds: [storeId] });
    const staffSession = await h.login(staff.username);
    await staffSession.get('/api/v1/sales/context').expect(403);
    await staffSession.get('/api/v1/sales/leads').expect(403);
  });

  it('reminds the owner once, 15 minutes before a planned follow-up', async () => {
    const soon = new Date(Date.now() + 10 * 60_000).toISOString();
    await adminA
      .patch(`/api/v1/sales/leads/${ofA.leadId}`)
      .send({
        nextFollowUpAt: soon,
        nextFollowUpKind: 'MEETING',
        nextFollowUpNote: 'At their office',
      })
      .expect(200);
    const worker = h.worker as INestApplicationContext;
    const reminders = worker.get(FollowUpReminders);
    expect(await reminders.run()).toBe(1);
    expect(await reminders.run()).toBe(0); // already reminded for this time
    // A new time gets a new reminder.
    await adminA
      .patch(`/api/v1/sales/leads/${ofA.leadId}`)
      .send({ nextFollowUpAt: new Date(Date.now() + 12 * 60_000).toISOString() })
      .expect(200);
    expect(await reminders.run()).toBe(1);
    // Not yet due (an hour away): no reminder.
    await adminA
      .patch(`/api/v1/sales/leads/${ofA.leadId}`)
      .send({ nextFollowUpAt: new Date(Date.now() + 60 * 60_000).toISOString() })
      .expect(200);
    expect(await reminders.run()).toBe(0);
  });
});
