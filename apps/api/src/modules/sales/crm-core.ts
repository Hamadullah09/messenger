import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  CURRENCIES,
  type CrmSettingKey,
  type CrmSettingsDto,
  type Currency,
  type UpdateCrmSettingsRequest,
} from '@storeline/shared';
import { APP_CONFIG, type AppConfig } from '../../infra/config/config';
import { MailService } from '../../infra/mail/mail.service';
import { MarketingChannelsService } from '../../infra/mail/marketing-channels.service';
import { PlatformSettingsService } from '../../infra/mail/platform-settings.service';
import type { Tx } from '../../infra/prisma/prisma.service';

export const num = (v: Prisma.Decimal | number | null | undefined): number =>
  v == null ? 0 : Number(v);
export const round2 = (v: number): number => Math.round(v * 100) / 100;

export function dateOnly(date: Date): Date {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
}
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
/** Today as a DATE value (server's calendar day). */
export function today(): Date {
  return dateOnly(new Date());
}

export function newPublicToken(): string {
  return randomBytes(24).toString('base64url');
}

export type CrmSettings = Omit<CrmSettingsDto, 'canManage'>;

/**
 * CRM settings: currency, tax, company details, where customers pay, reminders. Stored in
 * PlatformSetting (changed in the app); the server's environment gives the defaults.
 */
@Injectable()
export class CrmSettingsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly settings: PlatformSettingsService,
    private readonly mail: MailService,
    private readonly channels: MarketingChannelsService,
  ) {}

  private get(key: CrmSettingKey): string | undefined {
    const v = this.settings.get(key);
    return v === undefined || v === '' ? undefined : v;
  }

  current(): CrmSettings {
    const c = this.config;
    const currency = (this.get('CRM_DEFAULT_CURRENCY') ?? c.CRM_CURRENCY) as Currency;
    const days = (this.get('REMINDER_DAYS') ?? '1,7,14')
      .split(',')
      .map((d) => Number(d.trim()))
      .filter((d) => Number.isInteger(d) && d >= 0)
      .sort((a, b) => a - b);
    const reminderChannels = (this.get('REMINDER_CHANNELS') ?? 'EMAIL')
      .split(',')
      .map((v) => v.trim())
      .filter((v): v is 'EMAIL' | 'WHATSAPP' | 'SMS' => ['EMAIL', 'WHATSAPP', 'SMS'].includes(v));
    return {
      defaultCurrency: (CURRENCIES as readonly string[]).includes(currency) ? currency : 'USD',
      currency: (CURRENCIES as readonly string[]).includes(currency) ? currency : 'USD',
      usdToPkr: Number(this.get('CRM_USD_PKR_RATE') ?? 280) || 280,
      taxName: this.get('CRM_TAX_NAME') ?? 'GST',
      taxRate: Number(this.get('CRM_TAX_RATE') ?? 0) || 0,
      taxNumber: this.get('CRM_TAX_NUMBER') ?? null,
      companyName: this.get('INVOICE_COMPANY_NAME') ?? c.INVOICE_COMPANY_NAME,
      companyAddress: this.get('INVOICE_COMPANY_ADDRESS') ?? (c.INVOICE_COMPANY_ADDRESS || null),
      companyEmail: this.get('INVOICE_COMPANY_EMAIL') ?? (c.INVOICE_COMPANY_EMAIL || null),
      companyPhone: this.get('INVOICE_COMPANY_PHONE') ?? (c.INVOICE_COMPANY_PHONE || null),
      paymentDetails: this.get('INVOICE_PAYMENT_DETAILS') ?? (c.INVOICE_PAYMENT_DETAILS || null),
      payTo: {
        jazzcash: this.get('PAY_JAZZCASH_ACCOUNT') ?? null,
        easypaisa: this.get('PAY_EASYPAISA_ACCOUNT') ?? null,
        bank: this.get('PAY_BANK_ACCOUNT') ?? null,
      },
      reminderDays: days.length > 0 ? days : [1, 7, 14],
      reminderChannels: reminderChannels.length > 0 ? reminderChannels : ['EMAIL'],
      channels: this.channels.available(),
      emailEnabled: this.mail.enabled,
    };
  }

  async update(request: UpdateCrmSettingsRequest, userId: string): Promise<void> {
    const values: Array<[CrmSettingKey, string | null | undefined]> = [
      ['CRM_DEFAULT_CURRENCY', request.defaultCurrency],
      ['CRM_USD_PKR_RATE', request.usdToPkr?.toString()],
      ['CRM_TAX_NAME', request.taxName],
      ['CRM_TAX_RATE', request.taxRate?.toString()],
      ['CRM_TAX_NUMBER', request.taxNumber],
      ['INVOICE_COMPANY_NAME', request.companyName],
      ['INVOICE_COMPANY_ADDRESS', request.companyAddress],
      ['INVOICE_COMPANY_EMAIL', request.companyEmail],
      ['INVOICE_COMPANY_PHONE', request.companyPhone],
      ['INVOICE_PAYMENT_DETAILS', request.paymentDetails],
      ['PAY_JAZZCASH_ACCOUNT', request.payTo?.jazzcash],
      ['PAY_EASYPAISA_ACCOUNT', request.payTo?.easypaisa],
      ['PAY_BANK_ACCOUNT', request.payTo?.bank],
      ['REMINDER_DAYS', request.reminderDays ? [...new Set(request.reminderDays)].join(',') : undefined],
      ['REMINDER_CHANNELS', request.reminderChannels ? [...new Set(request.reminderChannels)].join(',') : undefined],
    ];
    for (const [key, value] of values) {
      if (value === undefined) continue;
      await this.settings.set(key, value, userId);
    }
  }

  /** Converts between USD and PKR with the configured rate. */
  convert(amount: number, from: string, to: string): number {
    if (from === to) return amount;
    const rate = this.current().usdToPkr;
    if (from === 'USD' && to === 'PKR') return round2(amount * rate);
    if (from === 'PKR' && to === 'USD') return round2(amount / rate);
    return amount;
  }

  /** Public address used in emails and messages. */
  link(path: string): string {
    return `${this.config.WEB_APP_URL.replace(/\/$/, '')}${path}`;
  }
}

