import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { OutboxService } from './outbox.service';
import type { OutboxEventType } from './outbox.types';

const POLL_INTERVAL_MS = 1_000;
const BATCH_SIZE = 200;
/** Kept short so delivery resumes within seconds after a Redis outage ends. */
const MAX_BACKOFF_MS = 5_000;
const RETENTION_DAYS = 7;
const CLEANUP_INTERVAL_MS = 60 * 60_000;

/**
 * Guaranteed path of the transactional outbox (ADR-0002): moves PENDING events into the
 * delivery queue. `FOR UPDATE SKIP LOCKED` lets several worker replicas relay in parallel
 * without double-processing a row.
 */
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private stopped = false;
  private loop: Promise<void> | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  onApplicationBootstrap(): void {
    this.loop = this.run();
    this.cleanupTimer = setInterval(() => void this.cleanup(), CLEANUP_INTERVAL_MS).unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    await this.loop;
  }

  /** Relays one batch. Returns the number of events published. Exposed for tests. */
  async relayOnce(): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ id: string; type: OutboxEventType; attempts: number }>
      >(Prisma.sql`
        SELECT "id", "type", "attempts" FROM "OutboxEvent"
         WHERE "status" = 'PENDING' AND "availableAt" <= now()
         ORDER BY "availableAt"
         LIMIT ${BATCH_SIZE}
         FOR UPDATE SKIP LOCKED`);
      if (rows.length === 0) return 0;
      try {
        await this.outbox.enqueue(rows.map((r) => ({ id: r.id, type: r.type })));
      } catch (error) {
        // Queue unavailable (e.g. Redis down): back off and keep the events pending. Never drop them.
        const attempts = Math.max(...rows.map((r) => r.attempts)) + 1;
        const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(attempts, 10));
        await tx.outboxEvent.updateMany({
          where: { id: { in: rows.map((r) => r.id) } },
          data: {
            attempts: { increment: 1 },
            availableAt: new Date(Date.now() + delay),
            lastError: String((error as Error)?.message ?? error).slice(0, 500),
          },
        });
        this.logger.warn(
          { err: error, count: rows.length },
          'Outbox relay could not enqueue; will retry',
        );
        return 0;
      }
      await tx.outboxEvent.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });
      return rows.length;
    });
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      let published = 0;
      try {
        published = await this.relayOnce();
      } catch (error) {
        this.logger.error({ err: error }, 'Outbox relay iteration failed');
      }
      if (published < BATCH_SIZE) await sleep(POLL_INTERVAL_MS);
    }
  }

  private async cleanup(): Promise<void> {
    try {
      const { count } = await this.prisma.outboxEvent.deleteMany({
        where: {
          status: 'PUBLISHED',
          publishedAt: { lt: new Date(Date.now() - RETENTION_DAYS * 86_400_000) },
        },
      });
      if (count > 0) this.logger.log({ count }, 'Purged published outbox events');
    } catch (error) {
      this.logger.error({ err: error }, 'Outbox cleanup failed');
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
