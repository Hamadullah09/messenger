import { z } from 'zod';
import { idSchema } from './common';

/**
 * Structured message contents (WhatsApp's attach menu): location, contact card, poll, event and
 * stickers, plus the details of voice notes. What is stored and sent to clients is `MessageMeta`
 * in dto.ts; these are the request shapes.
 */

export const POLL_OPTIONS_MAX = 12;
export const LIVE_LOCATION_MINUTES = [15, 60, 480] as const;
/** Longest voice note (WhatsApp allows long ones; keep uploads reasonable). */
export const VOICE_NOTE_MAX_MS = 15 * 60_000;

/** Built-in sticker pack. Stickers are big emoji drawn as stickers (no image files to host). */
export const STICKERS = [
  { id: 'thumbs-up', emoji: '👍', label: 'Thumbs up' },
  { id: 'heart', emoji: '❤️', label: 'Heart' },
  { id: 'laugh', emoji: '😂', label: 'Laughing' },
  { id: 'love', emoji: '😍', label: 'Love it' },
  { id: 'wow', emoji: '😮', label: 'Wow' },
  { id: 'sad', emoji: '😢', label: 'Sad' },
  { id: 'pray', emoji: '🙏', label: 'Thank you' },
  { id: 'clap', emoji: '👏', label: 'Well done' },
  { id: 'party', emoji: '🎉', label: 'Celebrate' },
  { id: 'fire', emoji: '🔥', label: 'Fire' },
  { id: 'hundred', emoji: '💯', label: '100' },
  { id: 'ok', emoji: '👌', label: 'OK' },
  { id: 'cool', emoji: '😎', label: 'Cool' },
  { id: 'thinking', emoji: '🤔', label: 'Thinking' },
  { id: 'muscle', emoji: '💪', label: 'Strong' },
  { id: 'rocket', emoji: '🚀', label: 'Rocket' },
  { id: 'star', emoji: '🌟', label: 'Star' },
  { id: 'coffee', emoji: '☕', label: 'Coffee break' },
  { id: 'box', emoji: '📦', label: 'Delivery' },
  { id: 'cart', emoji: '🛒', label: 'Shopping' },
  { id: 'money', emoji: '💰', label: 'Sales' },
  { id: 'trophy', emoji: '🏆', label: 'Winner' },
  { id: 'wave', emoji: '👋', label: 'Hello' },
  { id: 'sleep', emoji: '😴', label: 'Tired' },
] as const;
export type StickerId = (typeof STICKERS)[number]['id'];
const stickerIds = STICKERS.map((s) => s.id) as [StickerId, ...StickerId[]];

const text = (max: number) => z.string().trim().max(max);

export const locationContentSchema = z.object({
  kind: z.literal('LOCATION'),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100_000).optional(),
  /** Place name, e.g. a store. */
  name: text(120).optional(),
  address: text(300).optional(),
  /** Share live location for this many minutes (updates while the sender's app is open). */
  liveMinutes: z
    .union([z.literal(15), z.literal(60), z.literal(480)])
    .optional(),
});

export const contactContentSchema = z.object({
  kind: z.literal('CONTACT'),
  userId: idSchema,
});

export const pollContentSchema = z.object({
  kind: z.literal('POLL'),
  question: text(255).min(1, 'Ask a question'),
  options: z
    .array(text(100).min(1, 'Options cannot be empty'))
    .min(2, 'Add at least 2 options')
    .max(POLL_OPTIONS_MAX, `At most ${POLL_OPTIONS_MAX} options`)
    .refine(
      (o) => new Set(o.map((v) => v.toLowerCase())).size === o.length,
      'Options must be different',
    ),
  /** Allow choosing more than one option. */
  multiple: z.boolean().default(false),
});

export const eventContentSchema = z
  .object({
    kind: z.literal('EVENT'),
    title: text(120).min(1, 'Give the event a name'),
    description: text(1000).optional(),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date().optional(),
    location: text(200).optional(),
  })
  .refine((e) => !e.endsAt || e.endsAt > e.startsAt, {
    message: 'The end must be after the start',
    path: ['endsAt'],
  });

