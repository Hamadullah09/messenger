import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  Module,
  type DynamicModule,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Gauge } from 'prom-client';
import { OutboxService } from '../../modules/outbox/outbox.service';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { registry } from './metrics';

export const METRICS_ROLE = Symbol('METRICS_ROLE');
export type MetricsRole = 'api' | 'worker';

/**
 * Serves /metrics on a separate, internal port (never the public API port), bound to
 * METRICS_HOST (loopback by default). An optional bearer token protects it further.
 */
@Injectable()
export class MetricsServer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MetricsServer.name);
  private server: Server | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(METRICS_ROLE) private readonly role: MetricsRole,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.METRICS_ENABLED) return;
    registry.setDefaultLabels({ role: this.role });
    const port = this.role === 'api' ? this.config.METRICS_PORT : this.config.METRICS_WORKER_PORT;
    const token = this.config.METRICS_TOKEN;
    this.server = createServer((req, res) => {
      if (req.method !== 'GET' || req.url !== '/metrics') {
        res.writeHead(404).end();
        return;
      }
      if (token) {
        const given = Buffer.from(req.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${token}`);
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
          res.writeHead(401).end();
          return;
        }
      }
      registry
        .metrics()
        .then((body) => res.writeHead(200, { 'Content-Type': registry.contentType }).end(body))
        .catch((error: unknown) => {
          this.logger.error({ err: error }, 'Metrics collection failed');
          res.writeHead(500).end();
        });
    });
    this.server.on('error', (error) =>
      this.logger.error({ err: error, port }, 'Metrics server failed to start'),
    );
    this.server.listen(port, this.config.METRICS_HOST, () =>
      this.logger.log({ port, host: this.config.METRICS_HOST }, 'Metrics endpoint listening'),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
  }
}

/** Runs `fn` at most once per `ttlMs`, so frequent scrapes do not load the database. */
function cached<T>(fn: () => Promise<T>, ttlMs = 10_000): () => Promise<T> {
  let at = 0;
  let value: Promise<T> | null = null;
  return () => {
    if (!value || Date.now() - at > ttlMs) {
      at = Date.now();
      value = fn().catch((error: unknown) => {
        value = null;
        throw error;
      });
    }
    return value;
  };
}

/**
 * Backlog and health gauges computed at scrape time. Registered in the worker only, so each
 * value is reported once per deployment rather than once per API replica.
 */
@Injectable()
export class OperationalGauges implements OnApplicationBootstrap {
  private readonly logger = new Logger(OperationalGauges.name);

  constructor(
    @Inject(METRICS_ROLE) private readonly role: MetricsRole,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly outbox: OutboxService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.role !== 'worker') return;
    const safe =
      <T>(name: string, fn: () => Promise<T>) =>
      async () => {
        try {
          return await fn();
        } catch (error) {
          this.logger.warn({ err: error, gauge: name }, 'Gauge collection failed');
          return null;
        }
      };

    const queueCounts = cached(
      async () => ({
        delivery: await this.outbox.queue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
        media: await this.outbox.mediaQueue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
      }),
      5000,
    );
    new Gauge({
      name: 'sma_queue_jobs',
      help: 'BullMQ jobs by queue and state (failed = dead-letter set)',
      labelNames: ['queue', 'state'] as const,
      registers: [registry],
      collect: async function () {
        const counts = await safe('queue', queueCounts)();
        if (!counts) return;
        for (const [queue, states] of Object.entries(counts))
          for (const [state, n] of Object.entries(states)) this.set({ queue, state }, n);
      },
    });

    const backlog = cached(async () => {
      const [row] = await this.prisma.$queryRaw<
        Array<{
          outbox_pending: number;
          outbox_oldest_s: number | null;
          outbox_failed: number;
          incidents_awaiting: number;
          incidents_overdue_s: number | null;
          campaigns_sending: number;
          campaign_pending: number;
          media_verifying: number;
          storage_bytes: bigint | null;
          storage_ratio_max: number | null;
          db_connections: number;
        }>
      >`
        SELECT
          (SELECT count(*)::int FROM "OutboxEvent" WHERE "status" = 'PENDING') AS outbox_pending,
          (SELECT EXTRACT(EPOCH FROM now() - min("createdAt"))::float FROM "OutboxEvent" WHERE "status" = 'PENDING') AS outbox_oldest_s,
          (SELECT count(*)::int FROM "OutboxEvent" WHERE "status" = 'FAILED') AS outbox_failed,
          (SELECT count(*)::int FROM "EmergencyIncident" WHERE "status" IN ('OPEN','ESCALATED')) AS incidents_awaiting,
          (SELECT EXTRACT(EPOCH FROM now() - min("ackDeadlineAt"))::float FROM "EmergencyIncident"
            WHERE "status" IN ('OPEN','ESCALATED') AND "ackDeadlineAt" < now()) AS incidents_overdue_s,
          (SELECT count(*)::int FROM "BulkCampaign" WHERE "status" = 'SENDING') AS campaigns_sending,
          (SELECT count(*)::int FROM "BulkCampaignRecipient" r JOIN "BulkCampaign" c ON c."id" = r."campaignId"
            WHERE c."status" IN ('SENDING','PAUSED') AND r."state" = 'PENDING') AS campaign_pending,
          (SELECT count(*)::int FROM "MediaAsset" WHERE "status" = 'VERIFYING') AS media_verifying,
          (SELECT sum("sizeBytes") FROM "MediaAsset" WHERE "status" IN ('PENDING_UPLOAD','VERIFYING','READY')) AS storage_bytes,
          (SELECT max(u.used::float / NULLIF(q."maxStorageBytes", 0)) FROM "TenantQuota" q
             JOIN (SELECT "businessId", sum("sizeBytes") AS used FROM "MediaAsset"
                    WHERE "status" IN ('PENDING_UPLOAD','VERIFYING','READY') GROUP BY 1) u
               ON u."businessId" = q."businessId") AS storage_ratio_max,
          (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS db_connections`;
      return row!;
    });
    const gauge = (
      name: string,
      help: string,
      pick: (r: Awaited<ReturnType<typeof backlog>>) => number | null,
    ) =>
      new Gauge({
        name,
        help,
        registers: [registry],
        collect: async function () {
          const row = await safe(name, backlog)();
          if (row) this.set(Number(pick(row) ?? 0));
        },
      });
    gauge('sma_outbox_pending', 'Outbox events not yet published', (r) => r.outbox_pending);
    gauge(
      'sma_outbox_oldest_pending_seconds',
      'Age of the oldest unpublished outbox event',
      (r) => r.outbox_oldest_s,
    );
    gauge('sma_outbox_failed', 'Dead-lettered outbox events', (r) => r.outbox_failed);
    gauge(
      'sma_emergency_awaiting_ack',
      'Emergency alerts waiting for acknowledgement',
      (r) => r.incidents_awaiting,
    );
    gauge(
      'sma_emergency_overdue_seconds',
      'How long the most overdue alert has waited past its deadline',
      (r) => r.incidents_overdue_s,
    );
    gauge('sma_campaigns_sending', 'Campaigns currently sending', (r) => r.campaigns_sending);
    gauge(
      'sma_campaign_pending_recipients',
      'Recipients still queued in sending or paused campaigns',
      (r) => r.campaign_pending,
    );
    gauge('sma_media_verifying', 'Uploads waiting for verification', (r) => r.media_verifying);
    gauge('sma_storage_bytes', 'Bytes of stored and in-flight media', (r) =>
      Number(r.storage_bytes ?? 0),
    );
    gauge(
      'sma_tenant_storage_usage_ratio_max',
      'Highest storage quota usage across tenants (0–1)',
      (r) => r.storage_ratio_max,
    );
    gauge(
      'sma_db_connections',
      'Open connections to the application database',
      (r) => r.db_connections,
    );

    const redisPing = cached(async () => {
      const start = process.hrtime.bigint();
      await this.redis.client.ping();
      return Number(process.hrtime.bigint() - start) / 1e9;
    }, 5000);
    new Gauge({
      name: 'sma_redis_up',
      help: '1 when Redis answers PING',
      registers: [registry],
      collect: async function () {
        this.set((await safe('redis', redisPing)()) === null ? 0 : 1);
      },
    });
    new Gauge({
      name: 'sma_redis_ping_seconds',
      help: 'Redis PING round trip',
      registers: [registry],
      collect: async function () {
        const s = await safe('redis', redisPing)();
        if (s !== null) this.set(s);
      },
    });
  }
}

@Module({})
export class MetricsModule {
  static forRole(role: MetricsRole): DynamicModule {
    return {
      module: MetricsModule,
      providers: [{ provide: METRICS_ROLE, useValue: role }, MetricsServer, OperationalGauges],
    };
  }
}
