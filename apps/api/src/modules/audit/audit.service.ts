import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service';
import { metrics } from '../../infra/metrics/metrics';
/** Who performed an action. Anonymous/pre-session events pass sessionId null. */
export interface AuditActor {
  readonly userId: string | null;
  readonly sessionId?: string | null;
  readonly requestId?: string | null;
  readonly ipHash?: string | null;
}

export interface AuditEntry {
  action: string;
  outcome?: 'SUCCESS' | 'DENIED' | 'FAILURE';
  businessId?: string | null;
  storeId?: string | null;
  targetType?: string;
  targetId?: string | null;
  /** Never include message bodies, secrets, tokens or contact values. */
  metadata?: Record<string, unknown>;
}

/** Append-only audit trail. */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(actor: AuditActor | null, entry: AuditEntry, tx?: Tx): Promise<void> {
    const client = tx ?? this.prisma;
    await client.auditLog.create({
      data: {
        actorUserId: actor?.userId ?? null,
        actorSessionId: actor?.sessionId ?? null,
        requestId: actor?.requestId ?? null,
        ipHash: actor?.ipHash ?? null,
        action: entry.action,
        outcome: entry.outcome ?? 'SUCCESS',
        businessId: entry.businessId ?? null,
        storeId: entry.storeId ?? null,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        metadata: (entry.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
    metrics.auditEvents.inc({ action: entry.action, outcome: entry.outcome ?? 'SUCCESS' });
  }

  /** For denials and other records that must not fail the surrounding request. */
  async recordSafely(actor: AuditActor | null, entry: AuditEntry): Promise<void> {
    try {
      await this.record(actor, entry);
    } catch (error) {
      this.logger.error({ err: error, action: entry.action }, 'Failed to write audit record');
    }
  }
}
