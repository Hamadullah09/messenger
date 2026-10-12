import { z } from 'zod';
import { idSchema } from './common';

/** Broadcasts above this many recipients need the sender to confirm the exact count. */
export const LARGE_CAMPAIGN_THRESHOLD = 1000;
export const CAMPAIGN_BODY_MAX = 4000;

export const CAMPAIGN_ROLE_FILTERS = [
  'BUSINESS_OWNER',
  'BUSINESS_ADMIN',
  'BUSINESS_MANAGER',
  'STORE_MANAGER',
  'SECURITY',
  'EMPLOYEE',
] as const;

/**
 * Who receives a campaign, always within one business. Segments are combined (union);
 * `roleKeys` then narrows to people holding one of those roles. Resolved on the server only.
 */
export const campaignAudienceSchema = z
  .object({
    /** Every active internal member of the business. */
    everyone: z.boolean().default(false),
    storeIds: z.array(idSchema).max(500).default([]),
    groupIds: z.array(idSchema).max(200).default([]),
    roleKeys: z.array(z.enum(CAMPAIGN_ROLE_FILTERS)).max(6).default([]),
    /** External customers in the segments (they can opt out). */
    includeCustomers: z.boolean().default(false),
  })
  .refine(
    (a) => a.everyone || a.storeIds.length > 0 || a.groupIds.length > 0,
    'Choose who should receive this campaign',
  );
export type CampaignAudience = z.infer<typeof campaignAudienceSchema>;

const contentFields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullish(),
  body: z.string().trim().max(CAMPAIGN_BODY_MAX).nullish(),
  mediaId: idSchema.nullish(),
  audience: campaignAudienceSchema,
  expiresAt: z.iso.datetime({ offset: true }).nullish(),
};

export const createCampaignRequestSchema = z
  .object({ clientCampaignId: idSchema, businessId: idSchema, ...contentFields })
  .refine((c) => !!c.body || !!c.mediaId, 'Write a message or attach a file');
export type CreateCampaignRequest = z.infer<typeof createCampaignRequestSchema>;

export const updateCampaignRequestSchema = z.object({
  name: contentFields.name.optional(),
  description: contentFields.description,
  body: contentFields.body,
  mediaId: contentFields.mediaId,
  audience: campaignAudienceSchema.optional(),
  expiresAt: contentFields.expiresAt,
});
export type UpdateCampaignRequest = z.infer<typeof updateCampaignRequestSchema>;

export const sendCampaignRequestSchema = z.object({
  /** Required when the audience is larger than LARGE_CAMPAIGN_THRESHOLD: must equal the preview. */
  confirmRecipientCount: z.number().int().min(0).optional(),
});
export type SendCampaignRequest = z.infer<typeof sendCampaignRequestSchema>;

export const scheduleCampaignRequestSchema = sendCampaignRequestSchema.extend({
  scheduledAt: z.iso.datetime({ offset: true }),
});
export type ScheduleCampaignRequest = z.infer<typeof scheduleCampaignRequestSchema>;

export const CAMPAIGN_DELIVERY_BUCKETS = [
  'QUEUED',
  'ACCEPTED',
  'SENT_TO_GATEWAY',
  'DELIVERED',
  'READ',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
] as const;

export const listCampaignRecipientsQuerySchema = z.object({
  status: z.enum(CAMPAIGN_DELIVERY_BUCKETS).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListCampaignRecipientsQuery = z.infer<typeof listCampaignRecipientsQuerySchema>;

export const suppressionRequestSchema = z.object({ userId: idSchema });
export type SuppressionRequest = z.infer<typeof suppressionRequestSchema>;
