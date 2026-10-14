/**
 * FBR Digital Invoicing (run by PRAL) for sales-tax-registered businesses: each invoice is
 * posted to FBR, which answers with an FBR invoice number to print (with a QR code) on the
 * invoice. Built from PRAL's "Digital Invoicing API" technical specification; verify the
 * business's scenarios in the PRAL sandbox before production (docs/operations/fbr-invoicing.md).
 */

export const FBR_URL = {
  sandbox: 'https://gw.fbr.gov.pk/di_data/v1/di/postinvoicedata_sb',
  live: 'https://gw.fbr.gov.pk/di_data/v1/di/postinvoicedata',
} as const;

export interface FbrSeller {
  sellerNtnCnic: string;
  sellerBusinessName: string;
  sellerProvince: string;
  sellerAddress: string;
  defaultHsCode: string;
  defaultSaleType: string;
  defaultUom: string;
  scenarioId: string | null;
  sandbox: boolean;
}

export interface FbrInvoiceInput {
  number: string;
  issueDate: string; // yyyy-MM-dd
  taxRate: number;
  discount: number;
  buyer: { ntnCnic: string | null; name: string; province: string; address: string | null };
  items: Array<{ name: string; quantity: number; total: number }>;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** The request body PRAL expects. The invoice discount is spread over the lines by value. */
export function fbrInvoicePayload(
  seller: FbrSeller,
  inv: FbrInvoiceInput,
): Record<string, unknown> {
  const subtotal = inv.items.reduce((s, i) => s + i.total, 0);
  let discountLeft = r2(Math.min(inv.discount, subtotal));
  const items = inv.items.map((item, index) => {
    const last = index === inv.items.length - 1;
    const share = last
      ? discountLeft
      : r2(subtotal > 0 ? (inv.discount * item.total) / subtotal : 0);
    discountLeft = r2(discountLeft - share);
    const value = r2(item.total - share);
    const tax = r2((value * inv.taxRate) / 100);
    return {
      hsCode: seller.defaultHsCode,
      productDescription: item.name.slice(0, 200),
      rate: `${inv.taxRate}%`,
      uoM: seller.defaultUom,
      quantity: item.quantity,
      totalValues: r2(value + tax),
      valueSalesExcludingST: value,
      fixedNotifiedValueOrRetailPrice: 0,
      salesTaxApplicable: tax,
      salesTaxWithheldAtSource: 0,
      extraTax: '',
      furtherTax: 0,
      sroScheduleNo: '',
      fedPayable: 0,
      discount: share,
      saleType: seller.defaultSaleType,
      sroItemSerialNo: '',
    };
  });
  return {
    invoiceType: 'Sale Invoice',
    invoiceDate: inv.issueDate,
    sellerNTNCNIC: seller.sellerNtnCnic,
    sellerBusinessName: seller.sellerBusinessName,
    sellerProvince: seller.sellerProvince,
    sellerAddress: seller.sellerAddress,
    buyerNTNCNIC: inv.buyer.ntnCnic ?? '',
    buyerBusinessName: inv.buyer.name,
    buyerProvince: inv.buyer.province,
    buyerAddress: inv.buyer.address ?? '',
    buyerRegistrationType: inv.buyer.ntnCnic ? 'Registered' : 'Unregistered',
    invoiceRefNo: inv.number,
    ...(seller.sandbox && seller.scenarioId ? { scenarioId: seller.scenarioId } : {}),
    items,
  };
}

export type FbrResult = { ok: true; invoiceNumber: string } | { ok: false; error: string };

/** Reads PRAL's answer: valid when statusCode is "00" and an invoice number came back. */
export function readFbrResponse(status: number, body: unknown): FbrResult {
  const data = (body ?? {}) as {
    invoiceNumber?: string;
    validationResponse?: {
      statusCode?: string;
      status?: string;
      error?: string;
      invoiceStatuses?: Array<{ itemSNo?: string; statusCode?: string; error?: string }>;
    };
  };
  const v = data.validationResponse;
  if (status >= 200 && status < 300 && v?.statusCode === '00' && data.invoiceNumber)
    return { ok: true, invoiceNumber: String(data.invoiceNumber).slice(0, 60) };
  const itemErrors = (v?.invoiceStatuses ?? [])
    .filter((s) => s.statusCode && s.statusCode !== '00' && s.error)
    .map((s) => `item ${s.itemSNo ?? '?'}: ${s.error}`);
  const error =
    [v?.error, ...itemErrors].filter(Boolean).join('; ') ||
    (status === 401 || status === 403
      ? 'FBR refused the token (check it in CRM settings).'
      : `FBR answered ${status}.`);
  return { ok: false, error: error.slice(0, 500) };
}

export async function postToFbr(
  seller: FbrSeller,
  token: string,
  payload: Record<string, unknown>,
): Promise<FbrResult> {
  try {
    const res = await fetch(seller.sandbox ? FBR_URL.sandbox : FBR_URL.live, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => null)) as unknown;
    return readFbrResponse(res.status, body);
  } catch {
    return { ok: false, error: 'Could not reach FBR. Try again in a few minutes.' };
  }
}
