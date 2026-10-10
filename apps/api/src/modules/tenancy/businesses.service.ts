import { Injectable } from '@nestjs/common';
import { Prisma, type BusinessStatus } from '@prisma/client';
import {
  DEFAULT_BUSINESS_POLICY,
  resolveBusinessPolicy,
  type BusinessDto,
  type CreateBusinessRequest,
  type Page,
  type PaginationQuery,
  type UpdateBusinessRequest,
} from '@storeline/shared';
import { ApiError } from '../../infra/http/api-error';
import { decodeCursor, encodeCursor, isIdCursor } from '../../infra/http/cursor';
import { isUniqueViolation, PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { AuthorizationService } from '../authorization/authorization.service';

const businessSelect = {
  id: true,
  name: true,
  slug: true,
  status: true,
  timeZone: true,
  locale: true,
  policy: true,
  createdAt: true,
  _count: {
    select: {
      stores: { where: { status: 'ACTIVE' } },
      memberships: { where: { status: 'ACTIVE' } },
    },
  },
} as const satisfies Prisma.BusinessSelect;

type BusinessRow = Prisma.BusinessGetPayload<{ select: typeof businessSelect }>;

function toDto(row: BusinessRow): BusinessDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    timeZone: row.timeZone,
    locale: row.locale,
    policy: resolveBusinessPolicy(row.policy),
    storeCount: row._count.stores,
    memberCount: row._count.memberships,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class BusinessesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  async list(actor: Actor, query: PaginationQuery): Promise<Page<BusinessDto>> {
    const scope = await this.authz.scopedFilter(actor, 'business.read');
    if (!scope.all && scope.businessIds.length === 0) return { items: [], nextCursor: null };
    const cursor = decodeCursor(query.cursor, isIdCursor);
    const rows = await this.prisma.business.findMany({
      where: scope.all ? {} : { id: { in: scope.businessIds } },
      select: businessSelect,
      orderBy: { id: 'asc' },
      take: query.limit + 1,
      ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
    });
    const items = rows.slice(0, query.limit).map(toDto);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > query.limit && last ? encodeCursor({ id: last.id }) : null,
    };
  }

  async get(actor: Actor, businessId: string): Promise<BusinessDto> {
    const row = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: businessSelect,
    });
    if (!row) throw ApiError.notFound('Business');
    await this.authz.require(actor, 'business.read', { businessId });
    return toDto(row);
  }

  async create(actor: Actor, request: CreateBusinessRequest): Promise<BusinessDto> {
    await this.authz.require(actor, 'business.create', null);
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.business.create({
          data: {
            name: request.name,
            slug: request.slug,
            timeZone: request.timeZone,
            locale: request.locale,
            policy: DEFAULT_BUSINESS_POLICY,
            quota: { create: {} },
          },
          select: businessSelect,
        });
        await this.audit.record(
          actor,
          {
            action: 'business.created',
            businessId: created.id,
            targetType: 'Business',
            targetId: created.id,
            metadata: { slug: created.slug },
          },
          tx,
        );
        return created;
      });
      return toDto(row);
    } catch (error) {
      if (isUniqueViolation(error))
        throw ApiError.conflict('A business with this short name already exists.');
      throw error;
    }
  }

  async update(
    actor: Actor,
    businessId: string,
    request: UpdateBusinessRequest,
  ): Promise<BusinessDto> {
    const existing = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { policy: true },
    });
    if (!existing) throw ApiError.notFound('Business');
    await this.authz.require(actor, 'business.update', { businessId });
    const policy = request.policy
      ? { ...resolveBusinessPolicy(existing.policy), ...request.policy }
      : undefined;
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.business.update({
        where: { id: businessId },
        data: {
          name: request.name,
          timeZone: request.timeZone,
          locale: request.locale,
          ...(policy ? { policy } : {}),
        },
        select: businessSelect,
      });
      await this.audit.record(
        actor,
        {
          action: 'business.updated',
          businessId,
          targetType: 'Business',
          targetId: businessId,
          metadata: { fields: Object.keys(request), policy: request.policy ?? null },
        },
        tx,
      );
      return updated;
    });
    return toDto(row);
  }

  async setStatus(actor: Actor, businessId: string, status: BusinessStatus): Promise<BusinessDto> {
    const existing = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { status: true },
    });
    if (!existing) throw ApiError.notFound('Business');
    await this.authz.require(
      actor,
      status === 'ARCHIVED' ? 'business.archive' : 'business.suspend',
      { businessId },
    );
    if (existing.status === 'ARCHIVED')
      throw ApiError.conflict('Archived businesses cannot be changed.');
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.business.update({
        where: { id: businessId },
        data: { status, archivedAt: status === 'ARCHIVED' ? new Date() : null },
        select: businessSelect,
      });
      await this.audit.record(
        actor,
        {
          action: `business.${status === 'ACTIVE' ? 'reactivated' : status === 'SUSPENDED' ? 'suspended' : 'archived'}`,
          businessId,
          targetType: 'Business',
          targetId: businessId,
          metadata: { from: existing.status, to: status },
        },
        tx,
      );
      return updated;
    });
    return toDto(row);
  }
}
