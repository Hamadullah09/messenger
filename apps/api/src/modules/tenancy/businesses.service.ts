import { Injectable } from '@nestjs/common';
import { Prisma, type BusinessStatus } from '@prisma/client';
import {
  DEFAULT_BUSINESS_POLICY,
  resolveBusinessPolicy,
  type BusinessDto,
  type BusinessGroupDto,
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
import { placeDetailsData, placeDetailsSelect, processLogo, toPlaceDetails } from './place-details';

const businessSelect = {
  id: true,
  name: true,
  slug: true,
  status: true,
  timeZone: true,
  locale: true,
  policy: true,
  createdAt: true,
  ...placeDetailsSelect,
  stores: {
    where: { status: 'ACTIVE' },
    select: { id: true, name: true, code: true },
    orderBy: { name: 'asc' },
  },
  roleAssignments: {
    where: {
      revokedAt: null,
      scopeType: 'BUSINESS',
      role: {
        key: { in: ['BUSINESS_OWNER', 'BUSINESS_ADMIN', 'BUSINESS_MANAGER'] },
        isSystem: true,
      },
      user: { status: 'ACTIVE' },
    },
    select: {
      user: { select: { id: true, displayName: true, username: true } },
      role: { select: { name: true } },
    },
    orderBy: { createdAt: 'asc' },
  },
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
    ...toPlaceDetails(row, `/api/v1/businesses/${row.id}/logo`),
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    timeZone: row.timeZone,
    locale: row.locale,
    policy: resolveBusinessPolicy(row.policy),
    storeCount: row._count.stores,
    memberCount: row._count.memberships,
    stores: row.stores,
    admins: row.roleAssignments.map((a) => ({ ...a.user, roleName: a.role.name })),
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
      where: {
        deletedAt: null,
        // SMA's internal sales team is not a customer business.
        internal: false,
        ...(scope.all ? {} : { id: { in: scope.businessIds } }),
      },
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
            ...placeDetailsData(request),
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
          ...placeDetailsData(request),
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

  /** Replaces (or with null removes) the business logo. */
  async setLogo(actor: Actor, businessId: string, body: unknown | null): Promise<BusinessDto> {
    const existing = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true },
    });
    if (!existing) throw ApiError.notFound('Business');
    await this.authz.require(actor, 'business.update', { businessId });
    const logo = body === null ? null : await processLogo(body);
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.business.update({
        where: { id: businessId },
        data: { logo: logo ? new Uint8Array(logo) : null, logoUpdatedAt: logo ? new Date() : null },
        select: businessSelect,
      });
      await this.audit.record(
        actor,
        {
          action: logo ? 'business.logo_updated' : 'business.logo_removed',
          businessId,
          targetType: 'Business',
          targetId: businessId,
        },
        tx,
      );
      return updated;
    });
    return toDto(row);
  }

  /** Logos are public brand assets (served without sign-in so <img> tags work). */
  async logo(businessId: string): Promise<Buffer | null> {
    const row = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { logo: true },
    });
    return row?.logo ? Buffer.from(row.logo) : null;
  }

  /**
   * Groups of a business for people who manage groups: all of them with business-wide
   * group.manage, otherwise those of their stores. Titles and counts only, never messages.
   */
  async listGroups(actor: Actor, businessId: string): Promise<BusinessGroupDto[]> {
    const coverage = await this.authz.coverage(actor, 'group.manage');
    const wholeBusiness = coverage.all || coverage.businessIds.has(businessId);
    const storeIds = coverage.all
      ? []
      : [...coverage.stores].filter(([, b]) => b === businessId).map(([s]) => s);
    if (!wholeBusiness && storeIds.length === 0) throw ApiError.forbidden();
    const rows = await this.prisma.conversation.findMany({
      where: {
        businessId,
        type: 'GROUP',
        archivedAt: null,
        ...(wholeBusiness ? {} : { storeId: { in: storeIds } }),
      },
      select: {
        id: true,
        title: true,
        type: true,
        storeId: true,
        store: { select: { name: true } },
        memberCount: true,
        lastActivityAt: true,
        members: { where: { userId: actor.userId, leftAt: null }, select: { id: true } },
      },
      orderBy: { lastActivityAt: 'desc' },
      take: 500,
    });
    return rows.map((r) => ({
      id: r.id,
      title: r.title ?? 'Group',
      type: r.type as BusinessGroupDto['type'],
      storeId: r.storeId,
      storeName: r.store?.name ?? null,
      memberCount: r.memberCount,
      lastActivityAt: r.lastActivityAt.toISOString(),
      isMember: r.members.length > 0,
    }));
  }

  /**
   * Deletes a business (Super Admin only): it, its stores and its chats disappear from every
   * list and become read-only history; people who only belonged to it are deactivated.
   */
  async delete(actor: Actor, businessId: string): Promise<void> {
    const existing = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { deletedAt: true, slug: true, name: true, internal: true },
    });
    if (!existing || existing.deletedAt) throw ApiError.notFound('Business');
    if (existing.internal) throw ApiError.conflict('The SMA sales team cannot be deleted.');
    await this.authz.require(actor, 'business.archive', { businessId });
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const members = await tx.businessMembership.findMany({
        where: { businessId, status: 'ACTIVE' },
        select: { userId: true },
      });
      await tx.business.update({
        where: { id: businessId },
        data: {
          status: 'ARCHIVED',
          archivedAt: now,
          deletedAt: now,
          // Frees the short name for a new business.
          slug: `deleted-${businessId.replace(/-/g, '').slice(0, 16)}`,
        },
      });
      await tx.store.updateMany({
        where: { businessId, deletedAt: null },
        data: { status: 'ARCHIVED', archivedAt: now, deletedAt: now },
      });
      await tx.conversation.updateMany({
        where: { businessId, archivedAt: null },
        data: { archivedAt: now },
      });
      await tx.businessMembership.updateMany({
        where: { businessId },
        data: { status: 'REVOKED' },
      });
      await tx.storeMembership.updateMany({ where: { businessId }, data: { status: 'REVOKED' } });
      await tx.roleAssignment.updateMany({
        where: { businessId, revokedAt: null },
        data: { revokedAt: now },
      });
      // People with no other business (and no platform role) cannot use the app any more.
      const orphans = await tx.user.findMany({
        where: {
          id: { in: members.map((m) => m.userId) },
          businessMemberships: { none: { status: 'ACTIVE' } },
          roleAssignments: { none: { scopeType: 'PLATFORM', revokedAt: null } },
        },
        select: { id: true },
      });
      if (orphans.length > 0) {
        await tx.user.updateMany({
          where: { id: { in: orphans.map((o) => o.id) } },
          data: { status: 'DEACTIVATED' },
        });
        await tx.session.updateMany({
          where: { userId: { in: orphans.map((o) => o.id) }, revokedAt: null },
          data: { revokedAt: now, revokeReason: 'business_deleted' },
        });
      }
      await this.audit.record(
        actor,
        {
          action: 'business.deleted',
          businessId,
          targetType: 'Business',
          targetId: businessId,
          metadata: { slug: existing.slug, name: existing.name, deactivatedUsers: orphans.length },
        },
        tx,
      );
    });
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
