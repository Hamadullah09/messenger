import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  resolveBusinessPolicy,
  type ConversationDetailDto,
  type ConversationSummaryDto,
  type ListConversationsQuery,
  type Page,
  type PublicUserDto,
} from '@storeline/shared';
import { decodeCursor, encodeCursor } from '../../infra/http/cursor';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { publicUserSelect, toPublicUser } from '../users/user.mapper';
import {
  conversationSummaryInclude,
  toConversationSummary,
  type MemberStateRow,
  type OtherMembersWatermarks,
} from './mappers';

const memberStateSelect = {
  userId: true,
  role: true,
  historyFromSeq: true,
  lastReadSeq: true,
  lastDeliveredSeq: true,
  mutedUntil: true,
  pinnedAt: true,
  archivedAt: true,
  markedUnread: true,
} as const satisfies Prisma.ConversationMemberSelect;

const MEMBER_LIST_LIMIT = 500;

const isActivityCursor = (v: Record<string, unknown>): v is { t: string; id: string } =>
  typeof v.t === 'string' && typeof v.id === 'string';

/** Read models for conversations, shared by the REST API and the delivery worker. */
@Injectable()
export class ConversationQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async listForUser(
    userId: string,
    query: ListConversationsQuery,
  ): Promise<Page<ConversationSummaryDto>> {
    const cursor = decodeCursor(query.cursor, isActivityCursor);
    const rows = await this.prisma.conversation.findMany({
      where: {
        members: {
          some: {
            userId,
            leftAt: null,
            ...(query.archived === undefined
              ? {}
              : { archivedAt: query.archived ? { not: null } : null }),
          },
        },
        business: { status: 'ACTIVE' },
        ...(query.businessId ? { businessId: query.businessId } : {}),
        ...(cursor
          ? {
              OR: [
                { lastActivityAt: { lt: new Date(cursor.t) } },
                { lastActivityAt: new Date(cursor.t), id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      include: {
        ...conversationSummaryInclude,
        members: { where: { userId }, select: memberStateSelect },
      },
    });
    const page = rows.slice(0, query.limit);
    const [counterparts, watermarks] = await Promise.all([
      this.directCounterparts(
        page.filter((c) => c.type === 'DIRECT').map((c) => c.id),
        userId,
      ),
      this.otherMembersWatermarks(
        page.map((c) => c.id),
        userId,
      ),
    ]);
    const items = page.flatMap((row) => {
      const member = row.members[0];
      return member
        ? [
            toConversationSummary(
              row,
              member,
              counterparts.get(row.id) ?? null,
              watermarks.get(row.id) ?? null,
            ),
          ]
        : [];
    });
    const last = page.at(-1);
    return {
      items,
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ t: last.lastActivityAt.toISOString(), id: last.id })
          : null,
    };
  }

  async summaryForUser(
    conversationId: string,
    userId: string,
  ): Promise<ConversationSummaryDto | null> {
    const row = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        ...conversationSummaryInclude,
        members: { where: { userId, leftAt: null }, select: memberStateSelect },
      },
    });
    const member = row?.members[0];
    if (!row || !member) return null;
    const counterpart =
      row.type === 'DIRECT'
        ? ((await this.directCounterparts([row.id], userId)).get(row.id) ?? null)
        : null;
    const watermarks = await this.otherMembersWatermarks([row.id], userId);
    return toConversationSummary(row, member, counterpart, watermarks.get(row.id) ?? null);
  }

  /** One grouped query: the lowest delivered/read watermark of the other members per conversation. */
  private async otherMembersWatermarks(
    conversationIds: string[],
    userId: string,
  ): Promise<Map<string, OtherMembersWatermarks>> {
    if (conversationIds.length === 0) return new Map();
    const rows = await this.prisma.conversationMember.groupBy({
      by: ['conversationId'],
      where: { conversationId: { in: conversationIds }, userId: { not: userId }, leftAt: null },
      _min: { lastDeliveredSeq: true, lastReadSeq: true },
    });
    return new Map(
      rows.map((r) => [
        r.conversationId,
        { minDeliveredSeq: r._min.lastDeliveredSeq ?? 0, minReadSeq: r._min.lastReadSeq ?? 0 },
      ]),
    );
  }

  /** Every active member's personalised summary — used by the worker for conversation.updated fan-out. */
  async summariesForAllMembers(
    conversationId: string,
  ): Promise<Array<{ userId: string; summary: ConversationSummaryDto }>> {
    const row = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        ...conversationSummaryInclude,
        members: {
          where: { leftAt: null },
          select: { ...memberStateSelect, user: { select: publicUserSelect } },
        },
      },
    });
    if (!row) return [];
    return row.members.map(
      (member: MemberStateRow & { user: Parameters<typeof toPublicUser>[0] }) => {
        const other =
          row.type === 'DIRECT'
            ? row.members.find((m) => m.userId !== member.userId)?.user
            : undefined;
        const others = row.members.filter((m) => m.userId !== member.userId);
        const watermarks =
          others.length > 0
            ? {
                minDeliveredSeq: Math.min(...others.map((m) => m.lastDeliveredSeq)),
                minReadSeq: Math.min(...others.map((m) => m.lastReadSeq)),
              }
            : null;
        return {
          userId: member.userId,
          summary: toConversationSummary(
            row,
            member,
            other ? toPublicUser(other) : null,
            watermarks,
          ),
        };
      },
    );
  }

  async detailForUser(
    conversationId: string,
    userId: string,
  ): Promise<ConversationDetailDto | null> {
    const summary = await this.summaryForUser(conversationId, userId);
    if (!summary) return null;
    const conversation = await this.prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: {
        createdAt: true,
        createdBy: { select: publicUserSelect },
        business: { select: { policy: true } },
        members: {
          where: { leftAt: null },
          orderBy: [{ role: 'desc' }, { joinedAt: 'asc' }],
          take: MEMBER_LIST_LIMIT + 1,
          select: {
            role: true,
            joinedAt: true,
            lastDeliveredSeq: true,
            lastReadSeq: true,
            historyFromSeq: true,
            user: { select: publicUserSelect },
          },
        },
      },
    });
    const readReceiptsEnabled = resolveBusinessPolicy(
      conversation.business.policy,
    ).readReceiptsEnabled;
    return {
      ...summary,
      createdAt: conversation.createdAt.toISOString(),
      createdBy: conversation.createdBy ? toPublicUser(conversation.createdBy) : null,
      members: conversation.members.slice(0, MEMBER_LIST_LIMIT).map((m) => ({
        user: toPublicUser(m.user),
        role: m.role,
        joinedAt: m.joinedAt.toISOString(),
        lastDeliveredSeq: Math.max(m.lastDeliveredSeq, m.historyFromSeq),
        lastReadSeq: readReceiptsEnabled ? Math.max(m.lastReadSeq, m.historyFromSeq) : null,
      })),
      membersTruncated: conversation.members.length > MEMBER_LIST_LIMIT,
      readReceiptsEnabled,
    };
  }

  /** The other participant of each direct conversation (including former members, for display). */
  private async directCounterparts(
    conversationIds: string[],
    userId: string,
  ): Promise<Map<string, PublicUserDto>> {
    if (conversationIds.length === 0) return new Map();
    const rows = await this.prisma.conversationMember.findMany({
      where: { conversationId: { in: conversationIds }, userId: { not: userId } },
      select: { conversationId: true, user: { select: publicUserSelect } },
    });
    return new Map(rows.map((r) => [r.conversationId, toPublicUser(r.user)]));
  }
}
