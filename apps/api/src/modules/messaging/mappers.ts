import type { Prisma } from '@prisma/client';
import {
  resolveBusinessPolicy,
  type ConversationSummaryDto,
  type MessageDto,
  type PublicUserDto,
  type SystemEventDto,
} from '@storeline/shared';
import { attachmentMediaSelect, toAttachmentDto } from '../media/media.mapper';
import { publicUserSelect, toPublicUser } from '../users/user.mapper';

const PREVIEW_LENGTH = 120;

export const messageInclude = {
  sender: { select: publicUserSelect },
  replyTo: {
    select: {
      id: true,
      seq: true,
      body: true,
      deletedAt: true,
      sender: { select: { displayName: true } },
    },
  },
  reactions: { select: { emoji: true, userId: true }, orderBy: { createdAt: 'asc' } },
  pins: { select: { conversationId: true } },
  attachments: {
    orderBy: { position: 'asc' },
    take: 1,
    select: { media: { select: attachmentMediaSelect } },
  },
} as const satisfies Prisma.MessageInclude;

export type MessageRow = Prisma.MessageGetPayload<{ include: typeof messageInclude }>;

/** Viewer-independent message representation (safe to fan out to every member). */
export function toMessageDto(row: MessageRow): MessageDto {
  const deleted = row.deletedAt !== null;
  return {
    id: row.id,
    conversationId: row.conversationId,
    seq: row.seq,
    sender: toPublicUser(row.sender),
    kind: row.kind,
    body: deleted ? null : row.body,
    systemEvent: (row.systemEvent as SystemEventDto | null) ?? null,
    deleted,
    editedAt: row.editedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    state: row.state,
    clientMessageId: row.clientMessageId,
    forwarded: row.forwardedFromId !== null,
    replyTo: row.replyTo
      ? {
          id: row.replyTo.id,
          seq: row.replyTo.seq,
          senderDisplayName: row.replyTo.sender.displayName,
          bodyPreview: row.replyTo.deletedAt
            ? null
            : (row.replyTo.body?.slice(0, PREVIEW_LENGTH) ?? null),
          deleted: row.replyTo.deletedAt !== null,
        }
      : null,
    reactions: deleted ? [] : row.reactions,
    pinned: !deleted && row.pins.length > 0,
    attachment: !deleted && row.attachments[0] ? toAttachmentDto(row.attachments[0].media) : null,
  };
}

/** Conversation fields needed to build any member's summary. */
export const conversationSummaryInclude = {
  lastMessage: { include: messageInclude },
  business: { select: { policy: true, status: true } },
} as const satisfies Prisma.ConversationInclude;

export type ConversationSummaryRow = Prisma.ConversationGetPayload<{
  include: typeof conversationSummaryInclude;
}>;

export type MemberStateRow = Pick<
  Prisma.ConversationMemberGetPayload<object>,
  | 'userId'
  | 'role'
  | 'historyFromSeq'
  | 'lastReadSeq'
  | 'lastDeliveredSeq'
  | 'mutedUntil'
  | 'pinnedAt'
  | 'archivedAt'
  | 'markedUnread'
>;

export function canPost(
  conversation: Pick<ConversationSummaryRow, 'postingPolicy' | 'archivedAt' | 'type'> & {
    business: { status: string };
  },
  member: Pick<MemberStateRow, 'role'>,
): boolean {
  if (conversation.archivedAt || conversation.business.status !== 'ACTIVE') return false;
  return conversation.postingPolicy === 'ALL_MEMBERS' || member.role === 'ADMIN';
}

/** File sharing needs posting rights plus the conversation's file-sharing policy. */
export function canShareFiles(
  conversation: Parameters<typeof canPost>[0] & {
    fileSharingPolicy: 'ALL_MEMBERS' | 'ADMINS_ONLY' | 'DISABLED';
  },
  member: Pick<MemberStateRow, 'role'>,
): boolean {
  if (!canPost(conversation, member)) return false;
  if (conversation.fileSharingPolicy === 'DISABLED') return false;
  return conversation.fileSharingPolicy === 'ALL_MEMBERS' || member.role === 'ADMIN';
}

export function unreadCount(
  lastSeq: number,
  member: Pick<MemberStateRow, 'historyFromSeq' | 'lastReadSeq' | 'markedUnread'>,
): number {
  const count = Math.max(0, lastSeq - Math.max(member.lastReadSeq, member.historyFromSeq));
  return member.markedUnread ? Math.max(1, count) : count;
}

/** Builds one member's view of a conversation (unread count, mute/pin state, visibility of the last message). */
/** Lowest delivered/read watermark among the other active members (null when alone). */
export interface OtherMembersWatermarks {
  minDeliveredSeq: number;
  minReadSeq: number;
}

function lastMessageStatus(
  conversation: ConversationSummaryRow,
  member: MemberStateRow,
  others: OtherMembersWatermarks | null,
): ConversationSummaryDto['lastMessageStatus'] {
  const last = conversation.lastMessage;
  if (!last || last.senderId !== member.userId || last.kind === 'SYSTEM' || last.deletedAt)
    return null;
  if (others) {
    const readReceipts = resolveBusinessPolicy(conversation.business.policy).readReceiptsEnabled;
    if (readReceipts && others.minReadSeq >= last.seq) return 'READ';
    if (others.minDeliveredSeq >= last.seq) return 'DELIVERED';
  }
  return last.state === 'DISPATCHED' ? 'SENT' : null;
}

export function toConversationSummary(
  conversation: ConversationSummaryRow,
  member: MemberStateRow,
  counterpart: PublicUserDto | null,
  others: OtherMembersWatermarks | null = null,
): ConversationSummaryDto {
  const lastMessage =
    conversation.lastMessage && conversation.lastMessage.seq > member.historyFromSeq
      ? toMessageDto(conversation.lastMessage)
      : null;
  const title =
    conversation.type === 'DIRECT'
      ? (counterpart?.displayName ?? 'Former member')
      : (conversation.title ?? 'Untitled group');
  return {
    id: conversation.id,
    type: conversation.type,
    businessId: conversation.businessId,
    storeId: conversation.storeId,
    title,
    description: conversation.description,
    category: conversation.category,
    postingPolicy: conversation.postingPolicy,
    fileSharingPolicy: conversation.fileSharingPolicy,
    counterpart: conversation.type === 'DIRECT' ? counterpart : null,
    lastSeq: conversation.lastSeq,
    lastMessage,
    lastMessageStatus: lastMessageStatus(conversation, member, others),
    lastActivityAt: conversation.lastActivityAt.toISOString(),
    unreadCount: unreadCount(conversation.lastSeq, member),
    memberCount: conversation.memberCount,
    me: {
      role: member.role,
      historyFromSeq: member.historyFromSeq,
      lastReadSeq: member.lastReadSeq,
      lastDeliveredSeq: member.lastDeliveredSeq,
      mutedUntil: member.mutedUntil?.toISOString() ?? null,
      pinnedAt: member.pinnedAt?.toISOString() ?? null,
      archivedAt: member.archivedAt?.toISOString() ?? null,
      markedUnread: member.markedUnread,
      canPost: canPost(conversation, member),
      canShareFiles: canShareFiles(conversation, member),
    },
  };
}
