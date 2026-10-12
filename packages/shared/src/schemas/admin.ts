import { z } from 'zod';
import { isPermission, type Permission } from '../authorization/permissions';
import {
  displayNameSchema,
  emailSchema,
  httpUrlSchema,
  idSchema,
  localeSchema,
  passwordSchema,
  phoneSchema,
  slugSchema,
  timeZoneSchema,
  usernameSchema,
} from './common';

export const addressSchema = z.object({
  line1: z.string().trim().max(200).optional(),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  /** State, province or region. */
  region: z.string().trim().max(100).optional(),
  postalCode: z.string().trim().max(20).optional(),
  /** ISO 3166-1 alpha-2 country code, e.g. PK, US, GB. */
  country: z.string().trim().length(2).toUpperCase().optional(),
});
export type Address = z.infer<typeof addressSchema>;

export const SOCIAL_NETWORKS = [
  'facebook',
  'instagram',
  'x',
  'linkedin',
  'tiktok',
  'youtube',
  'whatsapp',
] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];

export const socialLinksSchema = z.partialRecord(z.enum(SOCIAL_NETWORKS), httpUrlSchema);
export type SocialLinks = z.infer<typeof socialLinksSchema>;

/** Public details of a business or store. Send null to clear a field. */
export const placeDetailsSchema = z.object({
  description: z.string().trim().max(500).nullable().optional(),
  phone: phoneSchema.nullable().optional(),
  email: emailSchema.nullable().optional(),
  website: httpUrlSchema.nullable().optional(),
  /** Link to the location on a map (Google Maps, OpenStreetMap, Apple Maps…). */
  mapUrl: httpUrlSchema.nullable().optional(),
  address: addressSchema.nullable().optional(),
  socialLinks: socialLinksSchema.optional(),
});
export type PlaceDetails = z.infer<typeof placeDetailsSchema>;

export const createBusinessRequestSchema = placeDetailsSchema.extend({
  name: z.string().trim().min(2).max(120),
  slug: slugSchema,
  timeZone: timeZoneSchema.default('UTC'),
  locale: localeSchema.default('en'),
});
export type CreateBusinessRequest = z.infer<typeof createBusinessRequestSchema>;

export const businessPolicySchema = z.object({
  readReceiptsEnabled: z.boolean(),
  presenceEnabled: z.boolean(),
  messageEditWindowMinutes: z.number().int().min(0).max(1440),
  messageDeleteWindowMinutes: z.number().int().min(0).max(10080),
  directMessagesAcrossStores: z.boolean(),
  /** Per-kind upload limits in MB; the platform maximum (MEDIA_PLATFORM_MAX_MB) still applies. */
  maxImageMb: z.number().int().min(1).max(1024),
  maxVideoMb: z.number().int().min(1).max(1024),
  maxDocumentMb: z.number().int().min(1).max(1024),
  /** Allow message text in push notifications (lock screens). Off: sender name at most. */
  pushContentAllowed: z.boolean(),
});
export type BusinessPolicy = z.infer<typeof businessPolicySchema>;

export const DEFAULT_BUSINESS_POLICY: BusinessPolicy = {
  readReceiptsEnabled: true,
  presenceEnabled: true,
  messageEditWindowMinutes: 15,
  messageDeleteWindowMinutes: 60,
  directMessagesAcrossStores: false,
  maxImageMb: 25,
  maxVideoMb: 200,
  maxDocumentMb: 200,
  pushContentAllowed: false,
};

/** Parse stored policy JSON, falling back to defaults for missing or invalid fields. */
export function resolveBusinessPolicy(stored: unknown): BusinessPolicy {
  const parsed = businessPolicySchema.partial().safeParse(stored ?? {});
  return { ...DEFAULT_BUSINESS_POLICY, ...(parsed.success ? parsed.data : {}) };
}

export const updateBusinessRequestSchema = placeDetailsSchema.extend({
  name: z.string().trim().min(2).max(120).optional(),
  timeZone: timeZoneSchema.optional(),
  locale: localeSchema.optional(),
  policy: businessPolicySchema.partial().optional(),
});
export type UpdateBusinessRequest = z.infer<typeof updateBusinessRequestSchema>;

