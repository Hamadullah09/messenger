/**
 * CRM, second part: currencies and tax, quotations, monthly billing (subscriptions), payment
 * reminders, the customer's pay page (payment claims), commission and lead import.
 */
import { z } from 'zod';
import type { PaymentMethod, ServiceBilling } from './crm';
import type { PublicUserDto } from './dto';
import { idSchema } from './schemas/common';
import { createLeadRequestSchema } from './schemas/sales';

export const CURRENCIES = ['USD', 'PKR'] as const;
export type Currency = (typeof CURRENCIES)[number];
export const currencySchema = z.enum(CURRENCIES);

const text = (max: number) => z.string().trim().max(max);
const money = z.coerce.number().min(0).max(999_999_999).multipleOf(0.01, 'Use at most 2 decimals');

// ── Settings (company, tax, currencies, how customers pay, reminders) ──

export const CRM_SETTING_KEYS = [
  'CRM_DEFAULT_CURRENCY',
  'CRM_USD_PKR_RATE',
  'CRM_TAX_NAME',
  'CRM_TAX_RATE',
  'CRM_TAX_NUMBER',
  'INVOICE_COMPANY_NAME',
  'INVOICE_COMPANY_ADDRESS',
  'INVOICE_COMPANY_EMAIL',
  'INVOICE_COMPANY_PHONE',
  'INVOICE_PAYMENT_DETAILS',
  'PAY_JAZZCASH_ACCOUNT',
  'PAY_EASYPAISA_ACCOUNT',
  'PAY_BANK_ACCOUNT',
  'REMINDER_DAYS',
  'REMINDER_CHANNELS',
] as const;
export type CrmSettingKey = (typeof CRM_SETTING_KEYS)[number];

export interface CrmSettingsDto {
  defaultCurrency: Currency;
  /** How many PKR one USD is worth (targets and totals in mixed currencies use it). */
  usdToPkr: number;
  taxName: string;
  /** Default tax % on new quotes and invoices. */
  taxRate: number;
  /** NTN / STRN printed on invoices. */
  taxNumber: string | null;
  companyName: string;
  companyAddress: string | null;
  companyEmail: string | null;
  companyPhone: string | null;
  paymentDetails: string | null;
  payTo: { jazzcash: string | null; easypaisa: string | null; bank: string | null };
  /** Days after the due date when reminders go out, e.g. [1, 7, 14]. */
  reminderDays: number[];
  reminderChannels: Array<'EMAIL' | 'WHATSAPP' | 'SMS'>;
  channels: { EMAIL: boolean; SMS: boolean; WHATSAPP: boolean };
  /** For the pay and quote pages. */
  currency: Currency;
  emailEnabled: boolean;
  canManage: boolean;
}

export const updateCrmSettingsRequestSchema = z.object({
  defaultCurrency: currencySchema.optional(),
  usdToPkr: z.coerce.number().positive().max(100_000).optional(),
  taxName: text(30).min(1).optional(),
  taxRate: z.coerce.number().min(0).max(100).optional(),
  taxNumber: text(60).nullable().optional(),
  companyName: text(160).min(1).optional(),
  companyAddress: text(500).nullable().optional(),
  companyEmail: text(254).nullable().optional(),
  companyPhone: text(40).nullable().optional(),
  paymentDetails: text(1000).nullable().optional(),
  payTo: z
    .object({
      jazzcash: text(120).nullable().optional(),
      easypaisa: text(120).nullable().optional(),
      bank: text(500).nullable().optional(),
    })
    .optional(),
  reminderDays: z.array(z.number().int().min(0).max(120)).max(6).optional(),
  reminderChannels: z.array(z.enum(['EMAIL', 'WHATSAPP', 'SMS'])).max(3).optional(),
});
export type UpdateCrmSettingsRequest = z.infer<typeof updateCrmSettingsRequestSchema>;

// ── Quotations ──

