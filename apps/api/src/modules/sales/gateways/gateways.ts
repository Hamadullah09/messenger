import { createCipheriv, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * JazzCash and Easypaisa hosted checkout, following their published merchant integration
 * guides (JazzCash "Page Redirection" v1.1; Easypaisa "Easypay" plug-in with the inquire
 * transaction API). Verify the whole flow in each sandbox with the business's own merchant
 * credentials before switching a business to live mode (docs/operations/online-payments.md).
 */

/** "yyyyMMddHHmmss" in Pakistan time (both gateways expect PKT). */
export function pktStamp(date: Date, separator = ''): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Karachi',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}${parts.month}${parts.day}${separator}${parts.hour}${parts.minute}${parts.second}`;
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a.toUpperCase());
  const y = Buffer.from(b.toUpperCase());
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Letters, digits and spaces only, as the gateways require for free-text fields. */
const plain = (text: string, max: number) =>
  text
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

// ───────────────────────────── JazzCash ─────────────────────────────

export const JAZZCASH_URL = {
  sandbox: 'https://sandbox.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform/',
  live: 'https://payments.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform/',
} as const;

/**
 * pp_SecureHash: HMAC-SHA256 (key = integrity salt) of the salt and the values of every
 * non-empty pp* field sorted by field name, joined with "&"; upper-case hex.
 */
export function jazzcashHash(fields: Record<string, string>, salt: string): string {
  const values = Object.keys(fields)
    .filter(
      (k) =>
        k.toLowerCase().startsWith('pp') &&
        k !== 'pp_SecureHash' &&
        fields[k] !== '' &&
        fields[k] != null,
    )
    .sort()
    .map((k) => fields[k]);
  return createHmac('sha256', salt)
    .update([salt, ...values].join('&'))
    .digest('hex')
    .toUpperCase();
}

export interface JazzcashCredentials {
  merchantId: string;
  password: string;
  integritySalt: string;
  sandbox: boolean;
}

export function jazzcashCheckout(
  c: JazzcashCredentials,
  p: {
    reference: string;
    amount: number;
    description: string;
    billReference: string;
    returnUrl: string;
    method: 'WALLET' | 'CARD';
    now?: Date;
  },
): { action: string; fields: Record<string, string> } {
  const now = p.now ?? new Date();
  const fields: Record<string, string> = {
    pp_Version: '1.1',
    pp_TxnType: p.method === 'WALLET' ? 'MWALLET' : 'MPAY',
    pp_Language: 'EN',
    pp_MerchantID: c.merchantId,
    pp_SubMerchantID: '',
    pp_Password: c.password,
    pp_BankID: '',
    pp_ProductID: '',
    pp_TxnRefNo: p.reference,
    // Amount in paisa (no decimals).
    pp_Amount: String(Math.round(p.amount * 100)),
    pp_TxnCurrency: 'PKR',
    pp_TxnDateTime: pktStamp(now),
    pp_BillReference: plain(p.billReference, 20) || 'invoice',
    pp_Description: plain(p.description, 100) || 'Invoice payment',
    pp_TxnExpiryDateTime: pktStamp(new Date(now.getTime() + 24 * 3600_000)),
    pp_ReturnURL: p.returnUrl,
    ppmpf_1: '',
    ppmpf_2: '',
    ppmpf_3: '',
    ppmpf_4: '',
    ppmpf_5: '',
  };
  fields.pp_SecureHash = jazzcashHash(fields, c.integritySalt);
  return { action: c.sandbox ? JAZZCASH_URL.sandbox : JAZZCASH_URL.live, fields };
}

/** Paid; pending (e.g. voucher paid later at a shop); anything else failed. */
export function jazzcashOutcome(code: string | undefined): 'PAID' | 'PENDING' | 'FAILED' {
  if (code === '000' || code === '121') return 'PAID';
  if (code === '124' || code === '157') return 'PENDING';
  return 'FAILED';
}

