import { z } from 'zod';
import {
  emailSchema,
  httpUrlSchema,
  idSchema,
  passwordSchema,
  phoneSchema,
  usernameSchema,
} from './common';

/** The sales funnel, in order. WON and LOST close a lead. */
export const LEAD_STAGES = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'PROPOSAL',
  'NEGOTIATION',
  'WON',
  'LOST',
] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];
export const OPEN_LEAD_STAGES: readonly LeadStage[] = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'PROPOSAL',
  'NEGOTIATION',
];

export const LEAD_SOURCES = [
  'WEBSITE',
  'COLD_CALL',
  'REFERRAL',
  'SOCIAL_MEDIA',
  'EMAIL_CAMPAIGN',
  'EVENT',
  'WALK_IN',
  'PARTNER',
  'ADVERTISEMENT',
  'OTHER',
] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

/** Inbound: they came to us. Outbound: we reached out to them. */
export const LEAD_DIRECTIONS = ['INBOUND', 'OUTBOUND'] as const;
export type LeadDirection = (typeof LEAD_DIRECTIONS)[number];

/** Sources that are outbound unless said otherwise. */
export const OUTBOUND_SOURCES: readonly LeadSource[] = ['COLD_CALL', 'EMAIL_CAMPAIGN'];

/** What the prospect said or did after a call or message. */
export const ACTIVITY_OUTCOMES = [
  'INTERESTED',
  'NOT_INTERESTED',
  'NO_ANSWER',
  'CALL_BACK_LATER',
  'MEETING_BOOKED',
  'NEEDS_MORE_INFO',
  'WRONG_CONTACT',
] as const;
export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number];

/** An open lead is "stuck" after this long in one stage, or this long without any activity. */
export const STUCK_AFTER_DAYS_IN_STAGE = 14;
export const STUCK_AFTER_DAYS_IDLE = 7;

/** What a planned follow-up is. */
export const FOLLOW_UP_KINDS = ['MEETING', 'CALL', 'VISIT', 'WHATSAPP', 'EMAIL', 'OTHER'] as const;
export type FollowUpKind = (typeof FOLLOW_UP_KINDS)[number];

export const LEAD_ACTIVITY_TYPES = ['NOTE', 'CALL', 'EMAIL', 'MEETING', 'WHATSAPP'] as const;
export type LeadActivityKind = (typeof LEAD_ACTIVITY_TYPES)[number];

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable()
    .optional();

export const leadFieldsSchema = z.object({
  companyName: text(120).min(2),
  contactName: text(80).min(1),
  contactTitle: optionalText(80),
  email: emailSchema.nullable().optional(),
  phone: phoneSchema.nullable().optional(),
  website: httpUrlSchema.nullable().optional(),
  industry: optionalText(80),
  city: optionalText(100),
  country: z.string().trim().length(2).toUpperCase().nullable().optional(),
  /** How many stores or branches the prospect runs. */
  storeCount: z.number().int().min(0).max(100000).nullable().optional(),
  /** Expected monthly value of the deal. */
  estimatedValue: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  currency: z.string().trim().length(3).toUpperCase().default('PKR'),
  source: z.enum(LEAD_SOURCES),
  /** Defaults from the source (cold calls and email campaigns are outbound). */
  direction: z.enum(LEAD_DIRECTIONS).optional(),
  /** Campaign name, referrer, event… */
  sourceDetail: optionalText(160),
  notes: optionalText(2000),
  nextFollowUpAt: z.coerce.date().nullable().optional(),
  nextFollowUpKind: z.enum(FOLLOW_UP_KINDS).nullable().optional(),
  /** Place, agenda or what to say. */
  nextFollowUpNote: optionalText(300),
});

export const createLeadRequestSchema = leadFieldsSchema.extend({
  /** Managers may assign straight away; agents' new leads are their own. */
  ownerId: idSchema.nullable().optional(),
});
export type CreateLeadRequest = z.infer<typeof createLeadRequestSchema>;

