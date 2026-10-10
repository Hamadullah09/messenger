import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { resolveBusinessPolicy } from '@storeline/shared';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RealtimeEmitter } from '../realtime/realtime-emitter.service';
import { ConversationAccessService } from './conversation-access.service';
import { unreadCount } from './mappers';

export type ReceiptKind = 'delivered' | 'read';

/**
 * Delivery and read acknowledgements from recipient devices. Watermarks only move
 * forward (GREATEST) and are clamped to the conversation's lastSeq, so replays, reordering
 * and forged future seqs are harmless.
 */
@Injectable()
export class ReceiptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ConversationAccessService,
    private readonly realtime: RealtimeEmitter,
  ) {}

  async acknowledge(
    userId: string,
    conversationId: string,
    seq: number,
    kind: ReceiptKind,
  ): Promise<void> {
    const { conversation, member } = await this.access.requireMember(conversationId, userId);
    const target = Math.min(seq, conversation.lastSeq);
    const previous = kind === 'read' ? member.lastReadSeq : member.lastDeliveredSeq;
    if (target <= previous && kind !== 'read') return;

    const rows = await this.prisma.$queryRaw<
      Array<{ lastDeliveredSeq: number; lastReadSeq: number; historyFromSeq: number }>
    >(
      kind === 'read'
        ? Prisma.sql`
            UPDATE "ConversationMember"
               SET "lastReadSeq" = GREATEST("lastReadSeq", ${target}),
                   "lastDeliveredSeq" = GREATEST("lastDeliveredSeq", ${target}),
                   "markedUnread" = false
             WHERE "id" = ${member.id}::uuid AND "leftAt" IS NULL
         RETURNING "lastDeliveredSeq", "lastReadSeq", "historyFromSeq"`
        : Prisma.sql`
            UPDATE "ConversationMember"
               SET "lastDeliveredSeq" = GREATEST("lastDeliveredSeq", ${target})
             WHERE "id" = ${member.id}::uuid AND "leftAt" IS NULL
         RETURNING "lastDeliveredSeq", "lastReadSeq", "historyFromSeq"`,
    );
    const updated = rows[0];
    if (!updated) return;

    if (kind === 'read') {
      // Sync unread badges across the reader's own devices.
      this.realtime.toUsers([userId], 'conversation.unread_count', {
        conversationId,
        lastReadSeq: updated.lastReadSeq,
        unreadCount: unreadCount(conversation.lastSeq, { ...updated, markedUnread: false }),
      });
    }
    if (target <= previous) return;

    // Only senders of the newly acknowledged messages care about the receipt.
    const senders = await this.prisma.message.findMany({
      where: {
        conversationId,
        seq: { gt: previous, lte: target },
        senderId: { not: userId },
        kind: { not: 'SYSTEM' },
      },
      distinct: ['senderId'],
      select: { senderId: true },
    });
    if (senders.length === 0) return;
    const readReceipts = resolveBusinessPolicy(conversation.business.policy).readReceiptsEnabled;
    if (kind === 'read' && !readReceipts && updated.lastDeliveredSeq <= member.lastDeliveredSeq)
      return;
    this.realtime.toUsers(
      senders.map((s) => s.senderId),
      'receipt.updated',
      {
        conversationId,
        userId,
        lastDeliveredSeq: updated.lastDeliveredSeq,
        lastReadSeq: readReceipts ? updated.lastReadSeq : null,
      },
    );
  }
}
