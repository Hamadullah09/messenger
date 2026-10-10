import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config/config';

/**
 * Shared Redis command connection. BullMQ and the Socket.IO adapter create their own
 * dedicated connections (blocking commands / pub-sub) from `createConnection`.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  /**
   * Best-effort commands (rate limits, presence, health pings): fail fast during an outage
   * so callers degrade immediately (rate limits fail open) instead of waiting on retries.
   */
  readonly client: Redis;
  private readonly extra: Redis[] = [];

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.client = this.createConnection('commands', { failFast: true });
  }

  /** Waits (bounded) for the first connection so early requests are not degraded needlessly. */
  async onModuleInit(): Promise<void> {
    if (this.client.status === 'ready') return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.logger.warn('Redis not ready after 5 s; continuing in degraded mode');
        resolve();
      }, 5000);
      this.client.once('ready', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * `failFast`: commands error immediately while Redis is unreachable instead of waiting in
   * the offline queue. Used by queue producers on request paths, which have a durable
   * fallback (the outbox relay) and must never block an HTTP request on a Redis outage.
   */
  createConnection(name: string, options: { forBullMq?: boolean; failFast?: boolean } = {}): Redis {
    const connection = new Redis(this.config.REDIS_URL, {
      connectionName: `storeline:${name}`,
      // BullMQ requires null so blocking commands are never aborted.
      maxRetriesPerRequest: options.forBullMq ? null : 3,
      enableOfflineQueue: !options.failFast,
      lazyConnect: false,
    });
    if (name !== 'commands') this.extra.push(connection);
    return connection;
  }

  /** Runs after the HTTP and WebSocket servers have closed, so adapters can unsubscribe cleanly. */
  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.client, ...this.extra].map((c) => c.quit()));
  }
}
