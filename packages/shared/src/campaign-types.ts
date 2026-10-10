/** Bulk campaign response shapes. Recipients are exposed as public profiles only. */
import type { MediaAssetDto, PublicUserDto } from './dto';
import type { CAMPAIGN_DELIVERY_BUCKETS, CampaignAudience } from './schemas/campaigns';

export type CampaignStatus =
  'DRAFT' | 'SCHEDULED' | 'SENDING' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';

/**
 * Where one recipient's copy is (mutually exclusive buckets):
 * QUEUED (not yet written) → ACCEPTED (persisted in their channel) → SENT_TO_GATEWAY
 * (worker emitted it) → DELIVERED (their device confirmed) → READ; or FAILED / SKIPPED / CANCELLED.
 */
export type CampaignDeliveryBucket = (typeof CAMPAIGN_DELIVERY_BUCKETS)[number];

export type CampaignCountsDto = Record<CampaignDeliveryBucket, number> & {
  total: number;
  /** false when the business turned read receipts off: READ is then reported as DELIVERED. */
  readReceipts: boolean;
};

export interface CampaignDto {
  id: string;
  businessId: string;
  name: string;
  description: string | null;
  body: string | null;
  media: MediaAssetDto | null;
  audience: CampaignAudience;
  status: CampaignStatus;
  scheduledAt: string | null;
  expiresAt: string | null;
  startedAt: string | null;
  pausedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdBy: PublicUserDto;
  createdAt: string;
  updatedAt: string;
  totalRecipients: number;
  /** Present once sending started. */
  counts: CampaignCountsDto | null;
}

export interface CampaignPreviewDto {
  /** People who would receive it now (after suppression and exclusions). */
  recipients: number;
  /** Matched but excluded by the suppression list or opt-out. */
  suppressed: number;
  requiresConfirmation: boolean;
  /** Tenant quota: largest allowed campaign. */
  maxRecipients: number;
}

export interface CampaignRecipientDto {
  user: PublicUserDto;
  status: CampaignDeliveryBucket;
  reason: string | null;
  processedAt: string | null;
}

export interface CampaignSuppressionDto {
  user: PublicUserDto;
  reason: 'ADMIN' | 'SELF_OPT_OUT';
  createdAt: string;
}
