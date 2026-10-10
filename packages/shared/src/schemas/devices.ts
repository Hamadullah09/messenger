import { z } from 'zod';

/** Native clients send this header to receive/return refresh tokens in the body (no cookies). */
export const NATIVE_CLIENT_HEADER = 'x-sma-client';
export const NATIVE_CLIENT_VALUE = 'native';

export const DEVICE_PLATFORMS = ['WEB', 'DESKTOP', 'IOS', 'ANDROID'] as const;
export const PUSH_PROVIDERS = ['WEB_PUSH', 'FCM', 'APNS'] as const;
export const PUSH_PREVIEWS = ['NONE', 'SENDER', 'CONTENT'] as const;

export const registerDeviceRequestSchema = z.object({
  platform: z.enum(DEVICE_PLATFORMS),
  name: z.string().trim().min(1).max(80),
  appVersion: z.string().trim().max(32).optional(),
});
export type RegisterDeviceRequest = z.infer<typeof registerDeviceRequestSchema>;

/** A browser PushSubscription (PushSubscription.toJSON()). */
export const webPushSubscriptionSchema = z.object({
  endpoint: z.url().max(2048),
  keys: z.object({
    p256dh: z.string().min(40).max(200),
    auth: z.string().min(16).max(64),
  }),
});
export type WebPushSubscription = z.infer<typeof webPushSubscriptionSchema>;

export const registerPushRequestSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('WEB_PUSH'), subscription: webPushSubscriptionSchema }),
  z.object({ provider: z.literal('FCM'), token: z.string().min(20).max(4096) }),
  z.object({ provider: z.literal('APNS'), token: z.string().regex(/^[0-9a-fA-F]{64,200}$/) }),
]);
export type RegisterPushRequest = z.infer<typeof registerPushRequestSchema>;

export const notificationPreferencesSchema = z.object({
  pushEnabled: z.boolean(),
  preview: z.enum(PUSH_PREVIEWS),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export const nativeRefreshRequestSchema = z.object({
  refreshToken: z.string().min(20).max(200),
});
export type NativeRefreshRequest = z.infer<typeof nativeRefreshRequestSchema>;

export interface DeviceDto {
  id: string;
  platform: (typeof DEVICE_PLATFORMS)[number];
  name: string;
  appVersion: string | null;
  push: { provider: (typeof PUSH_PROVIDERS)[number]; updatedAt: string | null } | null;
  sessionId: string;
  lastUsedAt: string;
  createdAt: string;
  current: boolean;
}

export interface NotificationConfigDto {
  /** Which push providers this server can deliver to. */
  providers: Record<(typeof PUSH_PROVIDERS)[number], boolean>;
  /** VAPID public key for PushManager.subscribe (when Web Push is enabled). */
  webPushPublicKey: string | null;
}

/** Push payload contract shared with clients' service workers / native handlers. */
export interface PushPayload {
  type: 'message' | 'emergency';
  title: string;
  body: string;
  /** Where to open on tap. */
  url: string;
  conversationId?: string;
  incidentId?: string;
  /** Collapse key: newer notifications for the same conversation replace older ones. */
  tag: string;
}
