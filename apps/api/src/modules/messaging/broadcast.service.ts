import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  BROADCAST_LIST_MAX_RECIPIENTS,
  type BroadcastDeliveryDto,
  type BroadcastListDto,
  type CreateBroadcastListRequest,
  type UpdateBroadcastListRequest,
} from '@storeline/shared';
import { ApiError } from '../../infra/http/api-error';
import { isUniqueViolation, PrismaService } from '../../infra/prisma/prisma.service';
import type { Actor } from '../auth/actor';
import { AuthorizationService } from '../authorization/authorization.service';
import { OutboxService } from '../outbox/outbox.service';
import { RealtimeEmitter } from '../realtime/realtime-emitter.service';
import { publicUserSelect, toPublicUser } from '../users/user.mapper';
import { ConversationAccessService } from './conversation-access.service';
import { DirectoryService } from './directory.service';
import { MessageWriter } from './message-writer.service';

/** Stable per-recipient id so a retried broadcast never sends twice. */
function derivedClientId(messageId: string, userId: string): string {
  const h = createHash('sha256').update(`${messageId}:${userId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * WhatsApp broadcast lists: the owner writes in the list's own chat (only they are a member)
 * and every message is also delivered to each recipient as a direct message. Recipients must
 * be people the owner may message directly; nobody sees who else is on the list.
 */
@Injectable()
export class BroadcastService {
  private readonly logger = new Logger(BroadcastService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly access: ConversationAccessService,
    private readonly directory: DirectoryService,
    private readonly writer: MessageWriter,
    private readonly outbox: OutboxService,
    private readonly realtime: RealtimeEmitter,
  ) {}

  private async requireReachable(actor: Actor, businessId: string, userIds: string[]) {
    const unique = [...new Set(userIds.filter((id) => id !== actor.userId))];
    const reachable = await this.directory.reachableIds(actor, businessId, unique);
    if (reachable.size !== unique.length)
      throw ApiError.validation('Some people cannot be messaged by you.', 'userIds');
    return unique;
  }

  async create(actor: Actor, request: CreateBroadcastListRequest): Promise<BroadcastListDto> {
    await this.authz.require(actor, 'conversation.direct.create', {
      businessId: request.businessId,
    });
    const userIds = await this.requireReachable(actor, request.businessId, request.userIds);
    if (userIds.length === 0) throw ApiError.validation('Choose at least one person.', 'userIds');
    const { id, events } = await this.prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.create({
        data: {
          businessId: request.businessId,
          type: 'BROADCAST_LIST',
          title: request.name,
          createdById: actor.userId,
          memberCount: 1,
          members: { create: { userId: actor.userId, role: 'ADMIN', addedById: actor.userId } },
          broadcastRecipients: { create: userIds.map((userId) => ({ userId })) },
        },
        select: { id: true },
      });
      const event = await this.outbox.add(
        tx,
        'conversation.updated',
        { conversationId: conversation.id },
        request.businessId,
      );
      return { id: conversation.id, events: [event] };
    });
    await this.outbox.dispatch(events);
    return this.get(actor, id);
  }

  private async requireOwnList(actor: Actor, conversationId: string) {
    const { conversation } = await this.access.requireMember(conversationId, actor.userId);
    if (conversation.type !== 'BROADCAST_LIST') throw ApiError.notFound('Broadcast list');
    return conversation;
  }

  async get(actor: Actor, conversationId: string): Promise<BroadcastListDto> {
    const conversation = await this.requireOwnList(actor, conversationId);
    const recipients = await this.prisma.broadcastRecipient.findMany({
      where: { conversationId },
      include: { user: { select: publicUserSelect } },
      orderBy: { user: { displayName: 'asc' } },
    });
    const row = await this.prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { title: true, createdAt: true },
    });
    return {
      conversationId,
      businessId: conversation.businessId,
      name: row.title ?? 'Broadcast list',
      recipients: recipients.map((r) => toPublicUser(r.user)),
      createdAt: row.createdAt.toISOString(),
    };
  }

  async update(
    actor: Actor,
    conversationId: string,
    request: UpdateBroadcastListRequest,
  ): Promise<BroadcastListDto> {
    const conversation = await this.requireOwnList(actor, conversationId);
    const add = request.addUserIds?.length
      ? await this.requireReachable(actor, conversation.businessId, request.addUserIds)
      : [];
    const events = await this.prisma.$transaction(async (tx) => {
      if (request.removeUserIds?.length)
        await tx.broadcastRecipient.deleteMany({
          where: { conversationId, userId: { in: request.removeUserIds } },
        });
      if (add.length)
        await tx.broadcastRecipient.createMany({
          data: add.map((userId) => ({ conversationId, userId })),
          skipDuplicates: true,
        });
      const count = await tx.broadcastRecipient.count({ where: { conversationId } });
      if (count > BROADCAST_LIST_MAX_RECIPIENTS)
        throw ApiError.validation(
          `A broadcast list can have at most ${BROADCAST_LIST_MAX_RECIPIENTS} people.`,
          'addUserIds',
        );
      if (count === 0)
        throw ApiError.validation('Keep at least one person on the list.', 'removeUserIds');
      if (request.name) {
        await tx.conversation.update({
          where: { id: conversationId },
          data: { title: request.name },
        });
      }
      return [
        await this.outbox.add(
          tx,
          'conversation.updated',
          { conversationId },
          conversation.businessId,
        ),
      ];
    });
    await this.outbox.dispatch(events);
    return this.get(actor, conversationId);
  }

  async remove(actor: Actor, conversationId: string): Promise<void> {
    await this.requireOwnList(actor, conversationId);
    await this.prisma.$transaction([
      this.prisma.conversationMember.updateMany({
        where: { conversationId, userId: actor.userId },
        data: { leftAt: new Date() },
      }),
      this.prisma.conversation.update({
        where: { id: conversationId },
        data: { archivedAt: new Date(), memberCount: 0 },
      }),
    ]);
    this.realtime.toUsers([actor.userId], 'conversation.removed', { conversationId });
  }

  /**
   * After a message is written in a list: send a copy to each recipient's direct chat (created
   * when missing). People who can no longer be reached are skipped.
   */
  async fanOut(
    actor: Actor,
    listConversationId: string,
    messageId: string,
  ): Promise<BroadcastDeliveryDto> {
    const [list, message] = await Promise.all([
      this.prisma.conversation.findUniqueOrThrow({
        where: { id: listConversationId },
        select: { businessId: true, broadcastRecipients: { select: { userId: true } } },
      }),
      this.prisma.message.findUniqueOrThrow({
        where: { id: messageId },
        select: {
          kind: true,
          body: true,
          meta: true,
          attachments: { select: { mediaId: true }, take: 1 },
        },
      }),
    ]);
    const reachable = await this.directory.reachableIds(
      actor,
      list.businessId,
      list.broadcastRecipients.map((r) => r.userId),
    );
    let delivered = 0;
    const events = [];
    for (const userId of reachable) {
      try {
        const dmId = await this.directConversation(list.businessId, actor.userId, userId);
        const clientMessageId = derivedClientId(messageId, userId);
        const exists = await this.prisma.message.findUnique({
          where: { senderId_clientMessageId: { senderId: actor.userId, clientMessageId } },
          select: { id: true },
        });
        if (exists) {
          delivered += 1;
          continue;
        }
        const { event } = await this.prisma.$transaction((tx) =>
          this.writer.create(tx, {
            conversationId: dmId,
            businessId: list.businessId,
            senderId: actor.userId,
            clientMessageId,
            kind: message.kind,
            body: message.body,
            meta: (message.meta as never) ?? null,
            mediaId: message.attachments[0]?.mediaId ?? null,
          }),
        );
        events.push(event);
        delivered += 1;
      } catch (error) {
        if (!isUniqueViolation(error))
          this.logger.warn({ err: error }, 'Broadcast copy could not be delivered');
      }
    }
    await this.outbox.dispatch(events);
    return { delivered, skipped: list.broadcastRecipients.length - delivered };
  }

  /** Find-or-create the direct chat (rejoining people who left it). */
  private async directConversation(businessId: string, a: string, b: string): Promise<string> {
    const directKey = `${businessId}:${[a, b].sort().join(':')}`;
    const existing = await this.prisma.conversation.findUnique({
      where: { directKey },
      select: { id: true, members: { where: { leftAt: { not: null } }, select: { id: true } } },
    });
    if (existing) {
      if (existing.members.length > 0) {
        await this.prisma.$transaction(async (tx) => {
          const { lastSeq } = await tx.conversation.update({
            where: { id: existing.id },
            data: { memberCount: { increment: existing.members.length } },
            select: { lastSeq: true },
          });
          await tx.conversationMember.updateMany({
            where: { id: { in: existing.members.map((m) => m.id) } },
            data: {
              leftAt: null,
              historyFromSeq: lastSeq,
              lastReadSeq: lastSeq,
              lastDeliveredSeq: lastSeq,
              joinedAt: new Date(),
            },
          });
        });
      }
      return existing.id;
    }
    try {
      const created = await this.prisma.conversation.create({
        data: {
          businessId,
          type: 'DIRECT',
          directKey,
          createdById: a,
          memberCount: 2,
          members: {
            create: [
              { userId: a, addedById: a },
              { userId: b, addedById: a },
            ],
          },
        },
        select: { id: true },
      });
      return created.id;
    } catch (error) {
      if (isUniqueViolation(error)) {
        const winner = await this.prisma.conversation.findUniqueOrThrow({
          where: { directKey },
          select: { id: true },
        });
        return winner.id;
      }
      throw error;
    }
  }
}
