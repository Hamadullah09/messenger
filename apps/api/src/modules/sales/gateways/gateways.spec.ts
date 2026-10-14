import { createDecipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  easypaisaCheckout,
  easypaisaHash,
  jazzcashCheckout,
  jazzcashHash,
  jazzcashOutcome,
  jazzcashVerify,
  pktStamp,
} from './gateways';

const jazz = {
  merchantId: 'MC12345',
  password: 'pass-word',
  integritySalt: 'salt-123',
  sandbox: true,
};
const NOW = new Date('2026-10-14T07:30:05Z'); // 12:30:05 in Pakistan

describe('payment gateways', () => {
  it('formats times in Pakistan time', () => {
    expect(pktStamp(NOW)).toBe('20261014123005');
    expect(pktStamp(NOW, ' ')).toBe('20261014 123005');
  });

  it('builds a signed JazzCash checkout that verifies, and rejects tampering', () => {
    const { action, fields } = jazzcashCheckout(jazz, {
      reference: 'SABC123',
      amount: 1534.5,
      description: 'Invoice INV-2026-00001',
      billReference: 'INV-2026-00001',
      returnUrl: 'https://chat.example.com/api/v1/public/payments/jazzcash/return',
      method: 'WALLET',
      now: NOW,
    });
    expect(action).toContain('sandbox.jazzcash.com.pk');
    expect(fields.pp_Amount).toBe('153450');
    expect(fields.pp_TxnType).toBe('MWALLET');
    expect(fields.pp_TxnDateTime).toBe('20261014123005');
    expect(fields.pp_BillReference).toBe('INV 2026 00001');
    expect(jazzcashVerify(fields, jazz.integritySalt)).toBe(true);
    expect(jazzcashVerify({ ...fields, pp_Amount: '100' }, jazz.integritySalt)).toBe(false);
    expect(jazzcashVerify(fields, 'other-salt')).toBe(false);
    expect(jazzcashVerify({ ...fields, pp_SecureHash: '' }, jazz.integritySalt)).toBe(false);
  });

  it('signs only non-empty pp fields, in name order', () => {
    const a = jazzcashHash({ pp_B: '2', pp_A: '1', pp_C: '', other: 'x' }, 's');
    const b = jazzcashHash({ pp_A: '1', pp_B: '2' }, 's');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9A-F]{64}$/);
  });

  it('reads JazzCash response codes', () => {
    expect(jazzcashOutcome('000')).toBe('PAID');
    expect(jazzcashOutcome('124')).toBe('PENDING');
    expect(jazzcashOutcome('110')).toBe('FAILED');
    expect(jazzcashOutcome(undefined)).toBe('FAILED');
  });

  it('builds an Easypaisa request whose hash decrypts to the sorted fields', () => {
    const key = '1234567890ABCDEF';
    const { action, fields } = easypaisaCheckout(
      { storeId: '4321', hashKey: key, sandbox: false },
      {
        reference: 'SXYZ',
        amount: 2500,
        postBackUrl: 'https://x.test/return?ref=SXYZ',
        method: 'CARD',
        now: NOW,
      },
    );
    expect(action).toBe('https://easypay.easypaisa.com.pk/easypay/Index.jsf');
    expect(fields.amount).toBe('2500.0');
    expect(fields.paymentMethod).toBe('CC_PAYMENT_METHOD');
    expect(fields.expiryDate).toBe('20261015 123005');
    const decipher = createDecipheriv('aes-128-ecb', Buffer.from(key), null);
    const plain = Buffer.concat([
      decipher.update(Buffer.from(fields.merchantHashedReq!, 'base64')),
      decipher.final(),
    ]).toString();
    expect(plain).toBe(
      'amount=2500.0&autoRedirect=1&expiryDate=20261015 123005&orderRefNum=SXYZ&paymentMethod=CC_PAYMENT_METHOD&postBackURL=https://x.test/return?ref=SXYZ&storeId=4321',
    );
  });

  it('refuses an Easypaisa hash key of the wrong length', () => {
    expect(() => easypaisaHash({ a: '1' }, 'short')).toThrow(/16, 24 or 32/);
  });
});