/** Checks the signature of a JazzCash response or notification. */
export function jazzcashVerify(body: Record<string, string>, salt: string): boolean {
  const received = body.pp_SecureHash;
  if (!received) return false;
  return safeEqual(jazzcashHash(body, salt), received);
}

// ───────────────────────────── Easypaisa ─────────────────────────────

export const EASYPAISA_URL = {
  sandbox: 'https://easypaystg.easypaisa.com.pk',
  live: 'https://easypay.easypaisa.com.pk',
} as const;

export interface EasypaisaCredentials {
  storeId: string;
  hashKey: string;
  sandbox: boolean;
  inquiryUsername?: string;
  inquiryPassword?: string;
  accountNumber?: string;
}

/**
 * merchantHashedReq: AES-128-ECB (PKCS#5) with the hash key over "name=value&…" of the
 * non-empty request fields sorted by name, Base64.
 */
export function easypaisaHash(fields: Record<string, string>, hashKey: string): string {
  const text = Object.keys(fields)
    .filter((k) => k !== 'merchantHashedReq' && fields[k] !== '' && fields[k] != null)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('&');
  const key = Buffer.from(hashKey, 'utf8');
  if (![16, 24, 32].includes(key.length))
    throw new Error('The Easypaisa hash key must be 16, 24 or 32 characters long.');
  const cipher = createCipheriv(`aes-${key.length * 8}-ecb`, key, null);
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('base64');
}

export function easypaisaCheckout(
  c: EasypaisaCredentials,
  p: {
    reference: string;
    amount: number;
    postBackUrl: string;
    method: 'WALLET' | 'CARD';
    email?: string;
    mobile?: string;
    now?: Date;
  },
): { action: string; fields: Record<string, string> } {
  const now = p.now ?? new Date();
  const fields: Record<string, string> = {
    storeId: c.storeId,
    amount: p.amount.toFixed(1),
    postBackURL: p.postBackUrl,
    orderRefNum: p.reference,
    expiryDate: pktStamp(new Date(now.getTime() + 24 * 3600_000), ' '),
    autoRedirect: '1',
    paymentMethod: p.method === 'WALLET' ? 'MA_PAYMENT_METHOD' : 'CC_PAYMENT_METHOD',
    emailAddr: p.email ?? '',
    mobileNum: p.mobile ?? '',
  };
  fields.merchantHashedReq = easypaisaHash(fields, c.hashKey);
  return {
    action: `${c.sandbox ? EASYPAISA_URL.sandbox : EASYPAISA_URL.live}/easypay/Index.jsf`,
    fields,
  };
}

/** Second step: the browser posts the token back to Easypaisa to finish the payment. */
export function easypaisaConfirmAction(sandbox: boolean): string {
  return `${sandbox ? EASYPAISA_URL.sandbox : EASYPAISA_URL.live}/easypay/Confirm.jsf`;
}

/**
 * Asks Easypaisa whether an order is paid (server to server). Only this answer marks an
 * invoice paid; the browser redirect alone is never trusted.
 */
export async function easypaisaInquire(
  c: EasypaisaCredentials,
  orderId: string,
): Promise<{ status: string; amount: number | null; transactionId: string | null } | null> {
  if (!c.inquiryUsername || !c.inquiryPassword || !c.accountNumber) return null;
  const base = c.sandbox ? EASYPAISA_URL.sandbox : EASYPAISA_URL.live;
  const res = await fetch(`${base}/easypay-service/rest/v4/inquire-transaction`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Credentials: Buffer.from(`${c.inquiryUsername}:${c.inquiryPassword}`).toString('base64'),
    },
    body: JSON.stringify({ orderId, storeId: c.storeId, accountNum: c.accountNumber }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    responseCode?: string;
    transactionStatus?: string;
    transactionAmount?: number | string;
    transactionId?: string;
  };
  if (data.responseCode !== '0000') return null;
  return {
    status: String(data.transactionStatus ?? ''),
    amount: data.transactionAmount != null ? Number(data.transactionAmount) : null,
    transactionId: data.transactionId ?? null,
  };
}
