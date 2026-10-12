import { Injectable } from '@nestjs/common';
import {
  GROUP_MAX_MEMBERS,
  type AddMembersRequest,
  type ConversationDetailDto,
  type ConversationSummaryDto,
  type CreateDirectConversationRequest,
  type CommonGroupDto,
  type CreateGroupRequest,
  type UpdateGroupRequest,
  type UpdateMemberRequest,
  type UpdateMyConversationStateRequest,
} from '@storeline/shared';
import { ApiError } from '../../infra/http/api-error';
import { isUniqueViolation, PrismaService, type Tx } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { AuthorizationService } from '../authorization/authorization.service';
import { OutboxService, type PendingOutboxEvent } from '../outbox/outbox.service';
import { RealtimeEmitter } from '../realtime/realtime-emitter.service';
import { ConversationAccessService } from './conversation-access.service';
import { ConversationQueryService } from './conversation-query.service';
import { DirectoryService } from './directory.service';
import { MessageWriter } from './message-writer.service';

const MAX_PINNED_CONVERSATIONS = 5;

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly access: ConversationAccessService,
    private readonly queries: ConversationQueryService,
    private readonly directory: DirectoryService,
    private readonly writer: MessageWriter,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeEmitter,
  ) {}

  async get(actor: Actor, conversationId: string): Promise<ConversationDetailDto> {
    await this.access.requireMember(conversationId, actor.userId);
    const detail = await this.queries.detailForUser(conversationId, actor.userId);
    if (!detail) throw ApiError.notFound('Conversation');
    return detail;
  }

  /** Find-or-create the direct conversation between the actor and another user. */
  async createDirect(
    actor: Actor,
    request: CreateDirectConversationRequest,
  ): Promise<ConversationDetailDto> {
    if (request.userId === actor.userId)
      throw ApiError.validation('You cannot start a chat with yourself.', 'userId');
    const canDm = await this.directory.canStartDirect(actor, request.businessId, request.userId);
    if (!canDm) throw ApiError.notFound('User');

    const directKey = `${request.businessId}:${[actor.userId, request.userId].sort().join(':')}`;
    const existing = await this.prisma.conversation.findUnique({
      where: { directKey },
      select: { id: true },
    });
    if (existing) {
      await this.rejoinDirect(existing.id, [actor.userId, request.userId]);
      return this.get(actor, existing.id);
    }
    try {
      const { id, events } = await this.prisma.$transaction(async (tx) => {
        const conversation = await tx.conversation.create({
          data: {
            businessId: request.businessId,
            type: 'DIRECT',
            directKey,
            createdById: actor.userId,
            memberCount: 2,
            members: {
              create: [
                { userId: actor.userId, addedById: actor.userId },
                { userId: request.userId, addedById: actor.userId },
              ],
            },
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
    } catch (error) {
      // Lost a race with a concurrent create: return the winner.
      if (isUniqueViolation(error)) {
        const winner = await this.prisma.conversation.findUniqueOrThrow({
          where: { directKey },
          select: { id: true },
        });
        return this.get(actor, winner.id);
      }
      throw error;
    }
  }

  async createGroup(actor: Actor, request: CreateGroupRequest): Promise<ConversationDetailDto> {
    const storeId = request.storeId ?? null;
    const business = await this.prisma.business.findUnique({
      where: { id: request.businessId },
      select: { status: true },
    });
    if (!business) throw ApiError.notFound('Business');
    if (storeId) {
      const store = await this.prisma.store.findFirst({
        where: { id: storeId, businessId: request.businessId, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!store) throw ApiError.validation('Store not found in this business.', 'storeId');
    }
    await this.authz.require(actor, 'group.create', { businessId: request.businessId, storeId });
    if (business.status !== 'ACTIVE') throw ApiError.conflict('This business is not active.');

    const memberIds = [
      ...new Set([...request.memberIds, ...request.adminIds].filter((id) => id !== actor.userId)),
    ];
    if (memberIds.length + 1 > GROUP_MAX_MEMBERS)
      throw ApiError.validation(`Groups can have at most ${GROUP_MAX_MEMBERS} members.`);
    await this.requireEligible(request.businessId, storeId, memberIds);
    const admins = new Set(request.adminIds);

    const { id, events } = await this.prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.create({
        data: {
          businessId: request.businessId,
          storeId,
          type: 'GROUP',
          title: request.title,
          description: request.description,
          category: request.category,
          postingPolicy: request.postingPolicy,
          fileSharingPolicy: request.fileSharingPolicy,
          createdById: actor.userId,
          memberCount: memberIds.length + 1,
          members: {
            create: [
              { userId: actor.userId, role: 'ADMIN', addedById: actor.userId },
              ...memberIds.map((userId) => ({
                userId,
                role: admins.has(userId) ? ('ADMIN' as const) : ('MEMBER' as const),
                addedById: actor.userId,
              })),
            ],
          },
        },
        select: { id: true, businessId: true },
      });
      const system = await this.writer.createSystem(tx, conversation, actor.userId, {
        type: 'group_created',
        actorId: actor.userId,
        title: request.title,
      });
      const updated = await this.outbox.add(
        tx,
        'conversation.updated',
        { conversationId: conversation.id },
        request.businessId,
      );
      await this.audit.record(
        actor,
        {
          action: 'group.created',
          businessId: request.businessId,
          storeId,
          targetType: 'Conversation',
          targetId: conversation.id,
          metadata: { memberCount: memberIds.length + 1, category: request.category },
        },
        tx,
      );
      return { id: conversation.id, events: [updated, system.event] };
    });
    await this.outbox.dispatch(events);
    return this.get(actor, id);
  }

  async updateGroup(
    actor: Actor,
    conversationId: string,
    request: UpdateGroupRequest,
  ): Promise<ConversationDetailDto> {
    // Name and description follow "Edit group info"; every other setting is for admins.
    const infoOnly = Object.keys(request).every((k) => k === 'title' || k === 'description');
    const { conversation } = infoOnly
      ? await this.access.requireGroupMemberAllowedBy(actor, conversationId, 'editInfoPolicy')
      : await this.access.requireGroupManager(actor, conversationId);
    const events = await this.prisma.$transaction(async (tx) => {
      await tx.conversation.update({
        where: { id: conversationId },
        data: {
          title: request.title,
          description: request.description,
          category: request.category,
          postingPolicy: request.postingPolicy,
          fileSharingPolicy: request.fileSharingPolicy,
          editInfoPolicy: request.editInfoPolicy,
          addMembersPolicy: request.addMembersPolicy,
        },
      });
      const pending: PendingOutboxEvent[] = [];
      if (request.title && request.title !== conversation.title) {
        pending.push(
          (
            await this.writer.createSystem(tx, conversation, actor.userId, {
              type: 'group_renamed',
              actorId: actor.userId,
              title: request.title,
            })
          ).event,
        );
      }
      pending.push(
        await this.outbox.add(
          tx,
          'conversation.updated',
          { conversationId },
          conversation.businessId,
        ),
      );
      await this.audit.record(
        actor,
        {
          action: 'group.updated',
          businessId: conversation.businessId,
          storeId: conversation.storeId,
          targetType: 'Conversation',
          targetId: conversationId,
          metadata: { fields: Object.keys(request) },
        },
        tx,
      );
      return pending;
    });
    await this.outbox.dispatch(events);
    return this.managerView(actor, conversationId);
  }

  async addMembers(
    actor: Actor,
    conversationId: string,
    request: AddMembersRequest,
  ): Promise<ConversationDetailDto> {
    const { conversation } = await this.access.requireGroupMemberAllowedBy(
      actor,
      conversationId,
      'addMembersPolicy',
    );
    const userIds = [...new Set(request.userIds)];
    await this.requireEligible(conversation.businessId, conversation.storeId, userIds);

    const events = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.conversationMember.findMany({
        where: { conversationId, userId: { in: userIds } },
        select: { userId: true, leftAt: true },
      });
      const alreadyActive = new Set(existing.filter((m) => m.leftAt === null).map((m) => m.userId));
      const toAdd = userIds.filter((id) => !alreadyActive.has(id));
      if (toAdd.length === 0) return [];
      // Lock the conversation row so the history boundary below is consistent with seq allocation.
      const { lastSeq, memberCount } = await tx.conversation.update({
        where: { id: conversationId },
        data: { memberCount: { increment: toAdd.length } },
        select: { lastSeq: true, memberCount: true },
      });
      if (memberCount > GROUP_MAX_MEMBERS)
        throw ApiError.validation(`Groups can have at most ${GROUP_MAX_MEMBERS} members.`);
      for (const userId of toAdd) {
        // New and returning members only see messages from now on (docs D3).
        const state = { historyFromSeq: lastSeq, lastReadSeq: lastSeq, lastDeliveredSeq: lastSeq };
        await tx.conversationMember.upsert({
          where: { conversationId_userId: { conversationId, userId } },
          create: { conversationId, userId, addedById: actor.userId, ...state },
          update: {
            ...state,
            leftAt: null,
            role: 'MEMBER',
            joinedAt: new Date(),
            addedById: actor.userId,
            markedUnread: false,
            mutedUntil: null,
            archivedAt: null,
          },
        });
      }
      const system = await this.writer.createSystem(tx, conversation, actor.userId, {
        type: 'members_added',
        actorId: actor.userId,
        userIds: toAdd,
      });
      await this.audit.record(
        actor,
        {
          action: 'group.members_added',
          businessId: conversation.businessId,
          storeId: conversation.storeId,
          targetType: 'Conversation',
          targetId: conversationId,
          metadata: { userIds: toAdd },
        },
        tx,
      );
      return [
        await this.outbox.add(
          tx,
          'conversation.updated',
          { conversationId },
          conversation.businessId,
        ),
        system.event,
      ];
    });
    await this.outbox.dispatch(events);
    return this.managerView(actor, conversationId);
  }

  async removeMember(actor: Actor, conversationId: string, userId: string): Promise<void> {
    if (userId === actor.userId) return this.leave(actor, conversationId);
    const { conversation } = await this.access.requireGroupManager(actor, conversationId);
    const events = await this.prisma.$transaction(async (tx) => {
      const pending = await this.access.endMembershipTx(
        tx,
        conversation,
        userId,
        actor.userId,
        'removed',
      );
      if (pending.length === 0) throw ApiError.notFound('Member');
      await this.audit.record(
        actor,
        {
          action: 'group.member_removed',
          businessId: conversation.businessId,
          storeId: conversation.storeId,
          targetType: 'Conversation',
          targetId: conversationId,
          metadata: { userId },
        },
        tx,
      );
      return pending;
    });
    await this.outbox.dispatch(events);
  }

  async leave(actor: Actor, conversationId: string): Promise<void> {
    const { conversation } = await this.access.requireMember(conversationId, actor.userId);
    if (conversation.type !== 'GROUP') throw ApiError.validation('You can only leave groups.');
    const events = await this.prisma.$transaction((tx) =>
      this.access.endMembershipTx(tx, conversation, actor.userId, actor.userId, 'left'),
    );
    await this.outbox.dispatch(events);
  }

  async updateMember(
    actor: Actor,
    conversationId: string,
    userId: string,
    request: UpdateMemberRequest,
  ): Promise<ConversationDetailDto> {
    const { conversation, member: me } = await this.access.requireGroupManager(
      actor,
      conversationId,
    );
    // WhatsApp rule: only the group's own admins make or dismiss admins. Business-level
    // managers may appoint one only when the group has no admin left.
    if (me?.role !== 'ADMIN') {
      const admins = await this.prisma.conversationMember.count({
        where: { conversationId, leftAt: null, role: 'ADMIN' },
      });
      if (admins > 0) throw ApiError.forbidden('Only group admins can change who is an admin.');
    }
    const events = await this.prisma.$transaction(async (tx) => {
      const member = await tx.conversationMember.findFirst({
        where: { conversationId, userId, leftAt: null },
        select: { id: true, role: true },
      });
      if (!member) throw ApiError.notFound('Member');
      if (member.role === request.role) return [];
      if (request.role === 'MEMBER') {
        const admins = await tx.conversationMember.count({
          where: { conversationId, leftAt: null, role: 'ADMIN' },
        });
        if (admins <= 1) throw ApiError.conflict('A group needs at least one admin.');
      }
      await tx.conversationMember.update({
        where: { id: member.id },
        data: { role: request.role },
      });
      const system = await this.writer.createSystem(tx, conversation, actor.userId, {
        type: 'admin_changed',
        actorId: actor.userId,
        userId,
        role: request.role,
      });
      return [
        await this.outbox.add(
          tx,
          'conversation.updated',
          { conversationId },
          conversation.businessId,
        ),
        system.event,
      ];
    });
    await this.outbox.dispatch(events);
    return this.managerView(actor, conversationId);
  }

  /** Per-user conversation state (mute, pin, archive, unread mark). Synced to the user's other devices. */
  async updateMyState(
    actor: Actor,
    conversationId: string,
    request: UpdateMyConversationStateRequest,
  ): Promise<ConversationSummaryDto> {
    const { member } = await this.access.requireMember(conversationId, actor.userId);
    if (request.pinned) {
      const pinned = await this.prisma.conversationMember.count({
        where: {
          userId: actor.userId,
          leftAt: null,
          pinnedAt: { not: null },
          NOT: { id: member.id },
        },
      });
      if (pinned >= MAX_PINNED_CONVERSATIONS) {
        throw ApiError.conflict(`You can pin up to ${MAX_PINNED_CONVERSATIONS} chats.`);
      }
    }
    await this.prisma.conversationMember.update({
      where: { id: member.id },
      data: {
        ...(request.mutedUntil !== undefined ? { mutedUntil: request.mutedUntil } : {}),
        ...(request.pinned !== undefined ? { pinnedAt: request.pinned ? new Date() : null } : {}),
        ...(request.archived !== undefined
          ? { archivedAt: request.archived ? new Date() : null }
          : {}),
        ...(request.markedUnread !== undefined ? { markedUnread: request.markedUnread } : {}),
      },
    });
    if (request.clearHistory) {
      // "Clear chat" (for me only): everything up to now disappears from this member's view.
      const { lastSeq } = await this.prisma.conversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: { lastSeq: true },
      });
      await this.prisma.conversationMember.update({
        where: { id: member.id },
        data: {
          historyFromSeq: Math.max(member.historyFromSeq, lastSeq),
          lastReadSeq: Math.max(member.lastReadSeq, lastSeq),
          lastDeliveredSeq: Math.max(member.lastDeliveredSeq, lastSeq),
          markedUnread: false,
        },
      });
    }
    const summary = await this.queries.summaryForUser(conversationId, actor.userId);
    if (!summary) throw ApiError.notFound('Conversation');
    this.realtime.toUsers([actor.userId], 'conversation.updated', summary);
    return summary;
  }

  /** "Groups in common" for a direct chat: groups both people are active members of. */
  /** Disappearing messages: anyone in a direct chat; in groups whoever may edit group info. */
  async setDisappearing(
    actor: Actor,
    conversationId: string,
    seconds: number | null,
  ): Promise<ConversationDetailDto> {
    const { conversation, member } = await this.access.requireMember(conversationId, actor.userId);
    if (conversation.type !== 'DIRECT' && conversation.type !== 'GROUP')
      throw ApiError.validation('Disappearing messages are for chats and groups.');
    if (
      conversation.type === 'GROUP' &&
      conversation.editInfoPolicy === 'ADMINS_ONLY' &&
      member.role !== 'ADMIN'
    )
      throw ApiError.forbidden('Only group admins can change this.');
    const events = await this.prisma.$transaction(async (tx) => {
      await tx.conversation.update({
        where: { id: conversationId },
        data: { disappearAfterSeconds: seconds },
      });
      const system = await this.writer.createSystem(tx, conversation, actor.userId, {
        type: 'disappearing_changed',
        actorId: actor.userId,
        seconds,
      });
      const updated = await this.outbox.add(
        tx,
        'conversation.updated',
        { conversationId },
        conversation.businessId,
      );
      return [system.event, updated];
    });
    await this.outbox.dispatch(events);
    return this.get(actor, conversationId);
  }

  async commonGroups(actor: Actor, conversationId: string): Promise<CommonGroupDto[]> {
    const { conversation } = await this.access.requireMember(conversationId, actor.userId);
    if (conversation.type !== 'DIRECT') return [];
    const other = await this.prisma.conversationMember.findFirst({
      where: { conversationId, userId: { not: actor.userId } },
      select: { userId: true },
    });
    if (!other) return [];
    const rows = await this.prisma.conversation.findMany({
      where: {
        type: 'GROUP',
        businessId: conversation.businessId,
        AND: [
          { members: { some: { userId: actor.userId, leftAt: null } } },
          { members: { some: { userId: other.userId, leftAt: null } } },
        ],
      },
      select: { id: true, title: true, memberCount: true },
      orderBy: { lastActivityAt: 'desc' },
      take: 50,
    });
    return rows.map((r) => ({ id: r.id, title: r.title ?? 'Group', memberCount: r.memberCount }));
  }

  /** Managers who are not members get the detail without personal state. */
  private async managerView(actor: Actor, conversationId: string): Promise<ConversationDetailDto> {
    const detail = await this.queries.detailForUser(conversationId, actor.userId);
    if (detail) return detail;
    throw ApiError.forbidden('Saved. Join the group to see its messages.');
  }

  private async rejoinDirect(conversationId: string, userIds: string[]): Promise<void> {
    const events = await this.prisma.$transaction(async (tx: Tx) => {
      const left = await tx.conversationMember.findMany({
        where: { conversationId, userId: { in: userIds }, leftAt: { not: null } },
        select: { id: true },
      });
      if (left.length === 0) return [];
      const { lastSeq, businessId } = await tx.conversation.update({
        where: { id: conversationId },
        data: { memberCount: { increment: left.length } },
        select: { lastSeq: true, businessId: true },
      });
      await tx.conversationMember.updateMany({
        where: { id: { in: left.map((m) => m.id) } },
        data: {
          leftAt: null,
          historyFromSeq: lastSeq,
          lastReadSeq: lastSeq,
          lastDeliveredSeq: lastSeq,
          joinedAt: new Date(),
        },
      });
      return [await this.outbox.add(tx, 'conversation.updated', { conversationId }, businessId)];
    });
    await this.outbox.dispatch(events);
  }

  /**
   * Group members must be active internal members of the business; for store groups they
   * must also belong to the store or hold a business-wide role there.
   */
  private async requireEligible(
    businessId: string,
    storeId: string | null,
    userIds: string[],
  ): Promise<void> {
    if (userIds.length === 0) return;
    const eligible = await this.prisma.user.count({
      where: {
        id: { in: userIds },
        status: 'ACTIVE',
        kind: 'INTERNAL',
        businessMemberships: { some: { businessId, status: 'ACTIVE' } },
        ...(storeId
          ? {
              OR: [
                { storeMemberships: { some: { storeId, status: 'ACTIVE' } } },
                {
                  roleAssignments: { some: { businessId, scopeType: 'BUSINESS', revokedAt: null } },
                },
                { roleAssignments: { some: { scopeType: 'PLATFORM', revokedAt: null } } },
              ],
            }
          : {}),
      },
    });
    if (eligible !== userIds.length) {
      throw ApiError.validation(
        storeId
          ? 'Some people cannot be added: they must work at this store.'
          : 'Some people cannot be added: they must be active members of this business.',
        'userIds',
      );
    }
  }
}