export const updateLeadRequestSchema = leadFieldsSchema.partial();
export type UpdateLeadRequest = z.infer<typeof updateLeadRequestSchema>;

export const changeLeadStageRequestSchema = z
  .object({
    stage: z.enum(LEAD_STAGES),
    lostReason: optionalText(300),
  })
  .refine((v) => v.stage !== 'LOST' || !!v.lostReason, {
    message: 'Say why the lead was lost',
    path: ['lostReason'],
  });
export type ChangeLeadStageRequest = z.infer<typeof changeLeadStageRequestSchema>;

export const assignLeadRequestSchema = z.object({ ownerId: idSchema.nullable() });
export type AssignLeadRequest = z.infer<typeof assignLeadRequestSchema>;

export const addLeadActivityRequestSchema = z.object({
  type: z.enum(LEAD_ACTIVITY_TYPES),
  body: text(2000).min(1),
  /** The prospect's response (calls, messages, meetings). */
  outcome: z.enum(ACTIVITY_OUTCOMES).nullable().optional(),
  /** Set (or with null, clear) the next follow-up. */
  nextFollowUpAt: z.coerce.date().nullable().optional(),
  nextFollowUpKind: z.enum(FOLLOW_UP_KINDS).nullable().optional(),
  nextFollowUpNote: optionalText(300),
  /** This activity was the planned follow-up: it is done (cleared unless a new one is set). */
  completeFollowUp: z.boolean().optional(),
});
export type AddLeadActivityRequest = z.infer<typeof addLeadActivityRequestSchema>;

/** Won lead → a new SMA customer business (optionally with its first admin). */
export const convertLeadRequestSchema = z.object({
  businessName: text(120).min(2),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single dashes'),
  admin: z
    .object({
      displayName: text(80).min(1),
      username: usernameSchema,
      email: emailSchema,
      password: passwordSchema,
    })
    .optional(),
});
export type ConvertLeadRequest = z.infer<typeof convertLeadRequestSchema>;

export const listLeadsQuerySchema = z.object({
  stage: z.enum(LEAD_STAGES).optional(),
  source: z.enum(LEAD_SOURCES).optional(),
  direction: z.enum(LEAD_DIRECTIONS).optional(),
  stuck: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  ownerId: z.union([idSchema, z.literal('unassigned'), z.literal('me')]).optional(),
  q: z.string().trim().max(80).optional(),
  open: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type ListLeadsQuery = z.infer<typeof listLeadsQuerySchema>;

/** Follow-ups up to a time (the client sends the end of its day or week), overdue included. */
export const agendaQuerySchema = z.object({
  until: z.coerce.date(),
  mine: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
export type AgendaQuery = z.infer<typeof agendaQuerySchema>;

export const createSalesUserRequestSchema = z.object({
  displayName: text(80).min(1),
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
  roleKey: z.enum(['SALES_MANAGER', 'SALES_AGENT', 'ACCOUNTANT']),
});
export type CreateSalesUserRequest = z.infer<typeof createSalesUserRequestSchema>;

/** Public "Request a demo" form on the website. `website` is a honeypot for bots. */
export const publicLeadRequestSchema = z.object({
  companyName: text(120).min(2),
  contactName: text(80).min(1),
  email: emailSchema,
  phone: phoneSchema.optional(),
  city: text(100).optional(),
  country: z.string().trim().length(2).toUpperCase().optional(),
  storeCount: z.number().int().min(0).max(100000).optional(),
  message: text(1000).optional(),
  /** Where the form was filled in (e.g. the page of the company website). */
  sourceDetail: text(160).optional(),
  /** Short name of the business whose form this is (empty: SMA's own sales team). */
  business: z.string().trim().max(64).optional(),
  website: z.string().max(0, 'Leave this field empty').optional(),
});
export type PublicLeadRequest = z.infer<typeof publicLeadRequestSchema>;
