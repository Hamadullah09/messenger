import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  CreateStoreCustomerRequest,
  ListStoreCustomersQuery,
  StoreCustomerDto,
  StoreCustomerSummaryDto,
  UpdateStoreCustomerRequest,
} from '@storeline/shared';
import { ApiError } from '../../infra/http/api-error';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { AuthorizationService } from '../authorization/authorization.service';
import { csvCell } from '../sales/sales.service';

const include = {
  store: { select: { id: true, name: true } },
  createdBy: { select: { displayName: true } },
} as const satisfies Prisma.StoreCustomerInclude;

type Row = Prisma.StoreCustomerGetPayload<{ include: typeof include }>;

function toDto(row: Row): StoreCustomerDto {
  return {
    id: row.id,
    businessId: row.businessId,
    store: row.store,
    name: row.name,
    phone: row.phone,
    email: row.email,
    city: row.city,
    notes: row.notes,
    tags: row.tags,
    marketingOptIn: row.marketingOptIn,
    optInAt: row.optInAt?.toISOString() ?? null,
    addedBy: row.createdBy?.displayName ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Store customers: a business's own customers (not SMA's customers), with marketing consent,
 * so the business can run campaigns to them later. Business-wide roles see all of them;
 * store managers see and add those of their stores.
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  /** Rows the actor may see in this business, or 403. */
  private async scope(
    actor: Actor,
    businessId: string,
    permission: 'customer.read' | 'customer.manage',
  ): Promise<{ where: Prisma.StoreCustomerWhereInput; storeIds: string[] | null }> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { deletedAt: true, internal: true },
    });
    if (!business || business.deletedAt || business.internal) throw ApiError.notFound('Business');
    const coverage = await this.authz.coverage(actor, permission);
    if (coverage.all || coverage.businessIds.has(businessId))
      return { where: { businessId, deletedAt: null }, storeIds: null };
    const storeIds = [...coverage.stores].filter(([, b]) => b === businessId).map(([id]) => id);
    if (storeIds.length === 0) throw ApiError.forbidden();
    return { where: { businessId, deletedAt: null, storeId: { in: storeIds } }, storeIds };
  }

  private async requireStore(
    businessId: string,
    storeId: string | null | undefined,
    allowed: string[] | null,
  ) {
    if (!storeId) {
      if (allowed) throw ApiError.validation('Choose the store this customer shops at.', 'storeId');
      return;
    }
    if (allowed && !allowed.includes(storeId)) throw ApiError.forbidden();
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, businessId, deletedAt: null },
      select: { id: true },
    });
    if (!store) throw ApiError.validation('Store not found in this business.', 'storeId');
  }

  async list(
    actor: Actor,
    businessId: string,
    query: ListStoreCustomersQuery,
  ): Promise<{ items: StoreCustomerDto[]; summary: StoreCustomerSummaryDto }> {
    const { where } = await this.scope(actor, businessId, 'customer.read');
    const q = query.q?.trim();
    const filtered: Prisma.StoreCustomerWhereInput = {
      AND: [
        where,
        query.storeId ? { storeId: query.storeId } : {},
        query.optIn !== undefined ? { marketingOptIn: query.optIn } : {},
        q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { phone: { contains: q } },
                { email: { contains: q, mode: 'insensitive' } },
                { city: { contains: q, mode: 'insensitive' } },
                { tags: { has: q.toLowerCase() } },
              ],
            }
          : {},
      ],
    };
    const [rows, total, optedIn] = await Promise.all([
      this.prisma.storeCustomer.findMany({
        where: filtered,
        include,
        orderBy: { createdAt: 'desc' },
        take: query.limit,
      }),
      this.prisma.storeCustomer.count({ where }),
      this.prisma.storeCustomer.count({ where: { AND: [where, { marketingOptIn: true }] } }),
    ]);
    return { items: rows.map(toDto), summary: { total, optedIn } };
  }

  async create(
    actor: Actor,
    businessId: string,
    request: CreateStoreCustomerRequest,
  ): Promise<StoreCustomerDto> {
    const { storeIds } = await this.scope(actor, businessId, 'customer.manage');
    await this.requireStore(businessId, request.storeId, storeIds);
    const row = await this.prisma.storeCustomer.create({
      data: {
        businessId,
        storeId: request.storeId ?? null,
        name: request.name,
        phone: request.phone ?? null,
        email: request.email ?? null,
        city: request.city ?? null,
        notes: request.notes ?? null,
        tags: request.tags.map((t) => t.toLowerCase()),
        marketingOptIn: request.marketingOptIn,
        optInAt: request.marketingOptIn ? new Date() : null,
        createdById: actor.userId,
      },
      include,
    });
    return toDto(row);
  }

  private async requireRow(actor: Actor, customerId: string) {
    const existing = await this.prisma.storeCustomer.findUnique({
      where: { id: customerId },
      select: { businessId: true, deletedAt: true, marketingOptIn: true },
    });
    if (!existing || existing.deletedAt) throw ApiError.notFound('Customer');
    const scope = await this.scope(actor, existing.businessId, 'customer.manage');
    const visible = await this.prisma.storeCustomer.count({
      where: { AND: [scope.where, { id: customerId }] },
    });
    if (!visible) throw ApiError.notFound('Customer');
    return { ...existing, storeIds: scope.storeIds };
  }

  async update(
    actor: Actor,
    customerId: string,
    request: UpdateStoreCustomerRequest,
  ): Promise<StoreCustomerDto> {
    const existing = await this.requireRow(actor, customerId);
    if (request.storeId !== undefined)
      await this.requireStore(existing.businessId, request.storeId, existing.storeIds);
    const optInChanged =
      request.marketingOptIn !== undefined && request.marketingOptIn !== existing.marketingOptIn;
    const row = await this.prisma.storeCustomer.update({
      where: { id: customerId },
      data: {
        ...request,
        ...(request.tags ? { tags: request.tags.map((t) => t.toLowerCase()) } : {}),
        ...(optInChanged ? { optInAt: request.marketingOptIn ? new Date() : null } : {}),
      },
      include,
    });
    return toDto(row);
  }

  async remove(actor: Actor, customerId: string): Promise<void> {
    await this.requireRow(actor, customerId);
    // Customer data is erased, not just hidden: only the row's existence remains.
    await this.prisma.storeCustomer.update({
      where: { id: customerId },
      data: {
        deletedAt: new Date(),
        name: 'Deleted customer',
        phone: null,
        email: null,
        city: null,
        notes: null,
        tags: [],
        marketingOptIn: false,
      },
    });
  }

  /** Customers who agreed to marketing, as CSV for a campaign tool. Every export is audited. */
  async exportCsv(actor: Actor, businessId: string): Promise<string> {
    const { where } = await this.scope(actor, businessId, 'customer.manage');
    const rows = await this.prisma.storeCustomer.findMany({
      where: { AND: [where, { marketingOptIn: true }] },
      include,
      orderBy: { createdAt: 'asc' },
      take: 100_000,
    });
    await this.audit.record(actor, {
      action: 'customers.exported',
      businessId,
      metadata: { count: rows.length, optedInOnly: true },
    });
    const header = ['Name', 'Phone', 'Email', 'City', 'Store', 'Tags', 'Opted in', 'Added'];
    const lines = rows.map((r) =>
      [
        r.name,
        r.phone,
        r.email,
        r.city,
        r.store?.name,
        r.tags.join(' '),
        r.optInAt?.toISOString(),
        r.createdAt.toISOString(),
      ]
        .map(csvCell)
        .join(','),
    );
    return [header.map(csvCell).join(','), ...lines].join('\r\n');
  }
}
