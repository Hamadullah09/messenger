/**
 * CRM for SMA's own sales: services catalog, deals (new business and upsell), invoices,
 * payments and monthly targets. Amounts are plain numbers with 2 decimals.
 */
import { z } from 'zod';
import type { PublicUserDto } from './dto';
import { idSchema } from './schemas/common';

const currencyField = z.enum(['USD', 'PKR']);

export const SERVICE_BILLINGS = ['ONE_TIME', 'MONTHLY', 'YEARLY'] as const;
export type ServiceBilling = (typeof SERVICE_BILLINGS)[number];
export const DEAL_TYPES = ['NEW_BUSINESS', 'UPSELL', 'RENEWAL'] as const;
export type DealType = (typeof DEAL_TYPES)[number];
export const DEAL_STATUSES = ['OPEN', 'WON', 'LOST'] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];
export const INVOICE_STATUSES = ['DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const PAYMENT_METHODS = [
  'CASH',
  'BANK_TRANSFER',
  'CARD',
  'CHEQUE',
  'ONLINE',
  'OTHER',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

const text = (max: number) => z.string().trim().max(max);
const money = z.coerce.number().min(0).max(99_999_999).multipleOf(0.01, 'Use at most 2 decimals');
/** "2026-10" */
export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');

// ── Services ──

export const upsertServiceRequestSchema = z.object({
  name: text(120).min(1, 'Name the service'),
  description: text(1000).nullable().optional(),
  category: text(60).nullable().optional(),
  price: money,
  currency: currencyField.default('USD'),
  billing: z.enum(SERVICE_BILLINGS).default('ONE_TIME'),
  active: z.boolean().optional(),
});
export type UpsertServiceRequest = z.infer<typeof upsertServiceRequestSchema>;

// ── Deals ──

export const lineItemSchema = z.object({
  /** From the catalog (name and price are copied, and can be changed). */
  serviceId: idSchema.nullable().optional(),
  name: text(160).min(1, 'Name each item'),
  quantity: z.coerce.number().int().min(1).max(100_000),
  unitPrice: money,
  discountPct: z.coerce.number().min(0).max(100).default(0),
  billing: z.enum(SERVICE_BILLINGS).default('ONE_TIME'),
});
export type LineItemInput = z.infer<typeof lineItemSchema>;

export const createDealRequestSchema = z
  .object({
    title: text(160).min(1, 'Name the deal'),
    type: z.enum(DEAL_TYPES),
    /** New business: the lead. */
    leadId: idSchema.nullable().optional(),
    /** Upsell / renewal: the existing SMA customer. */
    businessId: idSchema.nullable().optional(),
    ownerId: idSchema.nullable().optional(),
    currency: currencyField.optional(),
    expectedCloseAt: z.coerce.date().nullable().optional(),
    notes: text(2000).nullable().optional(),
    items: z.array(lineItemSchema).min(1, 'Add at least one service').max(50),
  })
  .refine((d) => d.type === 'NEW_BUSINESS' || !!d.businessId || !!d.leadId, {
    message: 'Choose the customer',
    path: ['businessId'],
  })
  .refine((d) => d.type !== 'NEW_BUSINESS' || !!d.leadId || !!d.businessId, {
    message: 'Choose the lead',
    path: ['leadId'],
  });
export type CreateDealRequest = z.infer<typeof createDealRequestSchema>;

export const updateDealRequestSchema = z.object({
  title: text(160).min(1).optional(),
  ownerId: idSchema.nullable().optional(),
  expectedCloseAt: z.coerce.date().nullable().optional(),
  notes: text(2000).nullable().optional(),
  items: z.array(lineItemSchema).min(1).max(50).optional(),
});
export type UpdateDealRequest = z.infer<typeof updateDealRequestSchema>;

export const changeDealStatusRequestSchema = z
  .object({
    status: z.enum(DEAL_STATUSES),
    lostReason: text(300).optional(),
    /** Count the win in this month instead of today (e.g. a sale closed last week). */
    closedAt: z.coerce.date().optional(),
  })
  .refine((d) => d.status !== 'LOST' || !!d.lostReason, {
    message: 'Say why it was lost',
    path: ['lostReason'],
  });
export type ChangeDealStatusRequest = z.infer<typeof changeDealStatusRequestSchema>;

export const listDealsQuerySchema = z.object({
  status: z.enum(DEAL_STATUSES).optional(),
  type: z.enum(DEAL_TYPES).optional(),
  ownerId: z.union([idSchema, z.literal('me')]).optional(),
  businessId: idSchema.optional(),
  leadId: idSchema.optional(),
  q: z.string().trim().max(100).optional(),
});
export type ListDealsQuery = z.infer<typeof listDealsQuerySchema>;

// ── Invoices and payments ──

const invoiceItemsSchema = z
  .array(
    z.object({
      serviceId: idSchema.nullable().optional(),
      name: text(160).min(1),
      description: text(500).nullable().optional(),
      quantity: z.coerce.number().int().min(1).max(100_000),
      unitPrice: money,
    }),
  )
  .max(50);

export const createInvoiceRequestSchema = z
  .object({
    /** Bill a won deal (copies its items and customer). */
    dealId: idSchema.optional(),
    businessId: idSchema.nullable().optional(),
    leadId: idSchema.nullable().optional(),
    billToName: text(160).min(1).optional(),
    billToEmail: z.string().trim().email().max(254).nullable().optional(),
    billToPhone: text(16).nullable().optional(),
    billToAddress: text(500).nullable().optional(),
    currency: currencyField.optional(),
    issueDate: z.coerce.date().optional(),
    dueDate: z.coerce.date().optional(),
    discount: money.default(0),
    taxRate: z.coerce.number().min(0).max(100).optional(),
    notes: text(2000).nullable().optional(),
    items: invoiceItemsSchema.optional(),
  })
  .refine((i) => i.dealId || (i.items && i.items.length > 0), {
    message: 'Add at least one item',
    path: ['items'],
  })
  .refine((i) => i.dealId || i.businessId || i.leadId || i.billToName, {
    message: 'Choose who the invoice is for',
    path: ['billToName'],
  });
export type CreateInvoiceRequest = z.infer<typeof createInvoiceRequestSchema>;

/** Only drafts can be changed. */
export const updateInvoiceRequestSchema = z.object({
  billToName: text(160).min(1).optional(),
  billToEmail: z.string().trim().email().max(254).nullable().optional(),
  billToPhone: text(16).nullable().optional(),
  billToAddress: text(500).nullable().optional(),
  issueDate: z.coerce.date().optional(),
  dueDate: z.coerce.date().optional(),
  discount: money.optional(),
  taxRate: z.coerce.number().min(0).max(100).optional(),
  notes: text(2000).nullable().optional(),
  items: invoiceItemsSchema.min(1).optional(),
});
export type UpdateInvoiceRequest = z.infer<typeof updateInvoiceRequestSchema>;

export const recordPaymentRequestSchema = z.object({
  amount: z.coerce.number().positive().max(99_999_999).multipleOf(0.01),
  paidAt: z.coerce.date().optional(),
  method: z.enum(PAYMENT_METHODS),
  reference: text(120).nullable().optional(),
  notes: text(500).nullable().optional(),
});
export type RecordPaymentRequest = z.infer<typeof recordPaymentRequestSchema>;

export const listInvoicesQuerySchema = z.object({
  status: z.enum([...INVOICE_STATUSES, 'OVERDUE', 'UNPAID']).optional(),
  businessId: idSchema.optional(),
  dealId: idSchema.optional(),
  q: z.string().trim().max(100).optional(),
});
export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;

// ── Targets ──

export const setTargetRequestSchema = z.object({
  userId: idSchema,
  month: monthSchema,
  amount: money,
});
export type SetTargetRequest = z.infer<typeof setTargetRequestSchema>;

// ── DTOs ──

export interface CrmServiceDto {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  price: number;
  currency: string;
  billing: ServiceBilling;
  active: boolean;
  /** How many won deals included it. */
  timesSold: number;
}

export interface LineItemDto {
  id: string;
  serviceId: string | null;
  name: string;
  quantity: number;
  unitPrice: number;
  discountPct: number;
  total: number;
  billing: ServiceBilling;
}

export interface DealDto {
  id: string;
  title: string;
  type: DealType;
  status: DealStatus;
  lead: { id: string; companyName: string; stage: string } | null;
  customer: CrmCustomerRef | null;
  owner: PublicUserDto | null;
  amount: number;
  currency: string;
  expectedCloseAt: string | null;
  closedAt: string | null;
  lostReason: string | null;
  notes: string | null;
  items: LineItemDto[];
  /** Recurring subscription created from this deal. */
  subscriptionId: string | null;
  /** Invoiced and paid so far (non-void invoices). */
  invoiced: number;
  paid: number;
  invoiceCount: number;
  createdAt: string;
  canEdit: boolean;
}

export interface PaymentDto {
  id: string;
  amount: number;
  paidAt: string;
  method: PaymentMethod;
  reference: string | null;
  notes: string | null;
  recordedBy: PublicUserDto | null;
  voided: boolean;
}

export interface InvoiceDto {
  id: string;
  number: string;
  status: InvoiceStatus;
  /** Issued, not fully paid and past the due date. */
  overdue: boolean;
  deal: { id: string; title: string; type: DealType } | null;
  customer: CrmCustomerRef | null;
  lead: { id: string; companyName: string } | null;
  billToName: string;
  billToEmail: string | null;
  billToPhone: string | null;
  billToAddress: string | null;
  /** Buyer NTN/CNIC (FBR invoices). */
  billToTaxNumber: string | null;
  issueDate: string;
  dueDate: string;
  currency: string;
  subtotal: number;
  discount: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  amountPaid: number;
  balance: number;
  notes: string | null;
  items: Array<{
    id: string;
    serviceId: string | null;
    name: string;
    description: string | null;
    quantity: number;
    unitPrice: number;
    total: number;
  }>;
  payments: PaymentDto[];
  issuedAt: string | null;
  paidAt: string | null;
  lastEmailedAt: string | null;
  subscription: { id: string; name: string } | null;
  periodStart: string | null;
  periodEnd: string | null;
  reminderCount: number;
  lastReminderAt: string | null;
  /** The customer's pay page (null for drafts and void invoices). */
  payUrl: string | null;
  pendingClaims: number;
  /** FBR Digital Invoicing: the number FBR gave (with a QR code to print), or the last error. */
  fbr: {
    invoiceNumber: string | null;
    submittedAt: string | null;
    sandbox: boolean | null;
    error: string | null;
    qrDataUrl: string | null;
  } | null;
  createdAt: string;
  canManage: boolean;
}

/** One SMA customer with what they bought and owe. */
/**
 * Who a deal, quote, invoice or monthly billing is for: a business on SMA (SMA's own CRM) or a
 * won lead (a business's own CRM).
 */
export interface CrmCustomerRef {
  id: string;
  name: string;
  kind: 'BUSINESS' | 'LEAD';
}

export interface CrmCustomerDto {
  id: string;
  kind: 'BUSINESS' | 'LEAD';
  name: string;
  slug: string;
  status: string;
  createdAt: string;
  /** The lead they came from. */
  lead: { id: string; owner: PublicUserDto | null; convertedAt: string | null } | null;
  storeCount: number;
  wonDeals: number;
  upsells: number;
  lifetimeValue: number;
  invoiced: number;
  paid: number;
  outstanding: number;
  openDeals: number;
  /** Services they have (from won deals). */
  services: string[];
}

export interface TargetProgressDto {
  user: PublicUserDto;
  month: string;
  target: number | null;
  /** Value of deals won this month. */
  achieved: number;
  /** achieved ÷ target (0–∞), null without a target. */
  progress: number | null;
  wonDeals: number;
  upsells: number;
  /** Leads closed this month (won + lost) and won. */
  leadsClosed: number;
  leadsWon: number;
  /** Payments received this month on the person's deals. */
  collected: number;
  /** Commission earned this month (in the targets' currency). */
  commission: number;
  commissionPlan: {
    baseRate: number;
    bonusRate: number;
    basis: 'WON' | 'COLLECTED';
    custom: boolean;
  };
}

export interface TargetsDto {
  month: string;
  currency: string;
  team: TargetProgressDto[];
  totals: { target: number; achieved: number; collected: number; commission: number };
  canManage: boolean;
}

export interface TargetHistoryDto {
  user: PublicUserDto;
  currency: string;
  months: Array<{
    month: string;
    target: number | null;
    achieved: number;
    leadsWon: number;
    commission: number;
  }>;
}

export interface CrmOverviewDto {
  currency: string;
  month: string;
  wonThisMonth: number;
  wonCountThisMonth: number;
  upsellThisMonth: number;
  openPipeline: number;
  openDeals: number;
  invoicedThisMonth: number;
  collectedThisMonth: number;
  outstanding: number;
  overdue: number;
  overdueCount: number;
  /** Last 6 months: won value and collected. */
  trend: Array<{ month: string; won: number; collected: number }>;
  topServices: Array<{ name: string; count: number; value: number }>;
  canManageBilling: boolean;
  canManageCatalog: boolean;
  canManageTargets: boolean;
}
