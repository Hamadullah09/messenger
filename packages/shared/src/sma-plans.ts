import { z } from 'zod';

/**
 * What SMA charges businesses. Prices come from SMA's own Services catalog (Sales → Services
 * of the SMA sales team, editable in the app); the limits are set here and applied to the
 * business's quota.
 */
export const SMA_PLAN_KEYS = ['TRIAL', 'STARTER', 'BUSINESS', 'ENTERPRISE'] as const;
export type SmaPlanKey = (typeof SMA_PLAN_KEYS)[number];

export interface SmaPlanDefinition {
  key: SmaPlanKey;
  name: string;
  /** The service in SMA's catalog that holds the price (none for the trial). */
  serviceName: string | null;
  /** Default monthly price (USD) when the catalog has no such service yet. */
  defaultPrice: number;
  /** Priced per store (quantity = active stores) or one flat price. */
  perStore: boolean;
  limits: {
    maxStores: number;
    maxUsers: number;
    maxStorageGb: number;
    /** Largest customer campaign (0 = campaigns not included). */
    maxCampaignSize: number;
  };
  summary: string;
}

export const SMA_PLANS: Record<SmaPlanKey, SmaPlanDefinition> = {
  TRIAL: {
    key: 'TRIAL',
    name: 'Free trial',
    serviceName: null,
    defaultPrice: 0,
    perStore: false,
    limits: { maxStores: 3, maxUsers: 50, maxStorageGb: 5, maxCampaignSize: 500 },
    summary: '14 days, up to 3 stores and 50 people',
  },
  STARTER: {
    key: 'STARTER',
    name: 'SMA Starter',
    serviceName: 'SMA Starter',
    defaultPrice: 29,
    perStore: true,
    limits: { maxStores: 1, maxUsers: 25, maxStorageGb: 10, maxCampaignSize: 0 },
    summary: 'One store: team chat, groups, calls, store work and the emergency button',
  },
  BUSINESS: {
    key: 'BUSINESS',
    name: 'SMA Business',
    serviceName: 'SMA Business',
    defaultPrice: 49,
    perStore: true,
    limits: { maxStores: 25, maxUsers: 500, maxStorageGb: 100, maxCampaignSize: 20_000 },
    summary: 'Up to 25 stores, Sales & Marketing, customer campaigns and admin roles',
  },
  ENTERPRISE: {
    key: 'ENTERPRISE',
    name: 'SMA Enterprise',
    serviceName: 'SMA Enterprise',
    defaultPrice: 499,
    perStore: false,
    limits: { maxStores: 500, maxUsers: 5_000, maxStorageGb: 1_000, maxCampaignSize: 100_000 },
    summary: 'Unlimited-size chains (up to 500 stores), priority support',
  },
};

export const TRIAL_DAYS = 14;

export type SmaPlanStatus = 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELLED';

/** A plan with its current price (Super Admin's plan picker). */
export interface SmaPlanOptionDto {
  key: SmaPlanKey;
  name: string;
  summary: string;
  price: number;
  currency: string;
  perStore: boolean;
  limits: SmaPlanDefinition['limits'];
}

/** A business's plan, limits, usage and SMA invoices (Administration → Plan & billing). */
export interface BusinessBillingDto {
  businessId: string;
  plan: SmaPlanKey;
  planName: string;
  status: SmaPlanStatus;
  trialEndsAt: string | null;
  /** Monthly price now (per store × stores, or flat). Null on the trial or when billed by hand. */
  monthlyAmount: number | null;
  currency: string;
  /** Billed automatically by SMA (otherwise arranged by hand). */
  autoBilled: boolean;
  nextInvoiceAt: string | null;
  limits: SmaPlanDefinition['limits'];
  usage: { stores: number; users: number; storageGb: number };
  invoices: Array<{
    id: string;
    number: string;
    status: string;
    total: number;
    balance: number;
    currency: string;
    issueDate: string;
    dueDate: string;
    overdue: boolean;
    payUrl: string | null;
  }>;
  canChangePlan: boolean;
}

export const setBusinessPlanRequestSchema = z.object({
  plan: z.enum(SMA_PLAN_KEYS),
  /** Bill monthly through SMA's CRM (otherwise the limits apply and billing is arranged by hand). */
  autoBill: z.boolean().default(true),
  /** First invoice date (paid plans); default today. */
  startDate: z.coerce.date().optional(),
  /** Trial: how many days (default 14). */
  trialDays: z.coerce.number().int().min(1).max(90).optional(),
});
export type SetBusinessPlanRequest = z.infer<typeof setBusinessPlanRequestSchema>;
