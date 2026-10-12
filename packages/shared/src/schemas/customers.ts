import { z } from 'zod';
import { emailSchema, idSchema, phoneSchema } from './common';

/**
 * A business's own customers ("store customers"), recorded for future marketing. Not SMA's
 * customers (those are businesses won by the Sales team).
 */
export const storeCustomerFieldsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: phoneSchema.nullable().optional(),
  email: emailSchema.nullable().optional(),
  storeId: idSchema.nullable().optional(),
  city: z.string().trim().max(100).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(10).default([]),
  /** The customer agreed to receive marketing (only they are exported for campaigns). */
  marketingOptIn: z.boolean().default(false),
});

export const createStoreCustomerRequestSchema = storeCustomerFieldsSchema.refine(
  (v) => !!v.phone || !!v.email,
  { message: 'Add a phone number or an email address', path: ['phone'] },
);
export type CreateStoreCustomerRequest = z.infer<typeof createStoreCustomerRequestSchema>;

export const updateStoreCustomerRequestSchema = storeCustomerFieldsSchema.partial();
export type UpdateStoreCustomerRequest = z.infer<typeof updateStoreCustomerRequestSchema>;

export const listStoreCustomersQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  storeId: idSchema.optional(),
  optIn: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type ListStoreCustomersQuery = z.infer<typeof listStoreCustomersQuerySchema>;

export interface StoreCustomerDto {
  id: string;
  businessId: string;
  store: { id: string; name: string } | null;
  name: string;
  phone: string | null;
  email: string | null;
  city: string | null;
  notes: string | null;
  tags: string[];
  marketingOptIn: boolean;
  optInAt: string | null;
  addedBy: string | null;
  createdAt: string;
}

export interface StoreCustomerSummaryDto {
  total: number;
  optedIn: number;
}

// ───────────────────────────── Campaigns to store customers ─────────────────────────────

export const MARKETING_CHANNELS = ['EMAIL', 'SMS', 'WHATSAPP'] as const;
export type MarketingChannel = (typeof MARKETING_CHANNELS)[number];

/** Use {{name}} in the message to insert the customer's first name. */
export const CUSTOMER_CAMPAIGN_NAME_TOKEN = '{{name}}';

export const customerCampaignAudienceSchema = z.object({
  /** Empty: every store. */
  storeIds: z.array(idSchema).max(500).default([]),
  /** Empty: any tag. Customers with at least one of these tags. */
  tags: z.array(z.string().trim().toLowerCase().min(1).max(30)).max(20).default([]),
});
export type CustomerCampaignAudience = z.infer<typeof customerCampaignAudienceSchema>;

export const createCustomerCampaignRequestSchema = customerCampaignAudienceSchema
  .extend({
    name: z.string().trim().min(2).max(120),
    channel: z.enum(MARKETING_CHANNELS),
    /** Email subject (email only). */
    subject: z.string().trim().max(150).optional(),
    body: z.string().trim().min(1).max(1500),
  })
  .refine((v) => v.channel !== 'EMAIL' || !!v.subject, {
    message: 'Add an email subject',
    path: ['subject'],
  });
export type CreateCustomerCampaignRequest = z.infer<typeof createCustomerCampaignRequestSchema>;

export const previewCustomerCampaignRequestSchema = customerCampaignAudienceSchema.extend({
  channel: z.enum(MARKETING_CHANNELS),
});
export type PreviewCustomerCampaignRequest = z.infer<typeof previewCustomerCampaignRequestSchema>;

export const unsubscribeRequestSchema = z.object({
  c: idSchema,
  t: z.string().min(16).max(128),
});
export type UnsubscribeRequest = z.infer<typeof unsubscribeRequestSchema>;

export type CustomerCampaignStatus = 'DRAFT' | 'SENDING' | 'COMPLETED' | 'CANCELLED';
/** SENT means the provider accepted it, not that it reached the phone or inbox. */
export type CustomerRecipientState = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'SKIPPED';

export interface CustomerCampaignDto {
  id: string;
  businessId: string;
  name: string;
  channel: MarketingChannel;
  subject: string | null;
  body: string;
  audience: CustomerCampaignAudience;
  status: CustomerCampaignStatus;
  counts: { total: number; pending: number; sent: number; failed: number; skipped: number };
  createdBy: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CustomerCampaignDetailDto extends CustomerCampaignDto {
  recipients: Array<{
    customerId: string;
    name: string;
    destination: string;
    state: CustomerRecipientState;
    error: string | null;
    sentAt: string | null;
  }>;
}

export interface CustomerCampaignPreviewDto {
  /** Opted-in customers who have a contact for this channel. */
  recipients: number;
  /** Opted-in customers in the audience without an email (or phone) for this channel. */
  missingContact: number;
}

/** Which channels are set up on this server (keys present). */
export type MarketingChannelsDto = Record<MarketingChannel, boolean>;