export const stickerContentSchema = z.object({
  kind: z.literal('STICKER'),
  sticker: z.enum(stickerIds),
});

export const richContentSchema = z.union([
  locationContentSchema,
  contactContentSchema,
  pollContentSchema,
  eventContentSchema,
  stickerContentSchema,
]);
export type RichContent = z.infer<typeof richContentSchema>;

/** Sent with an AUDIO attachment. */
export const audioDetailsSchema = z.object({
  /** Recorded in the app (voice note) rather than an audio file. */
  voice: z.boolean(),
  durationMs: z.number().int().min(0).max(VOICE_NOTE_MAX_MS),
  /** Loudness bars for the player (0–31), at most 64. */
  waveform: z.array(z.number().int().min(0).max(31)).max(64).optional(),
});
export type AudioDetails = z.infer<typeof audioDetailsSchema>;

export const pollVoteRequestSchema = z.object({
  /** Chosen option indexes; empty removes the vote. */
  options: z.array(z.number().int().min(0).max(POLL_OPTIONS_MAX - 1)).max(POLL_OPTIONS_MAX),
});
export type PollVoteRequest = z.infer<typeof pollVoteRequestSchema>;

export const eventResponseRequestSchema = z.object({
  response: z.enum(['GOING', 'MAYBE', 'NOT_GOING']).nullable(),
});
export type EventResponseRequest = z.infer<typeof eventResponseRequestSchema>;

export const liveLocationUpdateSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100_000).optional(),
});
export type LiveLocationUpdate = z.infer<typeof liveLocationUpdateSchema>;

// ── Broadcast lists ──

export const BROADCAST_LIST_MAX_RECIPIENTS = 256;

export const createBroadcastListRequestSchema = z.object({
  businessId: idSchema,
  name: text(100).min(1, 'Name the list'),
  userIds: z
    .array(idSchema)
    .min(1, 'Choose at least one person')
    .max(BROADCAST_LIST_MAX_RECIPIENTS),
});
export type CreateBroadcastListRequest = z.infer<typeof createBroadcastListRequestSchema>;

export const updateBroadcastListRequestSchema = z.object({
  name: text(100).min(1).optional(),
  addUserIds: z.array(idSchema).max(BROADCAST_LIST_MAX_RECIPIENTS).optional(),
  removeUserIds: z.array(idSchema).max(BROADCAST_LIST_MAX_RECIPIENTS).optional(),
});
export type UpdateBroadcastListRequest = z.infer<typeof updateBroadcastListRequestSchema>;

// ── Calls ──

export const startCallRequestSchema = z.object({
  conversationId: idSchema,
  media: z.enum(['audio', 'video']),
});
export type StartCallRequest = z.infer<typeof startCallRequestSchema>;

/** WebRTC signalling relayed between the two people in a call. */
export const callSignalSchema = z.object({
  callId: idSchema,
  data: z.union([
    z.object({ type: z.enum(['offer', 'answer']), sdp: z.string().min(1).max(20_000) }),
    z.object({
      type: z.literal('ice'),
      candidate: z.object({
        candidate: z.string().max(1000),
        sdpMid: z.string().max(64).nullable().optional(),
        sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
      }),
    }),
    /** Camera or microphone turned on/off on the other side. */
    z.object({ type: z.literal('media'), audio: z.boolean(), video: z.boolean() }),
  ]),
});
export type CallSignal = z.infer<typeof callSignalSchema>;

// ── Status ──

export const STATUS_TTL_HOURS = 24;
export const STATUS_BACKGROUNDS = [
  '#ea580c',
  '#7c3aed',
  '#0f766e',
  '#be123c',
  '#1d4ed8',
  '#4d7c0f',
  '#334155',
  '#a16207',
] as const;

