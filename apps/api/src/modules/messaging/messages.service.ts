import { Injectable } from '@nestjs/common';
import {
  PINNED_MESSAGES_MAX,
  resolveBusinessPolicy,
  type ForwardMessageRequest,
  type ListMessagesQuery,
  type MessageDto,
  type MessageInfoDto,
  type MessagePageDto,
  type Page,
  type SendMessageRequest,
  type SharedItemsQuery,
} from '@storeline/shared';
import { ApiError } from '../../infra/http/api-error';
import { decodeCursor, encodeCursor } from '../../infra/http/cursor';
import { isUniqueViolation, PrismaService, type Tx } from '../../infra/prisma/prisma.service';
import { RATE_LIMITS, RateLimiterService } from '../../infra/redis/rate-limiter.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { AuthorizationService } from '../authorization/authorization.service';
import { OutboxService } from '../outbox/outbox.service';
import { publicUserSelect, toPublicUser } from '../users/user.mapper';
import {
  ConversationAccessService,
  type AccessibleConversation,
  type ActiveMember,
} from './conversation-access.service';
import { canPost, canShareFiles, messageInclude, toMessageDto } from './mappers';
import { MessageWriter } from './message-writer.service';
import { metrics } from '../../infra/metrics/metrics';

export interface SendResult {
  message: MessageDto;
  /** True when this clientMessageId was already accepted (idempotent retry). */
  duplicate: boolean;
}

const isStarCursor = (v: Record<string, unknown>): v is { t: string; id: string } =>
  typeof v.t === 'string' && typeof v.id === 'string';