export const QUOTE_STATUSES = ['DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

const documentItemsSchema = z
  .array(
    z.object({
      serviceId: idSchema.nullable().optional(),
      name: text(160).min(1),
      description: text(500).nullable().optional(),
      quantity: z.coerce.number().int().min(1).max(100_000),
      unitPrice: money,
      billing: z.enum(['ONE_TIME', 'MONTHLY', 'YEARLY']).default('ONE_TIME'),
    }),
  )
  .max(50);

export const createQuoteRequestSchema = z
  .object({
    dealId: idSchema.optional(),
    businessId: idSchema.nullable().optional(),
    leadId: idSchema.nullable().optional(),
    billToName: text(160).min(1).optional(),
    billToEmail: z.string().trim().email().max(254).nullable().optional(),
    billToPhone: text(16).nullable().optional(),
    billToAddress: text(500).nullable().optional(),
    currency: currencySchema.optional(),
    validUntil: z.coerce.date().optional(),
    discount: money.default(0),
    taxRate: z.coerce.number().min(0).max(100).optional(),
    notes: text(2000).nullable().optional(),
    terms: text(2000).nullable().optional(),
    items: documentItemsSchema.optional(),
  })
  .refine((q) => q.dealId || (q.items && q.items.length > 0), {
    message: 'Add at least one item',
    path: ['items'],
  })
  .refine((q) => q.dealId || q.businessId || q.leadId || q.billToName, {
    message: 'Choose who the quote is for',
    path: ['billToName'],
  });
export type CreateQuoteRequest = z.infer<typeof createQuoteRequestSchema>;

export interface QuoteDto {
  id: string;
  number: string;
  status: QuoteStatus;
  deal: { id: string; title: string } | null;
  customer: { id: string; name: string } | null;
  lead: { id: string; companyName: string } | null;
  billToName: string;
  billToEmail: string | null;
  billToPhone: string | null;
  billToAddress: string | null;
  issueDate: string;
  validUntil: string;
  currency: string;
  subtotal: number;
  discount: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  notes: string | null;
  terms: string | null;
  items: Array<{
    id: string;
    name: string;
    description: string | null;
    quantity: number;
    unitPrice: number;
    total: number;
    billing: ServiceBilling;
  }>;
  /** Link the customer opens to accept or decline. */
  publicUrl: string;
  sentAt: string | null;
  viewedAt: string | null;
  respondedAt: string | null;
  responseName: string | null;
  responseNote: string | null;
  invoiceId: string | null;
  createdAt: string;
  canManage: boolean;
}

/** What the customer sees on the quote link (no internal data). */
export interface PublicQuoteDto {
  number: string;
  status: QuoteStatus;
  company: { name: string; address: string | null; email: string | null; phone: string | null; taxNumber: string | null; taxName: string };
  billToName: string;
  issueDate: string;
  validUntil: string;
  currency: string;
  items: Array<{ name: string; description: string | null; quantity: number; unitPrice: number; total: number; billing: ServiceBilling }>;
  subtotal: number;
  discount: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  notes: string | null;
  terms: string | null;
  respondedAt: string | null;
  /** After acceptance: the invoice's pay page. */
  payUrl: string | null;
}

export const respondToQuoteRequestSchema = z.object({
  accept: z.boolean(),
  name: text(120).min(1, 'Type your name'),
  note: text(500).optional(),
});
export type RespondToQuoteRequest = z.infer<typeof respondToQuoteRequestSchema>;

// ── Subscriptions (monthly / yearly billing) ──

export const createSubscriptionRequestSchema = z.object({
  businessId: idSchema,
  dealId: idSchema.nullable().optional(),
  name: text(160).min(1, 'Name the plan'),
  currency: currencySchema.optional(),
  interval: z.enum(['MONTHLY', 'YEARLY']),
  /** First invoice date (today or later). */
  startDate: z.coerce.date(),
  dueDays: z.coerce.number().int().min(0).max(90).default(14),
  taxRate: z.coerce.number().min(0).max(100).optional(),
  autoEmail: z.boolean().default(true),
  items: z
    .array(
      z.object({
        serviceId: idSchema.nullable().optional(),
        name: text(160).min(1),
        quantity: z.coerce.number().int().min(1).max(100_000),
        unitPrice: money,
      }),
    )
    .min(1, 'Add at least one item')
    .max(50),
});
export type CreateSubscriptionRequest = z.infer<typeof createSubscriptionRequestSchema>;

export const updateSubscriptionRequestSchema = z.object({
  status: z.enum(['ACTIVE', 'PAUSED', 'CANCELLED']).optional(),
  nextInvoiceAt: z.coerce.date().optional(),
  autoEmail: z.boolean().optional(),
  dueDays: z.coerce.number().int().min(0).max(90).optional(),
  items: createSubscriptionRequestSchema.shape.items.optional(),
});
export type UpdateSubscriptionRequest = z.infer<typeof updateSubscriptionRequestSchema>;

export interface SubscriptionDto {
  id: string;
  customer: { id: string; name: string };
  deal: { id: string; title: string } | null;
  name: string;
  currency: string;
  interval: 'MONTHLY' | 'YEARLY';
  status: 'ACTIVE' | 'PAUSED' | 'CANCELLED';
  nextInvoiceAt: string;
  dueDays: number;
  taxRate: number;
  autoEmail: boolean;
  items: Array<{ id: string; name: string; quantity: number; unitPrice: number }>;
  /** Per period, before tax. */
  amount: number;
  invoiceCount: number;
  lastInvoice: { id: string; number: string; status: string } | null;
  createdAt: string;
}

// ── Pay page and payment claims ──

export interface PublicInvoiceDto {
  number: string;
  status: string;
  company: { name: string; address: string | null; email: string | null; phone: string | null; taxNumber: string | null; taxName: string };
  billToName: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  items: Array<{ name: string; description: string | null; quantity: number; unitPrice: number; total: number }>;
  subtotal: number;
  discount: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  amountPaid: number;
  balance: number;
  payTo: { jazzcash: string | null; easypaisa: string | null; bank: string | null };
  paymentDetails: string | null;
  /** Payments the customer reported that are waiting for confirmation. */
  pendingClaims: number;
}

export const submitPaymentClaimSchema = z.object({
  amount: z.coerce.number().positive().max(999_999_999).multipleOf(0.01),
  method: z.enum(['BANK_TRANSFER', 'ONLINE', 'CARD', 'CHEQUE', 'CASH', 'OTHER']),
  /** JazzCash/Easypaisa transaction ID, bank reference… */
  reference: text(120).min(3, 'Enter the transaction ID'),
  payerName: text(120).optional(),
  note: text(500).optional(),
  /** Bots fill this hidden field. */
  website: z.string().max(0).optional(),
});
export type SubmitPaymentClaimRequest = z.infer<typeof submitPaymentClaimSchema>;

export interface PaymentClaimDto {
  id: string;
  invoice: { id: string; number: string; billToName: string; currency: string; balance: number };
  amount: number;
  method: PaymentMethod;
  reference: string;
  payerName: string | null;
  note: string | null;
  status: 'PENDING' | 'CONFIRMED' | 'REJECTED';
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
}

export const reviewPaymentClaimSchema = z.object({
  action: z.enum(['confirm', 'reject']),
  note: text(300).optional(),
});
export type ReviewPaymentClaimRequest = z.infer<typeof reviewPaymentClaimSchema>;

// ── Commission ──

export const setCommissionPlanRequestSchema = z.object({
  /** "team" for everyone, or a sales person's id (override). */
  scope: z.union([z.literal('team'), idSchema]),
  baseRate: z.coerce.number().min(0).max(100),
  bonusRate: z.coerce.number().min(0).max(100),
  basis: z.enum(['WON', 'COLLECTED']),
});
export type SetCommissionPlanRequest = z.infer<typeof setCommissionPlanRequestSchema>;

export interface CommissionPlanDto {
  scope: string;
  user: PublicUserDto | null;
  baseRate: number;
  bonusRate: number;
  basis: 'WON' | 'COLLECTED';
}

// ── Lead import ──

export const LEAD_IMPORT_FIELDS = [
  'companyName',
  'contactName',
  'contactTitle',
  'email',
  'phone',
  'website',
  'industry',
  'city',
  'country',
  'storeCount',
  'estimatedValue',
  'notes',
] as const;
export type LeadImportField = (typeof LEAD_IMPORT_FIELDS)[number];

export const leadImportPreviewRequestSchema = z.object({
  fileName: text(200).min(1),
  /** The .xlsx or .csv file, base64 encoded (max ~4 MB). */
  contentBase64: z.string().min(4).max(6_000_000),
});
export type LeadImportPreviewRequest = z.infer<typeof leadImportPreviewRequestSchema>;

export interface LeadImportRowDto {
  row: number;
  values: Partial<Record<LeadImportField, string>>;
  errors: string[];
  duplicate: { id: string; companyName: string; reason: string } | null;
}

export interface LeadImportPreviewDto {
  columns: string[];
  /** Which spreadsheet column fills each lead field (guessed from the headings). */
  mapping: Partial<Record<LeadImportField, string>>;
  rows: LeadImportRowDto[];
  truncated: boolean;
}

export const leadImportRequestSchema = z.object({
  source: createLeadRequestSchema.shape.source,
  ownerId: idSchema.nullable().optional(),
  rows: z
    .array(
      z.object({
        companyName: text(120).min(2),
        contactName: text(80).min(1),
        contactTitle: text(80).optional(),
        email: z.string().trim().email().max(254).optional(),
        phone: text(16).optional(),
        website: text(500).optional(),
        industry: text(80).optional(),
        city: text(100).optional(),
        country: z.string().trim().length(2).toUpperCase().optional(),
        storeCount: z.coerce.number().int().min(0).max(100_000).optional(),
        estimatedValue: z.coerce.number().int().min(0).max(1_000_000_000).optional(),
        notes: text(2000).optional(),
      }),
    )
    .min(1)
    .max(2000),
  /** Skip rows that match an existing lead (by email, phone or company name). */
  skipDuplicates: z.boolean().default(true),
});
export type LeadImportRequest = z.infer<typeof leadImportRequestSchema>;

export interface LeadImportResultDto {
  created: number;
  skipped: number;
}

export interface LeadDuplicateDto {
  id: string;
  companyName: string;
  contactName: string;
  stage: string;
  owner: PublicUserDto | null;
  reason: string;
}
