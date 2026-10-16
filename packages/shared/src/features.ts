/**
 * Parts of SMA the Super Admin can switch off for everyone (Settings → Features) without
 * removing them. Everything is on until switched off.
 */
import { z } from 'zod';

export const FEATURE_KEYS = ['STATUS', 'CALLS', 'ONLINE_PAYMENTS'] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const FEATURES: Record<FeatureKey, { label: string; description: string }> = {
  STATUS: {
    label: 'Status',
    description: '24-hour photo and text updates (the Status tab).',
  },
  CALLS: {
    label: 'Voice and video calls',
    description: 'Calls in chats and groups, and the Calls tab.',
  },
  ONLINE_PAYMENTS: {
    label: 'Online payments',
    description:
      'Paying invoices online with JazzCash or Easypaisa. When off, payments made elsewhere are still recorded by hand.',
  },
};

/** true = on. */
export type FeaturesDto = Record<FeatureKey, boolean>;

export const updateFeaturesRequestSchema = z.object({
  features: z.partialRecord(z.enum(FEATURE_KEYS), z.boolean()),
});
export type UpdateFeaturesRequest = z.infer<typeof updateFeaturesRequestSchema>;

/** Where each switch is stored (PlatformSetting key). */
export const featureSettingKey = (key: FeatureKey) => `FEATURE_${key}` as const;
export type FeatureSettingKey = ReturnType<typeof featureSettingKey>;
export const FEATURE_SETTING_KEYS = FEATURE_KEYS.map(featureSettingKey);
