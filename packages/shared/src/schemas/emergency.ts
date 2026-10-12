import { z } from 'zod';
import { idSchema } from './common';

export const EMERGENCY_CATEGORIES = [
  'MEDICAL',
  'FIRE',
  'SECURITY',
  'THEFT',
  'VIOLENCE',
  'ACCIDENT',
  'GAS_LEAK',
  'POWER_FAILURE',
  'NATURAL_DISASTER',
  'OTHER',
] as const;
export const INCIDENT_STATUSES = [
  'OPEN',
  'ESCALATED',
  'ACKNOWLEDGED',
  'RESOLVED',
  'CANCELLED',
] as const;
/** Incidents that still need attention. */
export const ACTIVE_INCIDENT_STATUSES = ['OPEN', 'ESCALATED', 'ACKNOWLEDGED'] as const;

export const EMERGENCY_MAX_CONTACTS = 5;
export const EMERGENCY_ACK_TIMEOUT = { min: 15, max: 1800, default: 120 } as const;

export const createIncidentRequestSchema = z.object({
  /** Required only when the caller works at more than one store. */
  storeId: idSchema.optional(),
  category: z.enum(EMERGENCY_CATEGORIES).default('OTHER'),
  description: z.string().trim().max(1000).optional(),
  /** Idempotency key: retries with the same key return the same incident. */
  clientIncidentId: idSchema,
});
export type CreateIncidentRequest = z.infer<typeof createIncidentRequestSchema>;

export const listIncidentsQuerySchema = z.object({
  active: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  storeId: idSchema.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ListIncidentsQuery = z.infer<typeof listIncidentsQuerySchema>;

export const resolveIncidentRequestSchema = z.object({
  note: z.string().trim().max(500).optional(),
});
export type ResolveIncidentRequest = z.infer<typeof resolveIncidentRequestSchema>;

/** Device receipts reported by the alerted client. Monotonic: never moves a state backwards. */
export const incidentReceiptRequestSchema = z.object({
  state: z.enum(['DELIVERED', 'READ']),
});
export type IncidentReceiptRequest = z.infer<typeof incidentReceiptRequestSchema>;

export const updateEmergencySettingsRequestSchema = z.object({
  ackTimeoutSeconds: z.number().int().min(EMERGENCY_ACK_TIMEOUT.min).max(EMERGENCY_ACK_TIMEOUT.max),
  /** Ordered: first = primary, second = backup, ... */
  contactUserIds: z
    .array(idSchema)
    .max(EMERGENCY_MAX_CONTACTS, `At most ${EMERGENCY_MAX_CONTACTS} emergency contacts`)
    .refine((ids) => new Set(ids).size === ids.length, 'Each person can be listed only once'),
});
export type UpdateEmergencySettingsRequest = z.infer<typeof updateEmergencySettingsRequestSchema>;
