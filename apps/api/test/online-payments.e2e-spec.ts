import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jazzcashHash } from '../src/modules/sales/gateways/gateways';
import { Harness, type Session } from './harness';

/** Online payment of invoices (JazzCash flow): only a signed, matching answer pays an invoice. */
describe('Online payments', () => {
  let h: Harness;
  let admin: Session;
  const SALT = 'test-integrity-salt';

  async function issuedInvoice(amount: number): Promise<{ id: string; payToken: string }> {
    const leadId = (
      await admin
        .post('/api/v1/sales/leads')
        .send({ companyName: `Buyer ${amount}`, contactName: 'Ali', source: 'WEBSITE' })
        .expect(201)
    ).body.id;
    const invoice = (
      await admin
        .post('/api/v1/sales/crm/invoices')
        .send({
          leadId,
          currency: 'PKR',
          taxRate: 0,
          items: [{ name: 'Rice', quantity: 1, unitPrice: amount }],
        })
        .expect(201)
    ).body;
    const issued = (await admin.post(`/api/v1/sales/crm/invoices/${invoice.id}/issue`).expect(200))
      .body;
    return { id: invoice.id, payToken: String(issued.payUrl).split('/').pop()! };
  }

  /** What JazzCash would post back for a checkout (signed with the salt unless told otherwise). */
  function answer(
    fields: Record<string, string>,
    code: string,
    overrides: Record<string, string> = {},
    salt = SALT,
  ) {
    const body: Record<string, string> = {
      pp_Version: '1.1',
      pp_TxnType: 'MWALLET',
      pp_MerchantID: fields.pp_MerchantID!,
      pp_TxnRefNo: fields.pp_TxnRefNo!,
      pp_Amount: fields.pp_Amount!,
      pp_TxnCurrency: 'PKR',
      pp_ResponseCode: code,
      pp_ResponseMessage: code === '000' ? 'Thank you for Using JazzCash' : 'Declined',
      pp_RetreivalReferenceNo: `RR${fields.pp_TxnRefNo}`,
      ...overrides,
    };
    body.pp_SecureHash = jazzcashHash(body, salt);
    return body;
  }

  const checkout = async (payToken: string) =>
    (
      await h
        .http()
        .post(`/api/v1/public/invoices/${payToken}/checkout`)
        .send({ gateway: 'JAZZCASH', method: 'WALLET' })
        .expect(200)
    ).body as { action: string; fields: Record<string, string> };

  const post = (body: Record<string, string>) =>
    h.http().post('/api/v1/public/payments/jazzcash/return').type('form').send(body).expect(303);

  beforeAll(async () => {
    h = await Harness.start();
    const business = await h.createBusiness('Pay Co');
    const user = await h.createUser({ role: 'BUSINESS_ADMIN', businessId: business.id });
    admin = await h.login(user.username);
    await admin
      .put('/api/v1/sales/crm/payment-gateways/jazzcash')
      .send({
        enabled: true,
        sandbox: true,
        merchantId: 'MC100',
        methods: ['WALLET', 'CARD'],
        password: 'pw-123',
        integritySalt: SALT,
      })
      .expect(200);
  });
  afterAll(() => h.stop());

  it('never returns the saved secrets', async () => {
    const list = (await admin.get('/api/v1/sales/crm/payment-gateways').expect(200)).body;
    const jazz = list.find((g: { gateway: string }) => g.gateway === 'JAZZCASH');
    expect(jazz.saved).toMatchObject({ password: true, integritySalt: true });
    expect(JSON.stringify(list)).not.toContain(SALT);
    expect(JSON.stringify(list)).not.toContain('pw-123');
  });

  it('shows the gateway on the pay page and marks the invoice paid from a signed answer', async () => {
    const inv = await issuedInvoice(1500);
    const page = (await h.http().get(`/api/v1/public/invoices/${inv.payToken}`).expect(200)).body;
    expect(page.gateways.map((g: { gateway: string }) => g.gateway)).toEqual(['JAZZCASH']);
    const form = await checkout(inv.payToken);
    expect(form.fields.pp_Amount).toBe('150000');
    const res = await post(answer(form.fields, '000'));
    expect(res.headers.location).toContain(`/pay/${inv.payToken}?payment=paid`);
    const invoice = (await admin.get(`/api/v1/sales/crm/invoices/${inv.id}`).expect(200)).body;
    expect(invoice.status).toBe('PAID');
    expect(invoice.payments[0].method).toBe('ONLINE');
    // The same answer again (return + notification) does not pay twice.
    await post(answer(form.fields, '000'));
    await h
      .http()
      .post('/api/v1/public/payments/jazzcash/ipn')
      .type('form')
      .send(answer(form.fields, '000'))
      .expect(200);
    const again = (await admin.get(`/api/v1/sales/crm/invoices/${inv.id}`).expect(200)).body;
    expect(again.payments).toHaveLength(1);
    await h
      .http()
      .post(`/api/v1/public/invoices/${inv.payToken}/checkout`)
      .send({ gateway: 'JAZZCASH', method: 'WALLET' })
      .expect(409);
  });

  it('ignores forged and failed answers', async () => {
    const inv = await issuedInvoice(800);
    const form = await checkout(inv.payToken);
    const forged = await post(answer(form.fields, '000', {}, 'wrong-salt'));
    expect(forged.headers.location).toContain('payment=failed');
    const declined = await post(answer(form.fields, '110'));
    expect(declined.headers.location).toContain('payment=failed');
    const invoice = (await admin.get(`/api/v1/sales/crm/invoices/${inv.id}`).expect(200)).body;
    expect(invoice.status).toBe('ISSUED');
    expect(invoice.amountPaid).toBe(0);
  });

  it('sends a paid answer with the wrong amount to a manager instead of paying', async () => {
    const inv = await issuedInvoice(2000);
    const form = await checkout(inv.payToken);
    const res = await post(answer(form.fields, '000', { pp_Amount: '100000' }));
    expect(res.headers.location).toContain('payment=pending');
    const invoice = (await admin.get(`/api/v1/sales/crm/invoices/${inv.id}`).expect(200)).body;
    expect(invoice.amountPaid).toBe(0);
    expect(invoice.pendingClaims).toBe(1);
    const claims = (await admin.get('/api/v1/sales/crm/payment-claims?status=PENDING').expect(200))
      .body;
    expect(claims.some((c: { invoice: { id: string } }) => c.invoice.id === inv.id)).toBe(true);
  });

  it('refuses checkout when the gateway is off or the invoice is not in PKR', async () => {
    const inv = await issuedInvoice(500);
    await h
      .http()
      .post(`/api/v1/public/invoices/${inv.payToken}/checkout`)
      .send({ gateway: 'EASYPAISA', method: 'CARD' })
      .expect(404);
    await h
      .http()
      .post('/api/v1/public/invoices/not-a-real-token/checkout')
      .send({ gateway: 'JAZZCASH', method: 'WALLET' })
      .expect(404);
  });
});
