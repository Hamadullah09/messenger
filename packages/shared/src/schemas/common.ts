import { z } from 'zod';

export const idSchema = z.uuid();

/** Sign-in name: unique, lowercase, no spaces. People sign in with this, never their full name. */
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine((v) => !/\s/.test(v), 'Usernames cannot contain spaces')
  .min(3, 'Username must be at least 3 characters')
  .max(32, 'Username must be at most 32 characters')
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'Use letters, numbers, dots, dashes or underscores');

/** Length-based policy (NIST SP 800-63B minimum of 8): no composition rules, generous maximum. */
export const PASSWORD_MIN_LENGTH = 8;
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(128, 'Password must be at most 128 characters');

export const displayNameSchema = z.string().trim().min(1).max(80);

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single dashes');

export const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown time zone');

export const localeSchema = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, 'Use a locale like en or en-US');

export const paginationQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code');

export const emailSchema = z
  .email()
  .max(254)
  .transform((v) => v.toLowerCase());

/** Web links people can open: http(s) only, so javascript: and data: URLs are rejected. */
export const httpUrlSchema = z
  .url({ protocol: /^https?$/, error: 'Enter a full link starting with https://' })
  .max(500);

/** E.164 phone numbers only. */
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, 'Use international format, e.g. +14155550123');