/** Shared invoice/quote mechanics for the API and the worker. */
@Injectable()
export class InvoiceFactory {
  async nextInvoiceNumber(tx: Tx): Promise<string> {
    const rows = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT nextval('invoice_number_seq') AS n`;
    return `INV-${new Date().getFullYear()}-${String(rows[0]!.n).padStart(5, '0')}`;
  }

  async nextQuoteNumber(tx: Tx): Promise<string> {
    const rows = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT nextval('quote_number_seq') AS n`;
    return `QT-${new Date().getFullYear()}-${String(rows[0]!.n).padStart(5, '0')}`;
  }

  /** Recomputes an invoice's totals from items and payments, and its paid status. */
  async recompute(tx: Tx, invoiceId: string): Promise<void> {
    const invoice = await tx.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      select: {
        status: true,
        discount: true,
        taxRate: true,
        items: { select: { total: true } },
        payments: { where: { voidedAt: null }, select: { amount: true, paidAt: true } },
      },
    });
    const subtotal = round2(invoice.items.reduce((s, i) => s + num(i.total), 0));
    const discount = Math.min(num(invoice.discount), subtotal);
    const taxAmount = round2(((subtotal - discount) * num(invoice.taxRate)) / 100);
    const total = round2(subtotal - discount + taxAmount);
    const amountPaid = round2(invoice.payments.reduce((s, p) => s + num(p.amount), 0));
    let status = invoice.status;
    if (status !== 'VOID' && status !== 'DRAFT') {
      status = amountPaid <= 0 ? 'ISSUED' : amountPaid + 0.004 >= total ? 'PAID' : 'PARTIALLY_PAID';
    }
    const lastPayment = invoice.payments.reduce<Date | null>(
      (latest, p) => (!latest || p.paidAt > latest ? p.paidAt : latest),
      null,
    );
    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        subtotal,
        discount,
        taxAmount,
        total,
        amountPaid,
        status,
        paidAt: status === 'PAID' ? lastPayment : null,
      },
    });
  }

  /** Recomputes a quote's totals from its items. */
  async recomputeQuote(tx: Tx, quoteId: string): Promise<void> {
    const q = await tx.quote.findUniqueOrThrow({
      where: { id: quoteId },
      select: { discount: true, taxRate: true, items: { select: { total: true } } },
    });
    const subtotal = round2(q.items.reduce((s, i) => s + num(i.total), 0));
    const discount = Math.min(num(q.discount), subtotal);
    const taxAmount = round2(((subtotal - discount) * num(q.taxRate)) / 100);
    await tx.quote.update({
      where: { id: quoteId },
      data: { subtotal, discount, taxAmount, total: round2(subtotal - discount + taxAmount) },
    });
  }
}

