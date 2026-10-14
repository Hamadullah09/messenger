import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepPlanStatuses } from '../src/modules/sales/billing-scheduler';
import { Harness, type Session } from './harness';

/** What businesses pay SMA: trial, plans and their limits, and monthly billing in SMA's CRM. */
describe('SMA plans', () => {
  let h: Harness;
  let superAdmin: Session;

  beforeAll(async () => {
    h = await Harness.start();
    const su = await h.createUser({ role: 'SUPER_ADMIN' });
    superAdmin = await h.loginWithMfa(su.username);
  });
  afterAll(() => h.stop());

  const newBusiness = async (slug: string) =>
    (
      await superAdmin
        .post('/api/v1/businesses')
        .send({ name: `Shop ${slug}`, slug })
        .expect(201)
    ).body as { id: string };

  it('starts every new business on the free trial with its limits', async () => {
    const biz = await newBusiness('trial-shop');
    const billing = (await superAdmin.get(`/api/v1/businesses/${biz.id}/billing`).expect(200)).body;
    expect(billing.plan).toBe('TRIAL');
    expect(billing.status).toBe('TRIAL');
    expect(billing.trialEndsAt).not.toBeNull();
    const quota = await h.prisma.tenantQuota.findUniqueOrThrow({ where: { businessId: biz.id } });
    expect(quota.maxStores).toBe(3);
    expect(quota.maxUsers).toBe(50);
  });

  it('bills a paid plan monthly through SMA and applies its limits', async () => {
    const biz = await newBusiness('paying-shop');
    await h.createStore(biz.id);
    await h.createStore(biz.id);
    const plans = (await superAdmin.get('/api/v1/platform/sma-plans').expect(200)).body;
    expect(plans.find((p: { key: string }) => p.key === 'BUSINESS').price).toBe(49);
    const billing = (
      await superAdmin
        .put(`/api/v1/businesses/${biz.id}/plan`)
        .send({ plan: 'BUSINESS', autoBill: true })
        .expect(200)
    ).body;
    expect(billing).toMatchObject({
      plan: 'BUSINESS',
      status: 'ACTIVE',
      autoBilled: true,
      monthlyAmount: 98,
    });
    const sub = await h.prisma.subscription.findFirstOrThrow({
      where: { businessId: biz.id },
      include: { items: true, tenant: true },
    });
    expect(sub.tenant.internal).toBe(true); // billed by SMA's own CRM
    expect(sub.items[0]!.quantity).toBe(2); // per store
    expect(
      (await h.prisma.tenantQuota.findUniqueOrThrow({ where: { businessId: biz.id } })).maxStores,
    ).toBe(25);

    // Back to the trial stops the monthly bill.
    await superAdmin.put(`/api/v1/businesses/${biz.id}/plan`).send({ plan: 'TRIAL' }).expect(200);
    expect((await h.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe(
      'CANCELLED',
    );
  });

  it('enforces plan limits (Starter: one store)', async () => {
    const biz = await newBusiness('starter-shop');
    await superAdmin
      .put(`/api/v1/businesses/${biz.id}/plan`)
      .send({ plan: 'STARTER', autoBill: false })
      .expect(200);
    await superAdmin
      .post(`/api/v1/businesses/${biz.id}/stores`)
      .send({ code: 'S1', name: 'First' })
      .expect(201);
    const second = await superAdmin
      .post(`/api/v1/businesses/${biz.id}/stores`)
      .send({ code: 'S2', name: 'Second' })
      .expect(409);
    expect(second.body.error.message).toContain('limit of 1 stores');
  });

  it('lets business admins see their plan but not change it', async () => {
    const biz = await newBusiness('admin-view');
    const admin = await h.createUser({ role: 'BUSINESS_ADMIN', businessId: biz.id });
    const session = await h.login(admin.username);
    const billing = (await session.get(`/api/v1/businesses/${biz.id}/billing`).expect(200)).body;
    expect(billing.canChangePlan).toBe(false);
    await session.put(`/api/v1/businesses/${biz.id}/plan`).send({ plan: 'ENTERPRISE' }).expect(403);
    await session.get('/api/v1/platform/sma-plans').expect(403);
    const other = await newBusiness('someone-else');
    await session.get(`/api/v1/businesses/${other.id}/billing`).expect(404);
  });

  it('marks ended trials and overdue SMA invoices as past due, and clears it when paid', async () => {
    const biz = await newBusiness('late-payer');
    await h.prisma.businessPlan.update({
      where: { businessId: biz.id },
      data: { trialEndsAt: new Date(Date.now() - 1000) },
    });
    await sweepPlanStatuses(h.prisma as never);
    expect(
      (await h.prisma.businessPlan.findUniqueOrThrow({ where: { businessId: biz.id } })).status,
    ).toBe('PAST_DUE');

    await superAdmin
      .put(`/api/v1/businesses/${biz.id}/plan`)
      .send({ plan: 'ENTERPRISE', autoBill: false })
      .expect(200);
    const sma = await h.prisma.business.findFirstOrThrow({ where: { internal: true } });
    const invoice = await h.prisma.invoice.create({
      data: {
        tenantId: sma.id,
        number: 'INV-TEST-1',
        businessId: biz.id,
        billToName: 'Late payer',
        issueDate: new Date(Date.now() - 40 * 86_400_000),
        dueDate: new Date(Date.now() - 30 * 86_400_000),
        currency: 'USD',
        subtotal: 499,
        total: 499,
        status: 'ISSUED',
      },
    });
    await sweepPlanStatuses(h.prisma as never);
    expect(
      (await h.prisma.businessPlan.findUniqueOrThrow({ where: { businessId: biz.id } })).status,
    ).toBe('PAST_DUE');
    await h.prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: 'PAID', amountPaid: 499 },
    });
    await sweepPlanStatuses(h.prisma as never);
    expect(
      (await h.prisma.businessPlan.findUniqueOrThrow({ where: { businessId: biz.id } })).status,
    ).toBe('ACTIVE');
  });
});