export const createStoreRequestSchema = placeDetailsSchema.extend({
  name: z.string().trim().min(2).max(120),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(1)
    .max(16)
    .regex(/^[A-Z0-9-]+$/, 'Use letters, numbers and dashes'),
  timeZone: timeZoneSchema.optional(),
});
export type CreateStoreRequest = z.infer<typeof createStoreRequestSchema>;

export const updateStoreRequestSchema = createStoreRequestSchema.partial();
export type UpdateStoreRequest = z.infer<typeof updateStoreRequestSchema>;

export const systemRoleKeySchema = z.enum([
  'SUPER_ADMIN',
  'SALES_MANAGER',
  'SALES_AGENT',
  'BUSINESS_OWNER',
  'BUSINESS_ADMIN',
  'BUSINESS_MANAGER',
  'STORE_MANAGER',
  'SECURITY',
  'EMPLOYEE',
  'CUSTOMER',
]);

export const createUserRequestSchema = z.object({
  username: usernameSchema,
  displayName: displayNameSchema,
  /** Initial password. The user must change it at first sign-in. */
  initialPassword: passwordSchema,
  kind: z.enum(['INTERNAL', 'EXTERNAL']).default('INTERNAL'),
  storeIds: z.array(idSchema).max(200).default([]),
  /** System role granted at each listed store (store roles) or at the business (business roles). */
  roleKey: systemRoleKeySchema.exclude(['SUPER_ADMIN']).default('EMPLOYEE'),
  /** Every account is bound to an email address (used for password resets). */
  email: emailSchema,
  phone: phoneSchema.optional(),
  /** Off: the person signs in with this password as is (no forced change). */
  mustChangePassword: z.boolean().default(true),
});
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

export const updateUserRequestSchema = z.object({
  displayName: displayNameSchema.optional(),
  username: usernameSchema.optional(),
});

/** Replaces a person's system role in one business (and, for store roles, their stores). */
export const setUserRoleRequestSchema = z.object({
  roleKey: systemRoleKeySchema.exclude(['SUPER_ADMIN']),
  storeIds: z.array(idSchema).max(200).default([]),
});
export type SetUserRoleRequest = z.infer<typeof setUserRoleRequestSchema>;

/** An administrator (or the person's store manager) sets a new password. */
export const adminSetPasswordRequestSchema = z.object({
  newPassword: passwordSchema,
  mustChangePassword: z.boolean().default(false),
});
export type AdminSetPasswordRequest = z.infer<typeof adminSetPasswordRequestSchema>;
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

export const setUserStoresRequestSchema = z.object({
  storeIds: z.array(idSchema).max(200),
});
export type SetUserStoresRequest = z.infer<typeof setUserStoresRequestSchema>;

export const updateUserContactRequestSchema = z.object({
  email: emailSchema.nullable().optional(),
  phone: phoneSchema.nullable().optional(),
});
export type UpdateUserContactRequest = z.infer<typeof updateUserContactRequestSchema>;

export const permissionKeySchema = z
  .string()
  .refine((value): value is Permission => isPermission(value), 'Unknown permission');

export const createRoleRequestSchema = z.object({
  key: z
    .string()
    .trim()
    .toUpperCase()
    .min(2)
    .max(48)
    .regex(/^[A-Z][A-Z0-9_]*$/, 'Use UPPER_SNAKE_CASE'),
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).optional(),
  allowedScopes: z.array(z.enum(['BUSINESS', 'STORE'])).min(1),
  permissions: z.array(permissionKeySchema).min(1).max(100),
});
export type CreateRoleRequest = z.infer<typeof createRoleRequestSchema>;

export const createRoleAssignmentRequestSchema = z.discriminatedUnion('scopeType', [
  z.object({ roleId: idSchema, scopeType: z.literal('PLATFORM') }),
  z.object({ roleId: idSchema, scopeType: z.literal('BUSINESS'), businessId: idSchema }),
  z.object({
    roleId: idSchema,
    scopeType: z.literal('STORE'),
    businessId: idSchema,
    storeId: idSchema,
  }),
]);
export type CreateRoleAssignmentRequest = z.infer<typeof createRoleAssignmentRequestSchema>;

export const listUsersQuerySchema = z.object({
  query: z.string().trim().max(80).optional(),
  storeId: idSchema.optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DEACTIVATED']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

export const auditQuerySchema = z.object({
  businessId: idSchema.optional(),
  action: z.string().max(80).optional(),
  actorUserId: idSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;
