import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ApiError } from '../../infra/http/api-error';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service';
import type { Actor } from '../auth/actor';
import { AuthorizationService } from '../authorization/authorization.service';
import { OutboxService, type PendingOutboxEvent } from '../outbox/outbox.service';
import { MessageWriter } from './message-writer.service';

const conversationAccessSelect = {
  id: true,
  businessId: true,
  storeId: true,
  type: true,
  title: true,
  postingPolicy: true,
  fileSharingPolicy: true,
  archivedAt: true,
  lastSeq: true,
  memberCount: true,
  business: { select: { status: true, policy: true } },
} as const satisfies Prisma.ConversationSelect;

export type AccessibleConversation = Prisma.ConversationGetPayload<{
  select: typeof conversationAccessSelect;
}>;

const memberSelect = {
  id: true,
  userId: true,
  role: true,
  historyFromSeq: true,
  lastReadSeq: true,
  lastDeliveredSeq: true,
} as const satisfies Prisma.ConversationMemberSelect;

export type ActiveMember = Prisma.ConversationMemberGetPayload<{ select: typeof memberSelect }>;

/**
 * Membership is the resource rule for conversation content: only ACTIVE members of a
 * conversation in an ACTIVE business can read or write it. Non-members always get 404 so
 * that conversation existence is not disclosed (threat T8).
 */
@Injectable()
export class ConversationAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly writer: MessageWriter,
    private readonly outbox: OutboxService,
  ) {}

  async requireMember(
    conversationId: string,
    userId: string,
    tx?: Tx,
  ): Promise<{ conversation: AccessibleConversation; member: ActiveMember }> {
    const member = await (tx ?? this.prisma).conversationMember.findFirst({
      where: { conversationId, userId, leftAt: null },
      select: { ...memberSelect, conversation: { select: conversationAccessSelect } },
    });
    if (!member || member.conversation.business.status !== 'ACTIVE')
      throw ApiError.notFound('Conversation');
    const { conversation, ...rest } = member;
    return { conversation, member: rest };
  }

  /**
   * Group management: allowed for group admins, or holders of group.manage covering the
   * group's store/business (who need not be members). Others get 404.
   */
  async requireGroupManager(
    actor: Actor,
    conversationId: string,
  ): Promise<{ conversation: AccessibleConversation; member: ActiveMember | null }> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: conversationAccessSelect,
    });
    if (!conversation || conversation.business.status !== 'ACTIVE')
      throw ApiError.notFound('Conversation');
    const member = await this.prisma.conversationMember.findFirst({
      where: { conversationId, userId: actor.userId, leftAt: null },
      select: memberSelect,
    });
    const manager = await this.authz.can(actor, 'group.manage', {
      businessId: conversation.businessId,
      storeId: conversation.storeId,
    });
    if (!member && !manager) throw ApiError.notFound('Conversation');
    if (conversation.type !== 'GROUP') throw ApiError.validation('Only groups can be managed.');
    if (!manager && member?.role !== 'ADMIN')
      throw ApiError.forbidden('Only group admins can do this.');
    if (conversation.archivedAt) throw ApiError.conflict('This group is archived.');
    return { conversation, member };
  }

  /** message.send must be held somewhere in the conversation's business (membership is the resource rule). */
  async requireSendPermission(actor: Actor, businessId: string): Promise<void> {
    const coverage = await this.authz.coverage(actor, 'message.send');
    const allowed =
      coverage.all ||
      coverage.businessIds.has(businessId) ||
      [...coverage.stores.values()].includes(businessId);
    if (!allowed) throw ApiError.forbidden('You cannot send messages here.');
  }

  /**
   * Ends a user's membership in every conversation matching `where` (store or business
   * removal). Writes a system message in groups and notifies the removed user.
   */
  async removeUserFromConversationsTx(
    tx: Tx,
    userId: string,
    where: Prisma.ConversationWhereInput,
    actorId: string,
  ): Promise<PendingOutboxEvent[]> {
    const memberships = await tx.conversationMember.findMany({
      where: { userId, leftAt: null, conversation: where },
      select: { conversation: { select: { id: true, businessId: true, type: true } } },
      take: 10_000,
    });
    const events: PendingOutboxEvent[] = [];
    for (const { conversation } of memberships) {
      events.push(...(await this.endMembershipTx(tx, conversation, userId, actorId, 'removed')));
    }
    return events;
  }

  /** Marks the membership as left, keeps at least one admin in groups, and records events. */
  async endMembershipTx(
    tx: Tx,
    conversation: { id: string; businessId: string; type: string },
    userId: string,
    actorId: string,
    mode: 'removed' | 'left',
  ): Promise<PendingOutboxEvent[]> {
    const ended = await tx.conversationMember.updateMany({
      where: { conversationId: conversation.id, userId, leftAt: null },
      data: { leftAt: new Date(), pinnedAt: null },
    });
    if (ended.count === 0) return [];
    await tx.conversation.update({
      where: { id: conversation.id },
      data: { memberCount: { decrement: 1 } },
    });

    const events: PendingOutboxEvent[] = [];
    if (conversation.type === 'GROUP') {
      const admins = await tx.conversationMember.count({
        where: { conversationId: conversation.id, leftAt: null, role: 'ADMIN' },
      });
      if (admins === 0) {
        const oldest = await tx.conversationMember.findFirst({
          where: { conversationId: conversation.id, leftAt: null },
          orderBy: { joinedAt: 'asc' },
          select: { id: true },
        });
        if (oldest)
          await tx.conversationMember.update({ where: { id: oldest.id }, data: { role: 'ADMIN' } });
      }
      const system = await this.writer.createSystem(
        tx,
        conversation,
        actorId,
        mode === 'left'
          ? { type: 'member_left', actorId }
          : { type: 'member_removed', actorId, userId },
      );
      events.push(system.event);
    }
    events.push(
      await this.outbox.add(
        tx,
        'conversation.removed',
        { conversationId: conversation.id, userIds: [userId] },
        conversation.businessId,
      ),
      await this.outbox.add(
        tx,
        'conversation.updated',
        { conversationId: conversation.id },
        conversation.businessId,
      ),
    );
    return events;
  }
}