export const createStatusRequestSchema = z
  .object({
    businessId: idSchema,
    /** Only this store's people see it. */
    storeId: idSchema.nullable().optional(),
    text: text(700).optional(),
    background: z.enum(STATUS_BACKGROUNDS).optional(),
    /** A READY photo or video uploaded with statusBusinessId. */
    mediaId: idSchema.optional(),
  })
  .refine((s) => (s.text && s.text.length > 0) || s.mediaId, {
    message: 'Write something or add a photo or video',
    path: ['text'],
  });
export type CreateStatusRequest = z.infer<typeof createStatusRequestSchema>;

// ── Store tasks and shifts ──

export const taskPrioritySchema = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);

export const createTaskRequestSchema = z.object({
  storeId: idSchema,
  title: text(160).min(1, 'What needs doing?'),
  notes: text(2000).optional(),
  priority: taskPrioritySchema.default('NORMAL'),
  dueAt: z.coerce.date().nullable().optional(),
  assigneeId: idSchema.nullable().optional(),
});
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;

export const updateTaskRequestSchema = z.object({
  title: text(160).min(1).optional(),
  notes: text(2000).nullable().optional(),
  priority: taskPrioritySchema.optional(),
  dueAt: z.coerce.date().nullable().optional(),
  assigneeId: idSchema.nullable().optional(),
  status: z.enum(['OPEN', 'DONE']).optional(),
});
export type UpdateTaskRequest = z.infer<typeof updateTaskRequestSchema>;

export const listTasksQuerySchema = z.object({
  businessId: idSchema,
  storeId: idSchema.optional(),
  status: z.enum(['OPEN', 'DONE', 'ALL']).default('OPEN'),
  mine: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

export const createShiftRequestSchema = z
  .object({
    storeId: idSchema,
    userId: idSchema,
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    title: text(60).optional(),
    notes: text(300).optional(),
  })
  .refine((s) => s.endsAt > s.startsAt, {
    message: 'The shift must end after it starts',
    path: ['endsAt'],
  })
  .refine((s) => s.endsAt.getTime() - s.startsAt.getTime() <= 24 * 3600_000, {
    message: 'A shift can be at most 24 hours',
    path: ['endsAt'],
  });
export type CreateShiftRequest = z.infer<typeof createShiftRequestSchema>;

export const listShiftsQuerySchema = z.object({
  businessId: idSchema,
  storeId: idSchema.optional(),
  from: z.coerce.date(),
  to: z.coerce.date(),
  mine: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type ListShiftsQuery = z.infer<typeof listShiftsQuerySchema>;

// ── Reports ──

export const reportQuerySchema = z.object({
  /** Omit for the whole platform (Super Admin only). */
  businessId: idSchema.optional(),
  from: z.coerce.date(),
  to: z.coerce.date(),
});
export type ReportQuery = z.infer<typeof reportQuerySchema>;

// ── Platform integrations (email / SMS / WhatsApp keys) ──

export const INTEGRATION_KEYS = [
  'SMTP_URL',
  'MAIL_FROM',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_TEMPLATE_NAME',
  'WHATSAPP_TEMPLATE_LANGUAGE',
] as const;
export type IntegrationKey = (typeof INTEGRATION_KEYS)[number];

export const updateIntegrationsRequestSchema = z.object({
  /** A value sets the key; null removes it (back to the server's environment setting). */
  values: z.partialRecord(z.enum(INTEGRATION_KEYS), z.string().trim().max(1000).nullable()),
});
export type UpdateIntegrationsRequest = z.infer<typeof updateIntegrationsRequestSchema>;

export const testIntegrationRequestSchema = z.object({
  channel: z.enum(['EMAIL', 'SMS', 'WHATSAPP']),
  /** Email address or phone number in international format (+923001234567). */
  to: z.string().trim().min(3).max(254),
});
export type TestIntegrationRequest = z.infer<typeof testIntegrationRequestSchema>;
