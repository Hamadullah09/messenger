import { z } from 'zod';
import { idSchema } from './common';
import { audioDetailsSchema, richContentSchema } from './rich-messages';

export const MESSAGE_BODY_MAX_LENGTH = 4096;
export const GROUP_MAX_MEMBERS = 5000;
export const FORWARD_MAX_TARGETS = 5;
export const PINNED_MESSAGES_MAX = 10;

const messageBodySchema = z
  .string()
  .max(MESSAGE_BODY_MAX_LENGTH, `Messages can be at most ${MESSAGE_BODY_MAX_LENGTH} characters`)
  .refine((v) => v.trim().length > 0, 'Message cannot be empty');

export const createDirectConversationRequestSchema = z.object({
  businessId: idSchema,
  userId: idSchema,
});
export type CreateDirectConversationRequest = z.infer<typeof createDirectConversationRequestSchema>;

export const postingPolicySchema = z.enum(['ALL_MEMBERS', 'ADMINS_ONLY']);
export type PostingPolicy = z.infer<typeof postingPolicySchema>;

export const fileSharingPolicySchema = z.enum(['ALL_MEMBERS', 'ADMINS_ONLY', 'DISABLED']);
export type FileSharingPolicy = z.infer<typeof fileSharingPolicySchema>;

export const groupCategorySchema = z.enum([
  'OPERATIONS',
  'SECURITY',
  'EMERGENCY_RESPONSE',
  'MANAGEMENT',
  'ANNOUNCEMENTS',
  'GENERAL',
]);
export type GroupCategory = z.infer<typeof groupCategorySchema>;

export const createGroupRequestSchema = z.object({
  businessId: idSchema,
  storeId: idSchema.nullable().optional(),
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  category: groupCategorySchema.default('GENERAL'),
  postingPolicy: postingPolicySchema.default('ALL_MEMBERS'),
  fileSharingPolicy: fileSharingPolicySchema.default('ALL_MEMBERS'),
  memberIds: z.array(idSchema).max(GROUP_MAX_MEMBERS).default([]),
  adminIds: z.array(idSchema).max(50).default([]),
});
export type CreateGroupRequest = z.infer<typeof createGroupRequestSchema>;

export const updateGroupRequestSchema = z.object({
  title: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  category: groupCategorySchema.optional(),
  postingPolicy: postingPolicySchema.optional(),
  fileSharingPolicy: fileSharingPolicySchema.optional(),
  editInfoPolicy: postingPolicySchema.optional(),
  addMembersPolicy: postingPolicySchema.optional(),
});

/** Shared items of a chat, as in WhatsApp's "Media, links and docs". */
export const sharedItemsQuerySchema = z.object({
  kind: z.enum(['media', 'docs', 'links']),
  limit: z.coerce.number().int().min(1).max(100).default(60),
});
export type SharedItemsQuery = z.infer<typeof sharedItemsQuerySchema>;
export type UpdateGroupRequest = z.infer<typeof updateGroupRequestSchema>;

export const addMembersRequestSchema = z.object({
  userIds: z.array(idSchema).min(1).max(500),
});
export type AddMembersRequest = z.infer<typeof addMembersRequestSchema>;

export const updateMemberRequestSchema = z.object({
  role: z.enum(['MEMBER', 'ADMIN']),
});
export type UpdateMemberRequest = z.infer<typeof updateMemberRequestSchema>;

export const updateMyConversationStateRequestSchema = z.object({
  /** ISO timestamp until which notifications are muted; null unmutes. Far future = always. */
  mutedUntil: z.coerce.date().nullable().optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  markedUnread: z.boolean().optional(),
  /** "Clear chat": hide every message so far, for you only. */
  clearHistory: z.literal(true).optional(),
});
export type UpdateMyConversationStateRequest = z.infer<
  typeof updateMyConversationStateRequestSchema
>;

export const sendMessageRequestSchema = z
  .object({
    /** Client-generated UUID. Retrying with the same value returns the original message. */
    clientMessageId: idSchema,
    /** Text, or the caption of an attachment. */
    body: messageBodySchema.optional(),
    /** A READY media asset uploaded by the sender for this conversation. */
    mediaId: idSchema.optional(),
    /** Voice note / audio details, with an audio mediaId. */
    audio: audioDetailsSchema.optional(),
    /** Location, contact card, poll, event or sticker (instead of text). */
    content: richContentSchema.optional(),
    replyToId: idSchema.optional(),
  })
  .refine((v) => v.body !== undefined || v.mediaId !== undefined || v.content !== undefined, {
    message: 'Message cannot be empty',
    path: ['body'],
  })
  .refine((v) => !(v.content && v.mediaId), {
    message: 'Send a file or a structured message, not both',
    path: ['content'],
  })
  .refine((v) => !v.audio || v.mediaId, { message: 'Audio details need a file', path: ['audio'] });
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

export const editMessageRequestSchema = z.object({ body: messageBodySchema });
export type EditMessageRequest = z.infer<typeof editMessageRequestSchema>;

export const reactionRequestSchema = z.object({
  emoji: z
    .string()
    .min(1)
    .max(16)
    .refine(
      (v) => /\p{Extended_Pictographic}/u.test(v) && !/[\p{L}\p{N}]/u.test(v),
      'Use a single emoji',
    ),
});
export type ReactionRequest = z.infer<typeof reactionRequestSchema>;

export const forwardMessageRequestSchema = z.object({
  targets: z
    .array(z.object({ conversationId: idSchema, clientMessageId: idSchema }))
    .min(1)
    .max(FORWARD_MAX_TARGETS),
});
export type ForwardMessageRequest = z.infer<typeof forwardMessageRequestSchema>;

export const listMessagesQuerySchema = z
  .object({
    beforeSeq: z.coerce.number().int().min(1).optional(),
    afterSeq: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine((v) => v.beforeSeq === undefined || v.afterSeq === undefined, {
    message: 'Use either beforeSeq or afterSeq',
  });
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;

export const listConversationsQuerySchema = z.object({
  businessId: idSchema.optional(),
  archived: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;

export const searchMessagesQuerySchema = z.object({
  q: z.string().trim().min(2).max(100),
  conversationId: idSchema.optional(),
  businessId: idSchema.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchMessagesQuery = z.infer<typeof searchMessagesQuerySchema>;

export const directoryQuerySchema = z.object({
  businessId: idSchema,
  query: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type DirectoryQuery = z.infer<typeof directoryQuerySchema>;
