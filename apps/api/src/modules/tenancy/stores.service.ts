import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CreateStoreRequest, StoreDto, UpdateStoreRequest } from '@storeline/shared';
import { ApiError } from '../../infra/http/api-error';
import { isUniqueViolation, PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { AuthorizationService } from '../authorization/authorization.service';
import { placeDetailsData, placeDetailsSelect, processLogo, toPlaceDetails } from './place-details';

const storeSelect = {
  id: true,
  businessId: true,
  name: true,
  code: true,
  status: true,
  timeZone: true,
  createdAt: true,
  ...placeDetailsSelect,
  _count: { select: { memberships: { where: { status: 'ACTIVE' } } } },
  roleAssignments: {
    where: {
      revokedAt: null,
      scopeType: 'STORE',
      role: { key: 'STORE_MANAGER', isSystem: true },
      user: { status: 'ACTIVE' },
    },
    select: { user: { select: { id: true, displayName: true, username: true } } },
    orderBy: { createdAt: 'asc' },
  },
} as const satisfies Prisma.StoreSelect;

type StoreRow = Prisma.StoreGetPayload<{ select: typeof storeSelect }>;

function toDto(row: StoreRow): StoreDto {
  return {
    ...toPlaceDetails(row, `/api/v1/stores/${row.id}/logo`),
    id: row.id,
    businessId: row.businessId,
    name: row.name,
    code: row.code,
    status: row.status,
    timeZone: row.timeZone,
    memberCount: row._count.memberships,
    managers: [...new Map(row.roleAssignments.map((a) => [a.user.id, a.user])).values()],
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class StoresService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  /** Stores of a business the actor can see: all of them with business-level access, else only their stores. */
  async list(actor: Actor, businessId: string, includeArchived: boolean): Promise<StoreDto[]> {
    await this.requireBusiness(businessId);
    const ctx = await this.authz.coverage(actor, 'store.read');
    const wholeBusiness = ctx.all || ctx.businessIds.has(businessId);
    const storeIds = ctx.all
      ? []
      : [...ctx.stores].filter(([, b]) => b === businessId).map(([s]) => s);
    if (!wholeBusiness && storeIds.length === 0) throw ApiError.forbidden();
    const rows = await this.prisma.store.findMany({
      where: {
        businessId,
        deletedAt: null,
        ...(wholeBusiness ? {} : { id: { in: storeIds } }),
        ...(includeArchived ? {} : { status: 'ACTIVE' }),
      },
      select: storeSelect,
      orderBy: { name: 'asc' },
      take: 1000,
    });
    return rows.map(toDto);
  }

  async get(actor: Actor, storeId: string): Promise<StoreDto> {
    const row = await this.prisma.store.findUnique({
      where: { id: storeId, deletedAt: null },
      select: storeSelect,
    });
    if (!row) throw ApiError.notFound('Store');
    await this.authz.require(actor, 'store.read', { businessId: row.businessId, storeId });
    return toDto(row);
  }

  async create(actor: Actor, businessId: string, request: CreateStoreRequest): Promise<StoreDto> {
    const business = await this.requireBusiness(businessId);
    await this.authz.require(actor, 'store.create', { businessId });
    if (business.status !== 'ACTIVE') throw ApiError.conflict('This business is not active.');
    const activeStores = await this.prisma.store.count({ where: { businessId, status: 'ACTIVE' } });
    if (business.quota && activeStores >= business.quota.maxStores) {
      throw ApiError.conflict(
        `This business has reached its limit of ${business.quota.maxStores} stores.`,
      );
    }
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.store.create({
          data: {
            businessId,
            name: request.name,
            code: request.code,
            timeZone: request.timeZone,
            ...placeDetailsData(request),
          },
          select: storeSelect,
        });
        await this.audit.record(
          actor,
          {
            action: 'store.created',
            businessId,
            storeId: created.id,
            targetType: 'Store',
            targetId: created.id,
            metadata: { code: created.code },
          },
          tx,
        );
        return created;
      });
      return toDto(row);
    } catch (error) {
      if (isUniqueViolation(error))
        throw ApiError.conflict('A store with this code already exists in the business.');
      throw error;
    }
  }

  async update(actor: Actor, storeId: string, request: UpdateStoreRequest): Promise<StoreDto> {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { businessId: true, status: true },
    });
    if (!store) throw ApiError.notFound('Store');
    await this.authz.require(actor, 'store.update', { businessId: store.businessId, storeId });
    if (store.status === 'ARCHIVED') throw ApiError.conflict('Archived stores cannot be changed.');
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.store.update({
          where: { id: storeId },
          data: {
            name: request.name,
            code: request.code,
            timeZone: request.timeZone,
            ...placeDetailsData(request),
          },
          select: storeSelect,
        });
        await this.audit.record(
          actor,
          {
            action: 'store.updated',
            businessId: store.businessId,
            storeId,
            targetType: 'Store',
            targetId: storeId,
            metadata: { fields: Object.keys(request) },
          },
          tx,
        );
        return updated;
      });
      return toDto(row);
    } catch (error) {
      if (isUniqueViolation(error))
        throw ApiError.conflict('A store with this code already exists in the business.');
      throw error;
    }
  }

  /** Replaces (or with null removes) the store logo. */
  async setLogo(actor: Actor, storeId: string, body: unknown | null): Promise<StoreDto> {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { businessId: true, status: true },
    });
    if (!store) throw ApiError.notFound('Store');
    await this.authz.require(actor, 'store.update', { businessId: store.businessId, storeId });
    if (store.status === 'ARCHIVED') throw ApiError.conflict('Archived stores cannot be changed.');
    const logo = body === null ? null : await processLogo(body);
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.store.update({
        where: { id: storeId },
        data: { logo: logo ? new Uint8Array(logo) : null, logoUpdatedAt: logo ? new Date() : null },
        select: storeSelect,
      });
      await this.audit.record(
        actor,
        {
          action: logo ? 'store.logo_updated' : 'store.logo_removed',
          businessId: store.businessId,
          storeId,
          targetType: 'Store',
          targetId: storeId,
        },
        tx,
      );
      return updated;
    });
    return toDto(row);
  }

  async logo(storeId: string): Promise<Buffer | null> {
    const row = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { logo: true },
    });
    return row?.logo ? Buffer.from(row.logo) : null;
  }

  /**
   * Deletes a store: it disappears from every list, its people leave it (their accounts stay),
   * its group chats become read-only history, and its code can be used again.
   */
  async delete(actor: Actor, storeId: string): Promise<void> {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { businessId: true, deletedAt: true, code: true },
    });
    if (!store || store.deletedAt) throw ApiError.notFound('Store');
    await this.authz.require(actor, 'store.archive', { businessId: store.businessId, storeId });
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.store.update({
        where: { id: storeId },
        data: {
          status: 'ARCHIVED',
          archivedAt: now,
          deletedAt: now,
          code: `DEL-${storeId.replace(/-/g, '').slice(0, 12)}`.toUpperCase(),
        },
      });
      await tx.conversation.updateMany({
        where: { storeId, archivedAt: null },
        data: { archivedAt: now },
      });
      await tx.storeMembership.updateMany({ where: { storeId }, data: { status: 'REVOKED' } });
      await tx.roleAssignment.updateMany({
        where: { storeId, revokedAt: null },
        data: { revokedAt: now },
      });
      await this.audit.record(
        actor,
        {
          action: 'store.deleted',
          businessId: store.businessId,
          storeId,
          targetType: 'Store',
          targetId: storeId,
          metadata: { code: store.code },
        },
        tx,
      );
    });
  }

  async archive(actor: Actor, storeId: string): Promise<StoreDto> {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { businessId: true, status: true },
    });
    if (!store) throw ApiError.notFound('Store');
    await this.authz.require(actor, 'store.archive', { businessId: store.businessId, storeId });
    if (store.status === 'ARCHIVED') throw ApiError.conflict('This store is already archived.');
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.store.update({
        where: { id: storeId },
        data: { status: 'ARCHIVED', archivedAt: new Date() },
        select: storeSelect,
      });
      // Store-scoped conversations become read-only history.
      await tx.conversation.updateMany({
        where: { storeId, archivedAt: null },
        data: { archivedAt: new Date() },
      });
      await this.audit.record(
        actor,
        {
          action: 'store.archived',
          businessId: store.businessId,
          storeId,
          targetType: 'Store',
          targetId: storeId,
        },
        tx,
      );
      return updated;
    });
    return toDto(row);
  }

  private async requireBusiness(businessId: string) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { status: true, quota: { select: { maxStores: true, maxUsers: true } } },
    });
    if (!business) throw ApiError.notFound('Business');
    return business;
  }
}
