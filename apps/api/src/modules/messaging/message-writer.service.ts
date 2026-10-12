import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma, type MessageKind } from '@prisma/client';
import type { MessageMeta, SystemEventDto } from '@storeline/shared';
import type { Tx } from '../../infra/prisma/prisma.service';
import { OutboxService, type PendingOutboxEvent } from '../outbox/outbox.service';

export interface NewMessage {
  conversationId: string;
  businessId: string;
  senderId: string;
  clientMessageId: string;
  kind: MessageKind;
  /** A READY media asset, already validated by the caller. */
  mediaId?: string | null;
  body: string | null;
  systemEvent?: SystemEventDto;
  /** Kind-specific content (MessageMeta). */
  meta?: MessageMeta | null;
  replyToId?: string | null;
  forwardedFromId?: string | null;
}

/**
 * The single write path for new messages. Must run inside a transaction:
 * 1. allocate the next per-conversation seq (row lock ⇒ seq order == commit order, ADR-0003)
 * 2. insert the message
 * 3. point the conversation at it and record the outbox event (ADR-0002)
 */
@Injectable()
export class MessageWriter {
  constructor(private readonly outbox: OutboxService) {}

  async allocateSeq(tx: Tx, conversationId: string): Promise<number> {
    return (await this.allocate(tx, conversationId)).lastSeq;
  }

  private allocate(tx: Tx, conversationId: string) {
    return tx.conversation.update({
      where: { id: conversationId },
      data: { lastSeq: { increment: 1 }, lastActivityAt: new Date() },
      select: { lastSeq: true, disappearAfterSeconds: true },
    });
  }

  async create(
    tx: Tx,
    message: NewMessage,
  ): Promise<{ id: string; seq: number; event: PendingOutboxEvent }> {
    const { lastSeq: seq, disappearAfterSeconds } = await this.allocate(tx, message.conversationId);
    // Disappearing messages (not the chat's own notices).
    const expiresAt =
      disappearAfterSeconds && message.kind !== 'SYSTEM'
        ? new Date(Date.now() + disappearAfterSeconds * 1000)
        : null;
    const row = await tx.message.create({
      data: {
        conversationId: message.conversationId,
        seq,
        senderId: message.senderId,
        clientMessageId: message.clientMessageId,
        kind: message.kind,
        body: message.body,
        systemEvent: message.systemEvent
          ? (message.systemEvent as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        meta: message.meta ? (message.meta as Prisma.InputJsonValue) : Prisma.JsonNull,
        replyToId: message.replyToId ?? null,
        forwardedFromId: message.forwardedFromId ?? null,
        expiresAt,
      },
      select: { id: true },
    });
    if (message.mediaId) {
      await tx.messageAttachment.create({
        data: { messageId: row.id, mediaId: message.mediaId, position: 0 },
      });
    }
    await tx.conversation.update({
      where: { id: message.conversationId },
      data: { lastMessageId: row.id },
    });
    // The sender has implicitly read everything up to their own message.
    await tx.conversationMember.updateMany({
      where: { conversationId: message.conversationId, userId: message.senderId, leftAt: null },
      data: { lastReadSeq: seq, lastDeliveredSeq: seq, markedUnread: false },
    });
    const event = await this.outbox.add(
      tx,
      'message.created',
      { messageId: row.id },
      message.businessId,
    );
    return { id: row.id, seq, event };
  }

  createSystem(
    tx: Tx,
    conversation: { id: string; businessId: string },
    actorId: string,
    systemEvent: SystemEventDto,
  ): Promise<{ id: string; seq: number; event: PendingOutboxEvent }> {
    return this.create(tx, {
      conversationId: conversation.id,
      businessId: conversation.businessId,
      senderId: actorId,
      clientMessageId: randomUUID(),
      kind: 'SYSTEM',
      body: null,
      systemEvent,
    });
  }
}
