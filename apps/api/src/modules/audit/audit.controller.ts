import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { auditQuerySchema, type AuditLogDto, type AuditQuery, type Page } from '@storeline/shared';
import { decodeCursor, encodeCursor } from '../../infra/http/cursor';
import { ApiZodQuery, ZodPipe } from '../../infra/http/zod';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { CurrentActor, type Actor } from '../auth/actor';
import { AuthorizationService } from '../authorization/authorization.service';
import { publicUserSelect, toPublicUser } from '../users/user.mapper';

const isAuditCursor = (v: Record<string, unknown>): v is { t: string; id: string } =>
  typeof v.t === 'string' && typeof v.id === 'string';

@ApiTags('audit')
@ApiBearerAuth()
@Controller({ path: 'audit', version: '1' })
export class AuditController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
  ) {}

  /** Business-scoped logs need audit.read on that business; the platform-wide log needs it at platform scope. */
  @Get()
  @ApiZodQuery(auditQuerySchema)
  async list(
    @CurrentActor() actor: Actor,
    @Query(new ZodPipe(auditQuerySchema)) query: AuditQuery,
  ): Promise<Page<AuditLogDto>> {
    await this.authz.require(
      actor,
      'audit.read',
      query.businessId ? { businessId: query.businessId } : null,
    );
    const cursor = decodeCursor(query.cursor, isAuditCursor);
    const where: Prisma.AuditLogWhereInput = {
      ...(query.businessId ? { businessId: query.businessId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
      ...(query.from || query.to ? { occurredAt: { gte: query.from, lte: query.to } } : {}),
      ...(cursor
        ? {
            OR: [
              { occurredAt: { lt: new Date(cursor.t) } },
              { occurredAt: new Date(cursor.t), id: { lt: cursor.id } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      include: { actor: { select: publicUserSelect } },
    });
    const items: AuditLogDto[] = rows.slice(0, query.limit).map((row) => ({
      id: row.id,
      occurredAt: row.occurredAt.toISOString(),
      action: row.action,
      outcome: row.outcome,
      actor: row.actor ? toPublicUser(row.actor) : null,
      businessId: row.businessId,
      storeId: row.storeId,
      targetType: row.targetType,
      targetId: row.targetId,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      requestId: row.requestId,
    }));
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ t: last.occurredAt, id: last.id })
          : null,
    };
  }
}