@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ConversationAccessService,
    private readonly authz: AuthorizationService,
    private readonly writer: MessageWriter,
    private readonly outbox: OutboxService,
    private readonly rateLimiter: RateLimiterService,
    private readonly audit: AuditService,
  ) {}

  async list(
    actor: Actor,
    conversationId: string,
    query: ListMessagesQuery,
  ): Promise<MessagePageDto> {
    const { member } = await this.access.requireMember(conversationId, actor.userId);
    const floor = member.historyFromSeq;
    const ascending = query.afterSeq !== undefined;
    const rows = await this.prisma.message.findMany({
      where: {
        conversationId,
        seq: {
          gt: Math.max(floor, query.afterSeq ?? 0),
          ...(query.beforeSeq !== undefined ? { lt: query.beforeSeq } : {}),
        },
      },
      orderBy: { seq: ascending ? 'asc' : 'desc' },
      take: query.limit + 1,
      include: {
        ...messageInclude,
        stars: { where: { userId: actor.userId }, select: { userId: true } },
      },
    });
    const more = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    if (!ascending) page.reverse();
    return {
      items: page.map((row) => ({ ...toMessageDto(row), starred: row.stars.length > 0 })),
      hasMoreBefore: ascending ? (page[0]?.seq ?? floor + 1) > floor + 1 : more,
      hasMoreAfter: ascending ? more : query.beforeSeq !== undefined,
    };
  }

  /**
   * "Media, links and docs": shared items the member can see (never messages from before
   * they joined or cleared the chat, never deleted ones), newest first.
   */
  async shared(
    actor: Actor,
    conversationId: string,
    query: SharedItemsQuery,
  ): Promise<MessageDto[]> {
    const { member } = await this.access.requireMember(conversationId, actor.userId);
    const rows = await this.prisma.message.findMany({
      where: {
        conversationId,
        seq: { gt: member.historyFromSeq },
        deletedAt: null,
        ...(query.kind === 'media'
          ? { kind: { in: ['IMAGE', 'VIDEO'] } }
          : query.kind === 'docs'
            ? { kind: 'DOCUMENT' }
            : { body: { contains: 'http', mode: 'insensitive' } }),
      },
      orderBy: { seq: 'desc' },
      take: query.limit,
      include: {
        ...messageInclude,
        stars: { where: { userId: actor.userId }, select: { userId: true } },
      },
    });
    return rows.map((row) => ({ ...toMessageDto(row), starred: row.stars.length > 0 }));
  }

  /** Idempotent send: the same (sender, clientMessageId) always yields the same message. */
  async send(
    actor: Actor,
    conversationId: string,
    request: SendMessageRequest,
  ): Promise<SendResult> {
    const existing = await this.findByClientId(actor.userId, request.clientMessageId);
    if (existing) return this.duplicateResult(existing, conversationId);

    const { conversation } = await this.access.requireMember(conversationId, actor.userId);
    await this.access.requireSendPermission(actor, conversation.businessId);
    await this.rateLimiter.consume(RATE_LIMITS.messageSendPerUser, actor.userId);
    await this.rateLimiter.consume(RATE_LIMITS.messageSendPerBusiness, conversation.businessId);

    try {
      const { id, event } = await this.prisma.$transaction(async (tx) => {
        // Re-check inside the transaction: membership may have ended since the first check.
        const { conversation: current, member } = await this.access.requireMember(
          conversationId,
          actor.userId,
          tx,
        );
        this.assertCanPost(current, member);
        if (request.replyToId)
          await this.requireVisibleMessage(tx, conversationId, request.replyToId, member);
        const media = request.mediaId
          ? await this.requireAttachableMedia(tx, actor, current, member, request.mediaId)
          : null;
        return this.writer.create(tx, {
          conversationId,
          businessId: current.businessId,
          senderId: actor.userId,
          clientMessageId: request.clientMessageId,
          kind: media?.kind ?? 'TEXT',
          body: request.body ?? null,
          mediaId: media?.id ?? null,
          replyToId: request.replyToId ?? null,
        });
      });
      await this.outbox.dispatch([event]);
      metrics.messagesAccepted.inc({ kind: request.mediaId ? 'MEDIA' : 'TEXT' });
      return { message: await this.loadDto(id), duplicate: false };
    } catch (error) {
      if (isUniqueViolation(error)) {
        const winner = await this.findByClientId(actor.userId, request.clientMessageId);
        if (winner) return this.duplicateResult(winner, conversationId);
      }
      throw error;
    }
  }

  async edit(actor: Actor, messageId: string, body: string): Promise<MessageDto> {
    const { message, conversation } = await this.loadForMember(actor, messageId);
    if (message.senderId !== actor.userId)
      throw ApiError.forbidden('You can only edit your own messages.');
    // Text and attachment captions can be edited; system messages cannot.
    if (message.kind === 'SYSTEM' || message.deletedAt)
      throw ApiError.conflict('This message cannot be edited.');
    const policy = resolveBusinessPolicy(conversation.business.policy);
    if (Date.now() - message.createdAt.getTime() > policy.messageEditWindowMinutes * 60_000) {
      throw ApiError.conflict(
        `Messages can only be edited within ${policy.messageEditWindowMinutes} minutes.`,
      );
    }
    if (message.body === body) return this.loadDto(messageId);
    const event = await this.prisma.$transaction(async (tx) => {
      await tx.messageRevision.create({
        data: { messageId, body: message.body, reason: 'EDIT', editorId: actor.userId },
      });
      await tx.message.update({ where: { id: messageId }, data: { body, editedAt: new Date() } });
      return this.outbox.add(tx, 'message.updated', { messageId }, conversation.businessId);
    });
    await this.outbox.dispatch([event]);
    return this.loadDto(messageId);
  }

  /**
   * Delete for everyone. Allowed for the sender within the policy window, group admins,
   * and moderators holding message.delete for the conversation's scope. The previous body
   * is retained in MessageRevision for the compliance retention period (docs D5).
   */
  async delete(actor: Actor, messageId: string): Promise<MessageDto> {
    const { message, conversation, member } = await this.loadForMember(actor, messageId);
    if (message.deletedAt) return this.loadDto(messageId);
    if (message.kind === 'SYSTEM') throw ApiError.conflict('This message cannot be deleted.');
    const policy = resolveBusinessPolicy(conversation.business.policy);
    const ownWithinWindow =
      message.senderId === actor.userId &&
      Date.now() - message.createdAt.getTime() <= policy.messageDeleteWindowMinutes * 60_000;
    const groupAdmin = conversation.type === 'GROUP' && member.role === 'ADMIN';
    const moderator = await this.authz.can(actor, 'message.delete', {
      businessId: conversation.businessId,
      storeId: conversation.storeId,
    });
    if (!ownWithinWindow && !groupAdmin && !moderator) {
      throw ApiError.forbidden(
        message.senderId === actor.userId
          ? `Messages can only be deleted within ${policy.messageDeleteWindowMinutes} minutes.`
          : 'You can only delete your own messages.',
      );
    }
    const event = await this.prisma.$transaction(async (tx) => {
      await tx.messageRevision.create({
        data: { messageId, body: message.body, reason: 'DELETE', editorId: actor.userId },
      });
      await tx.message.update({
        where: { id: messageId },
        data: { body: null, deletedAt: new Date(), deletedById: actor.userId },
      });
      await tx.pinnedMessage.deleteMany({ where: { messageId } });
      if (message.senderId !== actor.userId) {
        await this.audit.record(
          actor,
          {
            action: 'message.moderated_delete',
            businessId: conversation.businessId,
            storeId: conversation.storeId,
            targetType: 'Message',
            targetId: messageId,
            metadata: { conversationId: conversation.id, senderId: message.senderId },
          },
          tx,
        );
      }
      return this.outbox.add(tx, 'message.updated', { messageId }, conversation.businessId);
    });
    await this.outbox.dispatch([event]);
    return this.loadDto(messageId);
  }

  async react(actor: Actor, messageId: string, emoji: string | null): Promise<MessageDto> {
    const { message, conversation } = await this.loadForMember(actor, messageId);
    if (message.deletedAt || message.kind === 'SYSTEM')
      throw ApiError.conflict('You cannot react to this message.');
    const event = await this.prisma.$transaction(async (tx) => {
      if (emoji === null) {
        await tx.messageReaction.deleteMany({ where: { messageId, userId: actor.userId } });
      } else {
        await tx.messageReaction.upsert({
          where: { messageId_userId: { messageId, userId: actor.userId } },
          create: { messageId, userId: actor.userId, emoji },
          update: { emoji, createdAt: new Date() },
        });
      }
      return this.outbox.add(tx, 'message.updated', { messageId }, conversation.businessId);
    });
    await this.outbox.dispatch([event]);
    return this.loadDto(messageId);
  }

  async forward(
    actor: Actor,
    messageId: string,
    request: ForwardMessageRequest,
  ): Promise<SendResult[]> {
    const { message } = await this.loadForMember(actor, messageId);
    const attachment = await this.prisma.messageAttachment.findFirst({
      where: { messageId, media: { status: 'READY' } },
      select: { mediaId: true },
    });
    if (message.deletedAt || message.kind === 'SYSTEM' || (message.body === null && !attachment)) {
      throw ApiError.conflict('This message cannot be forwarded.');
    }
    const results: SendResult[] = [];
    for (const target of request.targets) {
      const existing = await this.findByClientId(actor.userId, target.clientMessageId);
      if (existing) {
        results.push(this.duplicateResult(existing, target.conversationId));
        continue;
      }
      const { conversation } = await this.access.requireMember(target.conversationId, actor.userId);
      await this.access.requireSendPermission(actor, conversation.businessId);
      await this.rateLimiter.consume(RATE_LIMITS.messageSendPerUser, actor.userId);
      const { id, event } = await this.prisma.$transaction(async (tx) => {
        const { conversation: current, member } = await this.access.requireMember(
          target.conversationId,
          actor.userId,
          tx,
        );
        this.assertCanPost(current, member);
        if (attachment && !canShareFiles(current, member)) {
          throw ApiError.forbidden('Files cannot be shared in one of the chosen chats.');
        }
        return this.writer.create(tx, {
          conversationId: target.conversationId,
          businessId: current.businessId,
          senderId: actor.userId,
          clientMessageId: target.clientMessageId,
          kind: message.kind,
          body: message.body,
          // Forwarding shares the same verified file; access follows the new message.
          mediaId: attachment?.mediaId ?? null,
          forwardedFromId: message.id,
        });
      });
      await this.outbox.dispatch([event]);
      results.push({ message: await this.loadDto(id), duplicate: false });
    }
    return results;
  }

  async setStar(actor: Actor, messageId: string, starred: boolean): Promise<void> {
    await this.loadForMember(actor, messageId);
    if (starred) {
      await this.prisma.starredMessage.upsert({
        where: { userId_messageId: { userId: actor.userId, messageId } },
        create: { userId: actor.userId, messageId },
        update: {},
      });
    } else {
      await this.prisma.starredMessage.deleteMany({ where: { userId: actor.userId, messageId } });
    }
  }

  /** Starred messages, restricted to conversations the user can still read. */
  async listStarred(
    actor: Actor,
    cursorValue: string | undefined,
    limit: number,
  ): Promise<Page<MessageDto>> {
    const cursor = decodeCursor(cursorValue, isStarCursor);
    const stars = await this.prisma.starredMessage.findMany({
      where: {
        userId: actor.userId,
        message: {
          deletedAt: null,
          conversation: {
            business: { status: 'ACTIVE' },
            members: { some: { userId: actor.userId, leftAt: null } },
          },
        },
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: new Date(cursor.t) } },
                { createdAt: new Date(cursor.t), messageId: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { messageId: 'desc' }],
      take: limit + 1,
      include: { message: { include: messageInclude } },
    });
    const page = stars.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((s) => ({ ...toMessageDto(s.message), starred: true })),
      nextCursor:
        stars.length > limit && last
          ? encodeCursor({ t: last.createdAt.toISOString(), id: last.messageId })
          : null,
    };
  }

  async setPinned(actor: Actor, messageId: string, pinned: boolean): Promise<MessageDto> {
    const { message, conversation, member } = await this.loadForMember(actor, messageId);
    if (message.deletedAt || message.kind === 'SYSTEM')
      throw ApiError.conflict('This message cannot be pinned.');
    this.assertCanPost(conversation, member);
    const event = await this.prisma.$transaction(async (tx) => {
      if (pinned) {
        const count = await tx.pinnedMessage.count({ where: { conversationId: conversation.id } });
        const already = await tx.pinnedMessage.findUnique({
          where: { conversationId_messageId: { conversationId: conversation.id, messageId } },
        });
        if (already) return null;
        if (count >= PINNED_MESSAGES_MAX)
          throw ApiError.conflict(`Up to ${PINNED_MESSAGES_MAX} messages can be pinned.`);
        await tx.pinnedMessage.create({
          data: { conversationId: conversation.id, messageId, pinnedById: actor.userId },
        });
      } else {
        const removed = await tx.pinnedMessage.deleteMany({
          where: { conversationId: conversation.id, messageId },
        });
        if (removed.count === 0) return null;
      }
      return this.outbox.add(tx, 'message.updated', { messageId }, conversation.businessId);
    });
    if (event) await this.outbox.dispatch([event]);
    return this.loadDto(messageId);
  }

  async listPinned(actor: Actor, conversationId: string): Promise<MessageDto[]> {
    const { member } = await this.access.requireMember(conversationId, actor.userId);
    const pins = await this.prisma.pinnedMessage.findMany({
      where: { conversationId, message: { seq: { gt: member.historyFromSeq }, deletedAt: null } },
      orderBy: { createdAt: 'desc' },
      include: { message: { include: messageInclude } },
    });
    return pins.map((p) => toMessageDto(p.message));
  }

  /** Per-recipient delivery state, derived from membership watermarks. Sender only. */
  async info(actor: Actor, messageId: string): Promise<MessageInfoDto> {
    const { message, conversation } = await this.loadForMember(actor, messageId);
    if (message.senderId !== actor.userId)
      throw ApiError.forbidden('Only the sender can see message info.');
    const readReceipts = resolveBusinessPolicy(conversation.business.policy).readReceiptsEnabled;
    const members = await this.prisma.conversationMember.findMany({
      where: {
        conversationId: conversation.id,
        leftAt: null,
        userId: { not: actor.userId },
        historyFromSeq: { lt: message.seq },
      },
      select: { lastDeliveredSeq: true, lastReadSeq: true, user: { select: publicUserSelect } },
      orderBy: { joinedAt: 'asc' },
      take: 500,
    });
    return {
      messageId,
      recipients: members.map((m) => ({
        user: toPublicUser(m.user),
        status:
          readReceipts && m.lastReadSeq >= message.seq
            ? 'READ'
            : m.lastDeliveredSeq >= message.seq
              ? 'DELIVERED'
              : message.state === 'DISPATCHED'
                ? 'SENT'
                : 'PENDING',
      })),
    };
  }

  async loadDto(messageId: string): Promise<MessageDto> {
    const row = await this.prisma.message.findUniqueOrThrow({
      where: { id: messageId },
      include: messageInclude,
    });
    return toMessageDto(row);
  }

  private assertCanPost(conversation: AccessibleConversation, member: ActiveMember): void {
    if (!canPost(conversation, member)) {
      throw ApiError.forbidden(
        conversation.archivedAt
          ? 'This conversation is archived.'
          : 'Only group admins can send messages here.',
      );
    }
  }

  private async loadForMember(actor: Actor, messageId: string) {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        conversationId: true,
        senderId: true,
        seq: true,
        kind: true,
        body: true,
        state: true,
        deletedAt: true,
        createdAt: true,
      },
    });
    if (!message) throw ApiError.notFound('Message');
    let access: Awaited<ReturnType<ConversationAccessService['requireMember']>>;
    try {
      access = await this.access.requireMember(message.conversationId, actor.userId);
    } catch {
      throw ApiError.notFound('Message');
    }
    if (message.seq <= access.member.historyFromSeq) throw ApiError.notFound('Message');
    return { message, conversation: access.conversation, member: access.member };
  }

  /**
   * Media can be attached only by its uploader, in the conversation it was uploaded for,
   * after verification (READY), and only where the sender may share files.
   */
  private async requireAttachableMedia(
    tx: Tx,
    actor: Actor,
    conversation: AccessibleConversation,
    member: ActiveMember,
    mediaId: string,
  ): Promise<{ id: string; kind: 'IMAGE' | 'VIDEO' | 'DOCUMENT' }> {
    if (!canShareFiles(conversation, member)) {
      throw ApiError.forbidden('You cannot share files in this chat.');
    }
    const media = await tx.mediaAsset.findFirst({
      where: { id: mediaId, uploaderId: actor.userId, conversationId: conversation.id },
      select: { id: true, kind: true, status: true },
    });
    if (!media) throw ApiError.validation('The file was not found.', 'mediaId');
    if (media.status !== 'READY') {
      throw ApiError.conflict(
        media.status === 'VERIFYING' || media.status === 'PENDING_UPLOAD'
          ? 'The file is still being checked. Please wait a moment.'
          : 'This file cannot be shared.',
      );
    }
    return { id: media.id, kind: media.kind };
  }

  private async requireVisibleMessage(
    tx: Tx,
    conversationId: string,
    messageId: string,
    member: ActiveMember,
  ): Promise<void> {
    const target = await tx.message.findFirst({
      where: { id: messageId, conversationId, seq: { gt: member.historyFromSeq } },
      select: { id: true },
    });
    if (!target)
      throw ApiError.validation('The message you replied to was not found.', 'replyToId');
  }

  private findByClientId(senderId: string, clientMessageId: string) {
    return this.prisma.message.findUnique({
      where: { senderId_clientMessageId: { senderId, clientMessageId } },
      include: messageInclude,
    });
  }

  private duplicateResult(
    existing: NonNullable<Awaited<ReturnType<MessagesService['findByClientId']>>>,
    conversationId: string,
  ): SendResult {
    if (existing.conversationId !== conversationId) {
      throw ApiError.conflict('This message id was already used in another conversation.');
    }
    return { message: toMessageDto(existing), duplicate: true };
  }
}
