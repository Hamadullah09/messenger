import { describe, expect, it } from 'vitest';
import { fbrInvoicePayload, readFbrResponse, type FbrSeller } from './fbr';

const seller: FbrSeller = {
  sellerNtnCnic: '1234567',
  sellerBusinessName: 'Alpha Traders',
  sellerProvince: 'SINDH',
  sellerAddress: 'Karachi',
  defaultHsCode: '9983.9990',
  defaultSaleType: 'Services',
  defaultUom: 'Numbers, pieces, units',
  scenarioId: 'SN001',
  sandbox: true,
};

describe('FBR Digital Invoicing', () => {
  it('builds the invoice with the discount spread over the lines and tax per line', () => {
    const p = fbrInvoicePayload(seller, {
      number: 'INV-2026-00007',
      issueDate: '2026-10-14',
      taxRate: 18,
      discount: 100,
      buyer: { ntnCnic: null, name: 'Walk-in', province: 'PUNJAB', address: null },
      items: [
        { name: 'Setup', quantity: 1, total: 300 },
        { name: 'Support', quantity: 2, total: 700 },
      ],
    }) as {
      items: Array<Record<string, number | string>>;
      buyerRegistrationType: string;
      scenarioId?: string;
    };
    expect(p.buyerRegistrationType).toBe('Unregistered');
    expect(p.scenarioId).toBe('SN001');
    expect(p.items.map((i) => i.discount)).toEqual([30, 70]);
    expect(p.items.map((i) => i.valueSalesExcludingST)).toEqual([270, 630]);
    expect(p.items.map((i) => i.salesTaxApplicable)).toEqual([48.6, 113.4]);
    expect(p.items[0]!.rate).toBe('18%');
    const totals = p.items.reduce((s, i) => s + (i.totalValues as number), 0);
    expect(Math.round(totals * 100) / 100).toBe(1062);
  });

  it('marks a buyer with an NTN as registered, and sends no scenario in production', () => {
    const p = fbrInvoicePayload(
      { ...seller, sandbox: false },
      {
        number: 'INV-1',
        issueDate: '2026-10-14',
        taxRate: 0,
        discount: 0,
        buyer: { ntnCnic: '7654321', name: 'Beta', province: 'SINDH', address: 'x' },
        items: [{ name: 'A', quantity: 1, total: 10 }],
      },
    ) as Record<string, unknown>;
    expect(p.buyerRegistrationType).toBe('Registered');
    expect(p.scenarioId).toBeUndefined();
  });

  it('reads FBR answers', () => {
    expect(
      readFbrResponse(200, {
        invoiceNumber: '1234567DI1760000000',
        validationResponse: { statusCode: '00', status: 'Valid' },
      }),
    ).toEqual({
      ok: true,
      invoiceNumber: '1234567DI1760000000',
    });
    const bad = readFbrResponse(200, {
      validationResponse: {
        statusCode: '01',
        status: 'Invalid',
        error: 'Buyer province is invalid',
        invoiceStatuses: [{ itemSNo: '1', statusCode: '01', error: 'HS code not found' }],
      },
    });
    expect(bad).toEqual({
      ok: false,
      error: 'Buyer province is invalid; item 1: HS code not found',
    });
    expect(readFbrResponse(401, null)).toEqual({
      ok: false,
      error: 'FBR refused the token (check it in CRM settings).',
    });
  });
});