// ───────────────────────────── Emails ─────────────────────────────

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function formatMoney(value: number, currency: string): string {
  return `${currency} ${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export interface DocumentForEmail {
  kind: 'Invoice' | 'Quotation';
  number: string;
  billToName: string;
  issueDate: string;
  dueLabel: string;
  dueDate: string;
  currency: string;
  items: Array<{ name: string; description: string | null; quantity: number; unitPrice: number; total: number }>;
  subtotal: number;
  discount: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  amountPaid?: number;
  balance?: number;
  notes: string | null;
  /** Pay page or quote page. */
  actionUrl: string | null;
  actionLabel: string;
}

export function documentText(d: DocumentForEmail, s: CrmSettings, intro?: string): string {
  return [
    intro ?? `${d.kind} ${d.number} from ${s.companyName}`,
    `Issued ${d.issueDate}, ${d.dueLabel.toLowerCase()} ${d.dueDate}`,
    '',
    ...d.items.map((it) => `${it.name} × ${it.quantity}: ${formatMoney(it.total, d.currency)}`),
    '',
    `Total: ${formatMoney(d.total, d.currency)}`,
    ...(d.balance !== undefined ? [`Balance due: ${formatMoney(d.balance, d.currency)}`] : []),
    ...(d.actionUrl ? ['', `${d.actionLabel}: ${d.actionUrl}`] : []),
    ...(s.paymentDetails && d.kind === 'Invoice' ? ['', 'How to pay:', s.paymentDetails] : []),
  ].join('\n');
}

export function documentHtml(d: DocumentForEmail, s: CrmSettings, intro?: string): string {
  const rows = d.items
    .map(
      (it) =>
        `<tr><td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(it.name)}${
          it.description ? `<br><small style="color:#666">${escapeHtml(it.description)}</small>` : ''
        }</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${it.quantity}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${formatMoney(it.unitPrice, d.currency)}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${formatMoney(it.total, d.currency)}</td></tr>`,
    )
    .join('');
  const tax = d.taxAmount ? `<br>${escapeHtml(s.taxName)} (${d.taxRate}%) ${formatMoney(d.taxAmount, d.currency)}` : '';
  return `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#111">
<h2 style="color:#ea580c;margin:0">${escapeHtml(s.companyName)}</h2>
<p style="color:#666;margin:4px 0 16px">${[s.companyAddress, s.companyEmail, s.companyPhone].filter(Boolean).map((v) => escapeHtml(v!)).join(' · ')}${s.taxNumber ? `<br>${escapeHtml(s.taxName)} no. ${escapeHtml(s.taxNumber)}` : ''}</p>
${intro ? `<p>${escapeHtml(intro)}</p>` : ''}
<h3 style="margin:0">${d.kind} ${escapeHtml(d.number)}</h3>
<p style="margin:4px 0">For: <b>${escapeHtml(d.billToName)}</b><br>Issued ${d.issueDate} · ${escapeHtml(d.dueLabel)} ${d.dueDate}</p>
<table style="width:100%;border-collapse:collapse;margin-top:12px"><thead><tr style="background:#fff7ed"><th style="padding:8px;text-align:left">Item</th><th style="padding:8px;text-align:right">Qty</th><th style="padding:8px;text-align:right">Price</th><th style="padding:8px;text-align:right">Amount</th></tr></thead><tbody>${rows}</tbody></table>
<p style="text-align:right;margin-top:12px">Subtotal ${formatMoney(d.subtotal, d.currency)}${d.discount ? `<br>Discount −${formatMoney(d.discount, d.currency)}` : ''}${tax}<br><b style="font-size:18px">Total ${formatMoney(d.total, d.currency)}</b>${d.amountPaid ? `<br>Paid ${formatMoney(d.amountPaid, d.currency)}` : ''}${d.balance !== undefined ? `<br><b>Balance due ${formatMoney(d.balance, d.currency)}</b>` : ''}</p>
${d.actionUrl ? `<p style="text-align:center;margin:20px 0"><a href="${escapeHtml(d.actionUrl)}" style="background:#ea580c;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:bold">${escapeHtml(d.actionLabel)}</a></p>` : ''}
${s.paymentDetails && d.kind === 'Invoice' ? `<p style="background:#f5f5f5;padding:12px;border-radius:8px;white-space:pre-line"><b>How to pay</b><br>${escapeHtml(s.paymentDetails)}</p>` : ''}
${d.notes ? `<p style="white-space:pre-line">${escapeHtml(d.notes)}</p>` : ''}
</div>`;
}
