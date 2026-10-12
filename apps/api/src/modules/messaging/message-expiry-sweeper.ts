import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RealtimeEmitter } from '../realtime/realtime-emitter.service';

const EVERY_MS = 60_000;
const BATCH = 500;

/**
 * Worker: removes disappearing messages once their time is up (for everyone, like WhatsApp:
 * the message, its reactions and its link to any file are deleted) and tells the open apps
 * to drop them from the screen.
 */
@Injectable()
export class MessageExpirySweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MessageExpirySweeper.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeEmitter,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.sweep(), EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let removed = 0;
    try {
      for (;;) {
        const expired = await this.prisma.message.findMany({
          where: { expiresAt: { lte: new Date() } },
          select: { id: true, conversationId: true },
          take: BATCH,
        });
        if (expired.length === 0) break;
        const ids = expired.map((m) => m.id);
        await this.prisma.$transaction([
          // The conversation's preview must not point at a removed message.
          this.prisma.conversation.updateMany({
            where: { lastMessageId: { in: ids } },
            data: { lastMessageId: null },
          }),
          this.prisma.message.deleteMany({ where: { id: { in: ids } } }),
        ]);
        const byConversation = new Map<string, string[]>();
        for (const m of expired)
          byConversation.set(m.conversationId, [...(byConversation.get(m.conversationId) ?? []), m.id]);
        for (const [conversationId, messageIds] of byConversation) {
          const members = await this.prisma.conversationMember.findMany({
            where: { conversationId, leftAt: null },
            select: { userId: true },
          });
          const userIds = members.map((m) => m.userId);
          for (const messageId of messageIds)
            this.realtime.toUsers(userIds, 'message.hidden', { conversationId, messageId });
        }
        removed += expired.length;
        if (expired.length < BATCH) break;
      }
      if (removed > 0) this.logger.log({ removed }, 'Disappearing messages removed');
    } catch (error) {
      this.logger.error({ err: error }, 'Disappearing message sweep failed');
    } finally {
      this.running = false;
    }
    return removed;
  }
}
