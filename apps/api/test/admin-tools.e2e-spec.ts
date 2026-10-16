import type {
  BulkImportPreviewDto,
  FinanceDashboardDto,
  LeadImportPreviewDto,
} from '@storeline/shared';
import { LEAD_IMPORT_FIELDS, importColumns } from '@storeline/shared';
import ExcelJS from 'exceljs';
import type { Test } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dueByDay } from '../src/modules/sales/crm-core';
import { Harness, uuid, type Session } from './harness';

/** Reads a binary (xlsx) response body. */
const binary: Parameters<Test['parse']>[0] = (res, done) => {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => done(null, Buffer.concat(chunks)));
};

async function workbookRows(buffer: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const rows: string[][] = [];
  wb.worksheets[0]!.eachRow((r) => {
    rows.push((r.values as unknown[]).slice(1).map((v) => String(v ?? '')));
  });
  return rows;
}

async function xlsxOf(rows: string[][]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

/**
 * Super Admin tools added for launch: feature switches, Excel uploads with sample files,
 * admin-only exports, and the accountant's Accounts tab.
 */
describe('Features, uploads, exports and accounts', () => {
  let h: Harness;
  let superAdmin: Session;
  let business: { id: string; slug: string };
  let admin: Session;
  let manager: Session;
  let accountant: Session;
  let employee: Session;

  beforeAll(async () => {
    h = await Harness.start();
    superAdmin = await h.loginWithMfa((await h.createUser({ role: 'SUPER_ADMIN' })).username);
    business = await h.createBusiness('Delta Mart');
    const store = await h.createStore(business.id);
    admin = await h.loginWithMfa(
      (await h.createUser({ role: 'BUSINESS_ADMIN', businessId: business.id })).username,
    );
    manager = await h.login(
      (await h.createUser({ role: 'SALES_MANAGER', businessId: business.id })).username,
    );
    accountant = await h.login(
      (await h.createUser({ role: 'ACCOUNTANT', businessId: business.id })).username,
    );
    employee = await h.login(
      (await h.createUser({ role: 'EMPLOYEE', businessId: business.id, storeIds: [store.id] }))
        .username,
    );
  });
  afterAll(async () => {
    await superAdmin
      .put('/api/v1/platform/features')
      .send({ features: { STATUS: true, CALLS: true, ONLINE_PAYMENTS: true } });
    await h.stop();
  });

  it('switches Status, calls and online payments off and on (Super Admin only)', async () => {
    expect((await employee.get('/api/v1/features').expect(200)).body).toEqual({
      STATUS: true,
      CALLS: true,
      ONLINE_PAYMENTS: true,
    });
    await admin
      .put('/api/v1/platform/features')
      .send({ features: { STATUS: false } })
      .expect(403);
    const off = await superAdmin
      .put('/api/v1/platform/features')
      .send({ features: { STATUS: false, CALLS: false } })
      .expect(200);
    expect(off.body).toEqual({ STATUS: false, CALLS: false, ONLINE_PAYMENTS: true });
    expect((await employee.get('/api/v1/features').expect(200)).body.STATUS).toBe(false);
    await employee.get('/api/v1/status').query({ businessId: business.id }).expect(409);
    await employee
      .post('/api/v1/calls')
      .send({ conversationId: uuid(), media: 'audio' })
      .expect(409);

    await superAdmin
      .put('/api/v1/platform/features')
      .send({ features: { STATUS: true, CALLS: true } })
      .expect(200);
    await employee.get('/api/v1/status').query({ businessId: business.id }).expect(200);
    // On again: the call request now fails for its own reason (no such chat), not the switch.
    const call = await employee
      .post('/api/v1/calls')
      .send({ conversationId: uuid(), media: 'audio' });
    expect(call.status).not.toBe(409);
    const audit = await h.prisma.auditLog.findMany({
      where: { action: 'platform.features_changed' },
    });
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it('serves sample files that match the upload columns (leads read back every field)', async () => {
    for (const kind of ['leads', 'businesses', 'stores'] as const) {
      const res = await employee
        .get(`/api/v1/imports/${kind}/sample.xlsx`)
        .buffer(true)
        .parse(binary)
        .expect(200);
      expect(res.headers['content-type']).toContain('spreadsheetml');
      const rows = await workbookRows(res.body as Buffer);
      expect(rows[0]).toEqual(importColumns(kind).map((c) => c.label));
      expect(rows).toHaveLength(2); // headings + one example row
    }
    await employee.get('/api/v1/imports/nonsense/sample.xlsx').expect(404);

    // The lead sample, uploaded as is, maps every lead field.
    const sample = await manager
      .get('/api/v1/imports/leads/sample.xlsx')
      .buffer(true)
      .parse(binary)
      .expect(200);
    const preview = (
      await manager
        .post('/api/v1/sales/crm/leads/import/preview')
        .send({
          fileName: 'leads.xlsx',
          contentBase64: (sample.body as Buffer).toString('base64'),
        })
        .expect(200)
    ).body as LeadImportPreviewDto;
    expect(Object.keys(preview.mapping).sort()).toEqual([...LEAD_IMPORT_FIELDS].sort());
    expect(preview.rows[0]!.errors).toEqual([]);
  });

  it('creates businesses and stores from an Excel file, row by row', async () => {
    const businesses = await xlsxOf([
      ['Business name', 'Short name', 'Phone', 'Website', 'City', 'Country'],
      ['Echo Foods', '', '0300 1234567', 'echo.example.com', 'Lahore', 'Pakistan'],
      ['Foxtrot Pharmacy', 'foxtrot', '', '', 'Karachi', 'PK'],
      ['X', 'bad slug!', '', '', '', ''],
      ['Delta again', business.slug, '', '', '', ''],
    ]);
    await admin
      .post('/api/v1/imports/businesses/preview')
      .send({ fileName: 'b.xlsx', contentBase64: businesses })
      .expect(403);
    const preview = (
      await superAdmin
        .post('/api/v1/imports/businesses/preview')
        .send({ fileName: 'b.xlsx', contentBase64: businesses })
        .expect(200)
    ).body as BulkImportPreviewDto;
    expect(preview.rows.map((r) => r.errors.length > 0)).toEqual([false, false, true, true]);
    expect(preview.rows[0]!.values.slug).toBe('echo-foods');
    expect(preview.rows[3]!.errors.join()).toContain('already used');
    const result = await superAdmin
      .post('/api/v1/imports/businesses')
      .send({ rows: preview.rows.map((r) => ({ row: r.row, values: r.values })) })
      .expect(200);
    expect(result.body.created).toBe(2);
    expect(result.body.failed.map((f: { row: number }) => f.row)).toEqual([4, 5]);
    const echo = await h.prisma.business.findUniqueOrThrow({ where: { slug: 'echo-foods' } });
    expect(echo).toMatchObject({ phone: '+923001234567', website: 'https://echo.example.com' });
    expect(echo.address).toMatchObject({ city: 'Lahore', country: 'PK' });

    const stores = await xlsxOf([
      ['Store name', 'Store code', 'Time zone'],
      ['Gulberg Branch', 'lhr-01', 'Asia/Karachi'],
      ['DHA Branch', 'LHR-01', ''],
      ['Mall Road', '', ''],
    ]);
    await employee
      .post(`/api/v1/imports/stores/${business.id}/preview`)
      .send({ fileName: 's.xlsx', contentBase64: stores })
      .expect(403);
    const sp = (
      await admin
        .post(`/api/v1/imports/stores/${business.id}/preview`)
        .send({ fileName: 's.xlsx', contentBase64: stores })
        .expect(200)
    ).body as BulkImportPreviewDto;
    expect(sp.rows.map((r) => r.errors.length > 0)).toEqual([false, true, true]);
    expect(sp.rows[1]!.errors.join()).toContain('row 2');
    const created = await admin
      .post(`/api/v1/imports/stores/${business.id}`)
      .send({
        rows: sp.rows
          .filter((r) => !r.errors.length)
          .map((r) => ({ row: r.row, values: r.values })),
      })
      .expect(200);
    expect(created.body).toEqual({ created: 1, failed: [] });
    expect(await h.prisma.store.count({ where: { businessId: business.id, code: 'LHR-01' } })).toBe(
      1,
    );
    // A file without the required column is refused with a clear reason.
    const noCode = await admin
      .post(`/api/v1/imports/stores/${business.id}/preview`)
      .send({ fileName: 's.csv', contentBase64: Buffer.from('Store name\nA\n').toString('base64') })
      .expect(400);
    expect(noCode.body.error.message).toContain('Store code');
  });

  it('lets only admins export (or people given the export right)', async () => {
    await manager.get('/api/v1/sales/leads-export.csv').expect(403);
    await admin.get('/api/v1/sales/leads-export.csv').expect(200);
    await admin.get(`/api/v1/businesses/${business.id}/customers-export.csv`).expect(200);
  });

  it('gives the accountant the Accounts tab and payment reminders', async () => {
    // A customer with an unpaid invoice that is 12 days late.
    const lead = (
      await admin
        .post('/api/v1/sales/leads')
        .send({
          companyName: 'Golf Stores',
          contactName: 'Hina',
          email: 'hina@example.com',
          source: 'REFERRAL',
        })
        .expect(201)
    ).body.id as string;
    const deal = (
      await admin
        .post('/api/v1/sales/crm/deals')
        .send({
          title: 'Setup',
          type: 'NEW_BUSINESS',
          leadId: lead,
          currency: 'PKR',
          items: [{ name: 'Setup', quantity: 1, unitPrice: 5000 }],
        })
        .expect(201)
    ).body.id as string;
    const invoice = (
      await admin.post('/api/v1/sales/crm/invoices').send({ dealId: deal }).expect(201)
    ).body.id as string;
    await admin.post(`/api/v1/sales/crm/invoices/${invoice}/issue`).expect(200);
    await h.prisma.invoice.update({
      where: { id: invoice },
      data: {
        issueDate: new Date(Date.now() - 20 * 86_400_000),
        dueDate: new Date(Date.now() - 12 * 86_400_000),
      },
    });

    await employee.get('/api/v1/sales/crm/finance').expect(403);
    const d = (await accountant.get('/api/v1/sales/crm/finance').expect(200))
      .body as FinanceDashboardDto;
    expect(d.overdueCount).toBe(1);
    expect(d.unpaid[0]).toMatchObject({ id: invoice, customer: 'Golf Stores', balance: 5000 });
    expect(d.unpaid[0]!.daysLate).toBeGreaterThanOrEqual(11);
    // Totals are in the business's main currency (converted with its rate).
    expect(d.aging.days1to30).toBe(d.overdue);
    expect(d.overdue).toBeGreaterThan(0);
    expect(d.canRemind).toBe(true);
    // Accountants see money, not leads.
    await accountant.get('/api/v1/sales/leads-export.csv').expect(403);

    const sent = await accountant
      .post('/api/v1/sales/crm/finance/remind')
      .send({ invoiceIds: [] })
      .expect(200);
    expect(sent.body.reminded + sent.body.failed).toBe(1);
    expect(
      await h.prisma.auditLog.count({ where: { action: 'sales.payment_reminders_sent' } }),
    ).toBe(1);

    // Default: monthly payments due from the 1st to the 10th, an email on the due date.
    expect(d.paymentDueDay).toBe(10);
    expect(d.reminderDays).toEqual([0, 7, 14]);
    // Turned off: each subscription's own number of days; then back to the 10th.
    await accountant.put('/api/v1/sales/crm/settings').send({ paymentDueDay: null }).expect(200);
    expect(
      ((await accountant.get('/api/v1/sales/crm/finance').expect(200)).body as FinanceDashboardDto)
        .paymentDueDay,
    ).toBeNull();
    await accountant.put('/api/v1/sales/crm/settings').send({ paymentDueDay: 10 }).expect(200);
    expect(
      ((await accountant.get('/api/v1/sales/crm/finance').expect(200)).body as FinanceDashboardDto)
        .paymentDueDay,
    ).toBe(10);
  });

  it('lets admins give "Can export data" to others', async () => {
    const agentUser = await h.createUser({ role: 'SALES_AGENT', businessId: business.id });
    // Exporting is a privileged right: it needs two-step verification when that is required.
    const agent = await h.loginWithMfa(agentUser.username);
    const url = `/api/v1/businesses/${business.id}/users/${agentUser.id}/export-access`;
    // A sales manager is not an admin: cannot give it.
    await manager.put(url).send({ allowed: true }).expect(403);
    await agent.get('/api/v1/sales/leads-export.csv').expect(403);
    const given = await admin.put(url).send({ allowed: true }).expect(200);
    expect(given.body.roles.map((r: { roleKey: string }) => r.roleKey)).toContain('data-export');
    // They export what they can see: an agent, only their own leads.
    const csv = await agent.get('/api/v1/sales/leads-export.csv').expect(200);
    expect(csv.text).not.toContain('Golf Stores');
    await admin.put(url).send({ allowed: false }).expect(200);
    await agent.get('/api/v1/sales/leads-export.csv').expect(403);
  });

  it('notifies a customer business on SMA in the app about its bill', async () => {
    const sma = await h.prisma.business.findFirstOrThrow({ where: { internal: true } });
    const invoice = await h.prisma.invoice.create({
      data: {
        tenantId: sma.id,
        number: 'INV-NOTIFY-1',
        businessId: business.id,
        billToName: 'Delta Mart',
        issueDate: new Date(Date.now() - 20 * 86_400_000),
        dueDate: new Date(Date.now() - 6 * 86_400_000),
        currency: 'USD',
        subtotal: 99,
        total: 99,
        status: 'ISSUED',
      },
    });
    const d = (await superAdmin.get('/api/v1/sales/crm/finance').expect(200))
      .body as FinanceDashboardDto;
    expect(d.unpaid.find((r) => r.id === invoice.id)).toMatchObject({ onSma: true });
    // No email address on file: email cannot go, the in-app notice can.
    const email = await superAdmin
      .post('/api/v1/sales/crm/finance/remind')
      .send({ invoiceIds: [invoice.id], via: 'email' })
      .expect(200);
    expect(email.body).toEqual({ reminded: 0, failed: 1 });
    const notify = await superAdmin
      .post('/api/v1/sales/crm/finance/remind')
      .send({ invoiceIds: [invoice.id], via: 'notify' })
      .expect(200);
    expect(notify.body).toEqual({ reminded: 1, failed: 0 });
  });

  it('works out the due date from the payment window', () => {
    const d = (s: string) => new Date(`${s}T00:00:00Z`);
    expect(dueByDay(d('2026-10-01'), 10).toISOString().slice(0, 10)).toBe('2026-10-10');
    expect(dueByDay(d('2026-10-10'), 10).toISOString().slice(0, 10)).toBe('2026-10-10');
    expect(dueByDay(d('2026-10-15'), 10).toISOString().slice(0, 10)).toBe('2026-11-10');
    expect(dueByDay(d('2026-12-20'), 10).toISOString().slice(0, 10)).toBe('2027-01-10');
  });
});
