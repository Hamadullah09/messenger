import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  OPEN_LEAD_STAGES,
  type ChangeDealStatusRequest,
  type CreateDealRequest,
  type CreateInvoiceRequest,
  type CrmCustomerDto,
  type CrmOverviewDto,
  type CrmServiceDto,
  type DealDto,
  type InvoiceDto,
  type LineItemInput,
  type ListDealsQuery,
  type ListInvoicesQuery,
  type Permission,
  type RecordPaymentRequest,
  type SetTargetRequest,
  type TargetHistoryDto,
  type TargetProgressDto,
  type TargetsDto,
  type UpdateDealRequest,
  type UpdateInvoiceRequest,
  type UpsertServiceRequest,
} from '@storeline/shared';
import { APP_CONFIG, type AppConfig } from '../../infra/config/config';
import { ApiError } from '../../infra/http/api-error';
import { MailService } from '../../infra/mail/mail.service';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { AuthorizationService } from '../authorization/authorization.service';
import { publicUserSelect, toPublicUser } from '../users/user.mapper';
import { SalesService } from './sales.service';

const num = (v: Prisma.Decimal | number | null | undefined): number => (v == null ? 0 : Number(v));
const round2 = (v: number): number => Math.round(v * 100) / 100;

/** "2026-10" → [first day of the month, first day of the next) in server time. */
function monthRange(month: string): [Date, Date] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return [new Date(y, m - 1, 1), new Date(y, m, 1)];
}
function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}
/** A DATE column value for the first of the month (stored at UTC midnight). */
function monthDate(month: string): Date {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1));
}
function dateOnly(date: Date): Date {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
}
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function lineTotals(items: LineItemInput[]) {
  const rows = items.map((item, position) => ({
    serviceId: item.serviceId ?? null,
    name: item.name,
    quantity: item.quantity,
    unitPrice: round2(item.unitPrice),
    discountPct: item.discountPct ?? 0,
    billing: item.billing ?? 'ONE_TIME',
    total: round2(item.quantity * item.unitPrice * (1 - (item.discountPct ?? 0) / 100)),
    position,
  }));
  return { rows, amount: round2(rows.reduce((sum, r) => sum + r.total, 0)) };
}

const dealInclude = {
  lead: { select: { id: true, companyName: true, stage: true } },
  business: { select: { id: true, name: true } },
  owner: { select: publicUserSelect },
  items: { orderBy: { position: 'asc' } },
  invoices: { where: { status: { not: 'VOID' } }, select: { total: true, amountPaid: true } },
} as const satisfies Prisma.DealInclude;
type DealRow = Prisma.DealGetPayload<{ include: typeof dealInclude }>;

const invoiceInclude = {
  deal: { select: { id: true, title: true, type: true, ownerId: true } },
  business: { select: { id: true, name: true } },
  lead: { select: { id: true, companyName: true } },
  items: { orderBy: { position: 'asc' } },
  payments: { orderBy: { paidAt: 'asc' }, include: { recordedBy: { select: publicUserSelect } } },
} as const satisfies Prisma.InvoiceInclude;
type InvoiceRow = Prisma.InvoiceGetPayload<{ include: typeof invoiceInclude }>;

interface Access {
  teamId: string;
  seeAll: boolean;
  billing: boolean;
  catalog: boolean;
  targets: boolean;
  assign: boolean;
}

/**
 * SMA's CRM: the services it sells, deals (new customers and upsells), invoices, payments and
 * the sales team's monthly targets. Only Sales & Marketing users (and the Super Admin) use it:
 * agents work on their own deals; managers see everything, bill and set targets.
 */
@Injectable()
export class CrmService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly sales: SalesService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  private async access(actor: Actor): Promise<Access> {
    const { businessId: teamId } = await this.sales.team();
    await this.authz.require(actor, 'sales.access', { businessId: teamId });
    const can = (p: Permission) => this.authz.can(actor, p, { businessId: teamId });
    const [seeAll, billing, catalog, targets, assign] = await Promise.all([
      can('sales.lead.read_all'),
      can('sales.billing.manage'),
      can('sales.catalog.manage'),
      can('sales.target.manage'),
      can('sales.lead.assign'),
    ]);
    return { teamId, seeAll, billing, catalog, targets, assign };
  }

  private async requireSalesUser(teamId: string, userId: string): Promise<void> {
    const ok = await this.prisma.roleAssignment.count({
      where: {
        userId,
        businessId: teamId,
        revokedAt: null,
        role: { key: { in: ['SALES_MANAGER', 'SALES_AGENT'] }, isSystem: true },
        user: { status: 'ACTIVE', deletedAt: null },
      },
    });
    if (!ok) throw ApiError.validation('Choose someone from the sales team.', 'ownerId');
  }

  get currency(): string {
    return this.config.CRM_CURRENCY;
  }

  /** Company details printed on invoices. */
  invoiceSettings() {
    const c = this.config;
    return {
      companyName: c.INVOICE_COMPANY_NAME,
      companyAddress: c.INVOICE_COMPANY_ADDRESS || null,
      companyEmail: c.INVOICE_COMPANY_EMAIL || null,
      companyPhone: c.INVOICE_COMPANY_PHONE || null,
      paymentDetails: c.INVOICE_PAYMENT_DETAILS || null,
      currency: c.CRM_CURRENCY,
      emailEnabled: this.mail.enabled,
    };
  }

  // ───────────────────────────── Services catalog ─────────────────────────────

  async listServices(actor: Actor): Promise<CrmServiceDto[]> {
    await this.access(actor);
    const [rows, sold] = await Promise.all([
      this.prisma.crmService.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }] }),
      this.prisma.dealItem.groupBy({
        by: ['serviceId'],
        where: { serviceId: { not: null }, deal: { status: 'WON', deletedAt: null } },
        _count: { _all: true },
      }),
    ]);
    const counts = new Map(sold.map((s) => [s.serviceId, s._count._all]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      category: r.category,
      price: num(r.price),
      billing: r.billing,
      active: r.active,
      timesSold: counts.get(r.id) ?? 0,
    }));
  }

  async saveService(
    actor: Actor,
    serviceId: string | null,
    request: UpsertServiceRequest,
  ): Promise<CrmServiceDto[]> {
    const access = await this.access(actor);
    if (!access.catalog) throw ApiError.forbidden('Only sales managers can change services.');
    const data = {
      name: request.name,
      description: request.description ?? null,
      category: request.category ?? null,
      price: request.price,
      billing: request.billing,
      ...(request.active !== undefined ? { active: request.active } : {}),
    };
    if (serviceId) {
      const updated = await this.prisma.crmService.updateMany({ where: { id: serviceId }, data });
      if (updated.count === 0) throw ApiError.notFound('Service');
    } else {
      await this.prisma.crmService.create({ data });
    }
    return this.listServices(actor);
  }

  // ───────────────────────────── Deals ─────────────────────────────

  private dealWhere(actor: Actor, access: Access): Prisma.DealWhereInput {
    return access.seeAll
      ? { deletedAt: null }
      : { deletedAt: null, OR: [{ ownerId: actor.userId }, { createdById: actor.userId }] };
  }

  private toDeal(row: DealRow, actor: Actor, access: Access): DealDto {
    return {
      id: row.id,
      title: row.title,
      type: row.type,
      status: row.status,
      lead: row.lead,
      customer: row.business,
      owner: row.owner ? toPublicUser(row.owner) : null,
      amount: num(row.amount),
      currency: row.currency,
      expectedCloseAt: row.expectedCloseAt?.toISOString() ?? null,
      closedAt: row.closedAt?.toISOString() ?? null,
      lostReason: row.lostReason,
      notes: row.notes,
      items: row.items.map((i) => ({
        id: i.id,
        serviceId: i.serviceId,
        name: i.name,
        quantity: i.quantity,
        unitPrice: num(i.unitPrice),
        discountPct: num(i.discountPct),
        total: num(i.total),
        billing: i.billing,
      })),
      invoiced: round2(row.invoices.reduce((s, i) => s + num(i.total), 0)),
      paid: round2(row.invoices.reduce((s, i) => s + num(i.amountPaid), 0)),
      invoiceCount: row.invoices.length,
      createdAt: row.createdAt.toISOString(),
      canEdit: access.seeAll || row.ownerId === actor.userId,
    };
  }

  async listDeals(actor: Actor, query: ListDealsQuery): Promise<DealDto[]> {
    const access = await this.access(actor);
    const q = query.q?.trim();
    const rows = await this.prisma.deal.findMany({
      where: {
        AND: [
          this.dealWhere(actor, access),
          query.status ? { status: query.status } : {},
          query.type ? { type: query.type } : {},
          query.ownerId ? { ownerId: query.ownerId === 'me' ? actor.userId : query.ownerId } : {},
          query.businessId ? { businessId: query.businessId } : {},
          query.leadId ? { leadId: query.leadId } : {},
          q
            ? {
                OR: [
                  { title: { contains: q, mode: 'insensitive' } },
                  { business: { name: { contains: q, mode: 'insensitive' } } },
                  { lead: { companyName: { contains: q, mode: 'insensitive' } } },
                ],
              }
            : {},
        ],
      },
      include: dealInclude,
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
      take: 500,
    });
    return rows.map((r) => this.toDeal(r, actor, access));
  }

  async getDeal(actor: Actor, dealId: string): Promise<DealDto> {
    const access = await this.access(actor);
    const row = await this.prisma.deal.findFirst({
      where: { AND: [{ id: dealId }, this.dealWhere(actor, access)] },
      include: dealInclude,
    });
    if (!row) throw ApiError.notFound('Deal');
    return this.toDeal(row, actor, access);
  }

  private async requireCustomer(businessId: string): Promise<{ id: string; name: string }> {
    const business = await this.prisma.business.findFirst({
      where: { id: businessId, internal: false, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!business) throw ApiError.validation('Choose an SMA customer.', 'businessId');
    return business;
  }

  async createDeal(actor: Actor, request: CreateDealRequest): Promise<DealDto> {
    const access = await this.access(actor);
    await this.authz.require(actor, 'sales.lead.manage', { businessId: access.teamId });
    let businessId = request.businessId ?? null;
    let leadId = request.leadId ?? null;
    if (leadId) {
      const lead = await this.prisma.lead.findFirst({
        where: {
          id: leadId,
          deletedAt: null,
          ...(access.seeAll ? {} : { OR: [{ ownerId: actor.userId }, { ownerId: null }] }),
        },
        select: { id: true, convertedBusinessId: true },
      });
      if (!lead) throw ApiError.validation('Lead not found.', 'leadId');
      businessId = businessId ?? lead.convertedBusinessId;
    }
    if (businessId) await this.requireCustomer(businessId);
    if (request.type !== 'NEW_BUSINESS') leadId = leadId ?? null;
    let ownerId: string | null = actor.userId;
    if (request.ownerId !== undefined && request.ownerId !== actor.userId) {
      if (!access.assign) throw ApiError.forbidden('Only sales managers can assign deals.');
      if (request.ownerId) await this.requireSalesUser(access.teamId, request.ownerId);
      ownerId = request.ownerId;
    }
    await this.requireServices(request.items);
    const { rows, amount } = lineTotals(request.items);
    const deal = await this.prisma.deal.create({
      data: {
        title: request.title,
        type: request.type,
        leadId,
        businessId,
        ownerId,
        amount,
        currency: this.currency,
        expectedCloseAt: request.expectedCloseAt ?? null,
        notes: request.notes ?? null,
        createdById: actor.userId,
        items: { create: rows },
      },
      select: { id: true },
    });
    if (leadId) {
      await this.prisma.leadActivity.create({
        data: {
          leadId,
          type: 'NOTE',
          body: `Deal created: ${request.title} (${amount.toFixed(2)} ${this.currency})`,
          actorId: actor.userId,
        },
      });
    }
    return this.getDeal(actor, deal.id);
  }

  private async requireServices(items: LineItemInput[]): Promise<void> {
    const ids = [...new Set(items.map((i) => i.serviceId).filter((v): v is string => !!v))];
    if (ids.length === 0) return;
    const found = await this.prisma.crmService.count({ where: { id: { in: ids } } });
    if (found !== ids.length) throw ApiError.validation('A chosen service was not found.', 'items');
  }

  private async editableDeal(actor: Actor, dealId: string) {
    const access = await this.access(actor);
    const deal = await this.prisma.deal.findFirst({
      where: { AND: [{ id: dealId }, this.dealWhere(actor, access)] },
      select: {
        id: true,
        status: true,
        ownerId: true,
        leadId: true,
        title: true,
        amount: true,
        type: true,
      },
    });
    if (!deal) throw ApiError.notFound('Deal');
    if (!access.seeAll && deal.ownerId !== actor.userId)
      throw ApiError.forbidden('Only the owner or a sales manager can change this deal.');
    return { deal, access };
  }

  async updateDeal(actor: Actor, dealId: string, request: UpdateDealRequest): Promise<DealDto> {
    const { deal, access } = await this.editableDeal(actor, dealId);
    if (request.ownerId !== undefined && request.ownerId !== deal.ownerId) {
      if (!access.assign) throw ApiError.forbidden('Only sales managers can assign deals.');
      if (request.ownerId) await this.requireSalesUser(access.teamId, request.ownerId);
    }
    let items: ReturnType<typeof lineTotals> | null = null;
    if (request.items) {
      if (deal.status !== 'OPEN' && !access.seeAll)
        throw ApiError.conflict('A closed deal can only be changed by a sales manager.');
      await this.requireServices(request.items);
      items = lineTotals(request.items);
    }
    await this.prisma.$transaction(async (tx) => {
      if (items) {
        await tx.dealItem.deleteMany({ where: { dealId } });
        await tx.dealItem.createMany({ data: items.rows.map((r) => ({ ...r, dealId })) });
      }
      await tx.deal.update({
        where: { id: dealId },
        data: {
          ...(request.title !== undefined ? { title: request.title } : {}),
          ...(request.ownerId !== undefined ? { ownerId: request.ownerId } : {}),
          ...(request.expectedCloseAt !== undefined
            ? { expectedCloseAt: request.expectedCloseAt }
            : {}),
          ...(request.notes !== undefined ? { notes: request.notes } : {}),
          ...(items ? { amount: items.amount } : {}),
        },
      });
    });
    return this.getDeal(actor, dealId);
  }

  /** Won deals count towards the owner's target; winning a new-business deal wins its lead. */
  async changeDealStatus(
    actor: Actor,
    dealId: string,
    request: ChangeDealStatusRequest,
  ): Promise<DealDto> {
    const { deal } = await this.editableDeal(actor, dealId);
    if (deal.status === request.status) return this.getDeal(actor, dealId);
    const closedAt = request.status === 'OPEN' ? null : (request.closedAt ?? new Date());
    if (closedAt && closedAt > new Date(Date.now() + 60_000))
      throw ApiError.validation('The closing date cannot be in the future.', 'closedAt');
    await this.prisma.$transaction(async (tx) => {
      await tx.deal.update({
        where: { id: dealId },
        data: {
          status: request.status,
          closedAt,
          lostReason: request.status === 'LOST' ? (request.lostReason ?? null) : null,
        },
      });
      if (!deal.leadId) return;
      const lead = await tx.lead.findUnique({
        where: { id: deal.leadId },
        select: { stage: true },
      });
      const leadOpen = !!lead && (OPEN_LEAD_STAGES as readonly string[]).includes(lead.stage);
      const winLead = request.status === 'WON' && deal.type === 'NEW_BUSINESS' && leadOpen;
      if (winLead) {
        await tx.lead.update({
          where: { id: deal.leadId },
          data: {
            stage: 'WON',
            closedAt,
            stageChangedAt: new Date(),
            lastActivityAt: new Date(),
          },
        });
      }
      await tx.leadActivity.create({
        data: {
          leadId: deal.leadId,
          type: winLead ? 'STAGE_CHANGED' : 'NOTE',
          ...(winLead ? { fromStage: lead!.stage, toStage: 'WON' as const } : {}),
          body:
            request.status === 'WON'
              ? `Deal won: ${deal.title} (${num(deal.amount).toFixed(2)} ${this.currency})`
              : request.status === 'LOST'
                ? `Deal lost: ${deal.title} — ${request.lostReason ?? ''}`
                : `Deal reopened: ${deal.title}`,
          actorId: actor.userId,
        },
      });
    });
    return this.getDeal(actor, dealId);
  }

  async removeDeal(actor: Actor, dealId: string): Promise<void> {
    const { deal } = await this.editableDeal(actor, dealId);
    const billed = await this.prisma.invoice.count({
      where: { dealId, status: { not: 'VOID' } },
    });
    if (billed > 0) throw ApiError.conflict('This deal has invoices. Void them first.');
    await this.prisma.deal.update({ where: { id: dealId }, data: { deletedAt: new Date() } });
    await this.audit.record(actor, {
      action: 'crm.deal_deleted',
      targetType: 'Deal',
      targetId: dealId,
      metadata: { title: deal.title },
    });
  }

  // ───────────────────────────── Invoices and payments ─────────────────────────────

  private invoiceWhere(actor: Actor, access: Access): Prisma.InvoiceWhereInput {
    return access.billing || access.seeAll ? {} : { deal: { ownerId: actor.userId } };
  }

  private toInvoice(row: InvoiceRow, access: Access): InvoiceDto {
    const total = num(row.total);
    const paid = num(row.amountPaid);
    const open = row.status === 'ISSUED' || row.status === 'PARTIALLY_PAID';
    return {
      id: row.id,
      number: row.number,
      status: row.status,
      overdue: open && isoDate(row.dueDate) < isoDate(dateOnly(new Date())),
      deal: row.deal ? { id: row.deal.id, title: row.deal.title, type: row.deal.type } : null,
      customer: row.business,
      lead: row.lead,
      billToName: row.billToName,
      billToEmail: row.billToEmail,
      billToPhone: row.billToPhone,
      billToAddress: row.billToAddress,
      issueDate: isoDate(row.issueDate),
      dueDate: isoDate(row.dueDate),
      currency: row.currency,
      subtotal: num(row.subtotal),
      discount: num(row.discount),
      taxRate: num(row.taxRate),
      taxAmount: num(row.taxAmount),
      total,
      amountPaid: paid,
      balance: row.status === 'VOID' ? 0 : round2(total - paid),
      notes: row.notes,
      items: row.items.map((i) => ({
        id: i.id,
        serviceId: i.serviceId,
        name: i.name,
        description: i.description,
        quantity: i.quantity,
        unitPrice: num(i.unitPrice),
        total: num(i.total),
      })),
      payments: row.payments.map((p) => ({
        id: p.id,
        amount: num(p.amount),
        paidAt: p.paidAt.toISOString(),
        method: p.method,
        reference: p.reference,
        notes: p.notes,
        recordedBy: p.recordedBy ? toPublicUser(p.recordedBy) : null,
        voided: p.voidedAt !== null,
      })),
      issuedAt: row.issuedAt?.toISOString() ?? null,
      paidAt: row.paidAt?.toISOString() ?? null,
      lastEmailedAt: row.lastEmailedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      canManage: access.billing,
    };
  }

  async listInvoices(actor: Actor, query: ListInvoicesQuery): Promise<InvoiceDto[]> {
    const access = await this.access(actor);
    const today = dateOnly(new Date());
    const q = query.q?.trim();
    const rows = await this.prisma.invoice.findMany({
      where: {
        AND: [
          this.invoiceWhere(actor, access),
          query.status === 'OVERDUE'
            ? { status: { in: ['ISSUED', 'PARTIALLY_PAID'] }, dueDate: { lt: today } }
            : query.status === 'UNPAID'
              ? { status: { in: ['ISSUED', 'PARTIALLY_PAID'] } }
              : query.status
                ? { status: query.status }
                : {},
          query.businessId ? { businessId: query.businessId } : {},
          query.dealId ? { dealId: query.dealId } : {},
          q
            ? {
                OR: [
                  { number: { contains: q, mode: 'insensitive' } },
                  { billToName: { contains: q, mode: 'insensitive' } },
                ],
              }
            : {},
        ],
      },
      include: invoiceInclude,
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return rows.map((r) => this.toInvoice(r, access));
  }

  async getInvoice(actor: Actor, invoiceId: string): Promise<InvoiceDto> {
    const access = await this.access(actor);
    const row = await this.prisma.invoice.findFirst({
      where: { AND: [{ id: invoiceId }, this.invoiceWhere(actor, access)] },
      include: invoiceInclude,
    });
    if (!row) throw ApiError.notFound('Invoice');
    return this.toInvoice(row, access);
  }

  private async requireBilling(actor: Actor): Promise<Access> {
    const access = await this.access(actor);
    if (!access.billing)
      throw ApiError.forbidden('Only sales managers can create invoices and record payments.');
    return access;
  }

  private async nextNumber(tx: Tx): Promise<string> {
    const rows = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT nextval('invoice_number_seq') AS n`;
    return `INV-${new Date().getFullYear()}-${String(rows[0]!.n).padStart(5, '0')}`;
  }

  /** Recomputes totals from items and payments, and the paid status. */
  private async recompute(tx: Tx, invoiceId: string): Promise<void> {
    const invoice = await tx.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      select: {
        status: true,
        discount: true,
        taxRate: true,
        paidAt: true,
        items: { select: { total: true } },
        payments: { where: { voidedAt: null }, select: { amount: true, paidAt: true } },
      },
    });
    const subtotal = round2(invoice.items.reduce((s, i) => s + num(i.total), 0));
    const discount = Math.min(num(invoice.discount), subtotal);
    const taxAmount = round2(((subtotal - discount) * num(invoice.taxRate)) / 100);
    const total = round2(subtotal - discount + taxAmount);
    const amountPaid = round2(invoice.payments.reduce((s, p) => s + num(p.amount), 0));
    let status = invoice.status;
    if (status !== 'VOID' && status !== 'DRAFT') {
      status = amountPaid <= 0 ? 'ISSUED' : amountPaid + 0.004 >= total ? 'PAID' : 'PARTIALLY_PAID';
    }
    const lastPayment = invoice.payments.reduce<Date | null>(
      (latest, p) => (!latest || p.paidAt > latest ? p.paidAt : latest),
      null,
    );
    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        subtotal,
        discount,
        taxAmount,
        total,
        amountPaid,
        status,
        paidAt: status === 'PAID' ? lastPayment : null,
      },
    });
  }

  private async billTo(
    businessId: string | null,
    leadId: string | null,
  ): Promise<{ name: string; email: string | null; phone: string | null; address: string | null }> {
    if (businessId) {
      const b = await this.prisma.business.findFirst({
        where: { id: businessId, internal: false, deletedAt: null },
        select: { name: true, email: true, phone: true, address: true },
      });
      if (!b) throw ApiError.validation('Choose an SMA customer.', 'businessId');
      const a = (b.address ?? {}) as Record<string, string | undefined>;
      const address = [a.line1, a.line2, a.city, a.region, a.postalCode, a.country]
        .filter(Boolean)
        .join(', ');
      return { name: b.name, email: b.email, phone: b.phone, address: address || null };
    }
    if (leadId) {
      const l = await this.prisma.lead.findFirst({
        where: { id: leadId, deletedAt: null },
        select: { companyName: true, email: true, phone: true, city: true, country: true },
      });
      if (!l) throw ApiError.validation('Lead not found.', 'leadId');
      return {
        name: l.companyName,
        email: l.email,
        phone: l.phone,
        address: [l.city, l.country].filter(Boolean).join(', ') || null,
      };
    }
    return { name: '', email: null, phone: null, address: null };
  }

  async createInvoice(actor: Actor, request: CreateInvoiceRequest): Promise<InvoiceDto> {
    await this.requireBilling(actor);
    let businessId = request.businessId ?? null;
    let leadId = request.leadId ?? null;
    let items: Array<{
      serviceId: string | null;
      name: string;
      description: string | null;
      quantity: number;
      unitPrice: number;
      total: number;
      position: number;
    }> = [];
    if (request.dealId) {
      const deal = await this.prisma.deal.findFirst({
        where: { id: request.dealId, deletedAt: null },
        include: { items: { orderBy: { position: 'asc' } } },
      });
      if (!deal) throw ApiError.notFound('Deal');
      if (deal.status === 'LOST') throw ApiError.conflict('This deal was lost.');
      businessId = businessId ?? deal.businessId;
      leadId = leadId ?? deal.leadId;
      items = deal.items.map((i, position) => {
        const discount = num(i.discountPct);
        return {
          serviceId: i.serviceId,
          name: i.name,
          description:
            [
              i.billing === 'MONTHLY' ? 'Monthly' : i.billing === 'YEARLY' ? 'Yearly' : null,
              discount > 0 ? `${discount}% discount` : null,
            ]
              .filter(Boolean)
              .join(' · ') || null,
          quantity: i.quantity,
          unitPrice: round2(num(i.total) / i.quantity),
          total: num(i.total),
          position,
        };
      });
    }
    if (request.items?.length) {
      await this.requireServices(
        request.items.map((i) => ({ ...i, discountPct: 0, billing: 'ONE_TIME' as const })),
      );
      items = request.items.map((i, position) => ({
        serviceId: i.serviceId ?? null,
        name: i.name,
        description: i.description ?? null,
        quantity: i.quantity,
        unitPrice: round2(i.unitPrice),
        total: round2(i.quantity * i.unitPrice),
        position,
      }));
    }
    if (items.length === 0) throw ApiError.validation('Add at least one item.', 'items');
    const party = await this.billTo(businessId, leadId);
    const name = request.billToName ?? party.name;
    if (!name) throw ApiError.validation('Who is the invoice for?', 'billToName');
    const issueDate = dateOnly(request.issueDate ?? new Date());
    const dueDate = dateOnly(
      request.dueDate ?? new Date(issueDate.getTime() + this.config.INVOICE_DUE_DAYS * 86_400_000),
    );
    if (dueDate < issueDate)
      throw ApiError.validation('The due date must be on or after the issue date.', 'dueDate');
    const id = await this.prisma.$transaction(async (tx) => {
      const invoice = await tx.invoice.create({
        data: {
          number: await this.nextNumber(tx),
          dealId: request.dealId ?? null,
          businessId,
          leadId,
          billToName: name,
          billToEmail: request.billToEmail !== undefined ? request.billToEmail : party.email,
          billToPhone: request.billToPhone !== undefined ? request.billToPhone : party.phone,
          billToAddress:
            request.billToAddress !== undefined ? request.billToAddress : party.address,
          issueDate,
          dueDate,
          currency: this.currency,
          discount: request.discount ?? 0,
          taxRate: request.taxRate ?? 0,
          notes: request.notes ?? null,
          createdById: actor.userId,
          items: { create: items },
        },
        select: { id: true },
      });
      await this.recompute(tx, invoice.id);
      return invoice.id;
    });
    return this.getInvoice(actor, id);
  }

  async updateInvoice(
    actor: Actor,
    invoiceId: string,
    request: UpdateInvoiceRequest,
  ): Promise<InvoiceDto> {
    await this.requireBilling(actor);
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { status: true, issueDate: true, dueDate: true },
    });
    if (!invoice) throw ApiError.notFound('Invoice');
    if (invoice.status !== 'DRAFT')
      throw ApiError.conflict('Only draft invoices can be changed. Void it and create a new one.');
    const issueDate = request.issueDate ? dateOnly(request.issueDate) : invoice.issueDate;
    const dueDate = request.dueDate ? dateOnly(request.dueDate) : invoice.dueDate;
    if (dueDate < issueDate)
      throw ApiError.validation('The due date must be on or after the issue date.', 'dueDate');
    await this.prisma.$transaction(async (tx) => {
      if (request.items) {
        await tx.invoiceItem.deleteMany({ where: { invoiceId } });
        await tx.invoiceItem.createMany({
          data: request.items.map((i, position) => ({
            invoiceId,
            serviceId: i.serviceId ?? null,
            name: i.name,
            description: i.description ?? null,
            quantity: i.quantity,
            unitPrice: round2(i.unitPrice),
            total: round2(i.quantity * i.unitPrice),
            position,
          })),
        });
      }
      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          ...(request.billToName !== undefined ? { billToName: request.billToName } : {}),
          ...(request.billToEmail !== undefined ? { billToEmail: request.billToEmail } : {}),
          ...(request.billToPhone !== undefined ? { billToPhone: request.billToPhone } : {}),
          ...(request.billToAddress !== undefined ? { billToAddress: request.billToAddress } : {}),
          ...(request.discount !== undefined ? { discount: request.discount } : {}),
          ...(request.taxRate !== undefined ? { taxRate: request.taxRate } : {}),
          ...(request.notes !== undefined ? { notes: request.notes } : {}),
          issueDate,
          dueDate,
        },
      });
      await this.recompute(tx, invoiceId);
    });
    return this.getInvoice(actor, invoiceId);
  }

  async issueInvoice(actor: Actor, invoiceId: string): Promise<InvoiceDto> {
    await this.requireBilling(actor);
    const updated = await this.prisma.invoice.updateMany({
      where: { id: invoiceId, status: 'DRAFT' },
      data: { status: 'ISSUED', issuedAt: new Date() },
    });
    if (updated.count === 0) throw ApiError.conflict('Only draft invoices can be issued.');
    await this.prisma.$transaction((tx) => this.recompute(tx, invoiceId));
    return this.getInvoice(actor, invoiceId);
  }

  async voidInvoice(actor: Actor, invoiceId: string, reason: string): Promise<InvoiceDto> {
    await this.requireBilling(actor);
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        status: true,
        number: true,
        _count: { select: { payments: { where: { voidedAt: null } } } },
      },
    });
    if (!invoice) throw ApiError.notFound('Invoice');
    if (invoice.status === 'VOID') return this.getInvoice(actor, invoiceId);
    if (invoice._count.payments > 0)
      throw ApiError.conflict('This invoice has payments. Remove them first.');
    await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: 'VOID', voidedAt: new Date(), voidReason: reason },
    });
    await this.audit.record(actor, {
      action: 'crm.invoice_voided',
      targetType: 'Invoice',
      targetId: invoiceId,
      metadata: { number: invoice.number },
    });
    return this.getInvoice(actor, invoiceId);
  }

  async recordPayment(
    actor: Actor,
    invoiceId: string,
    request: RecordPaymentRequest,
  ): Promise<InvoiceDto> {
    await this.requireBilling(actor);
    await this.prisma.$transaction(async (tx) => {
      // Lock the invoice row so two payments cannot overshoot the total together.
      await tx.$executeRaw`SELECT 1 FROM "Invoice" WHERE "id" = ${invoiceId}::uuid FOR UPDATE`;
      const invoice = await tx.invoice.findUnique({
        where: { id: invoiceId },
        select: { status: true, total: true, amountPaid: true, number: true },
      });
      if (!invoice) throw ApiError.notFound('Invoice');
      if (invoice.status === 'VOID') throw ApiError.conflict('This invoice was voided.');
      if (invoice.status === 'PAID') throw ApiError.conflict('This invoice is already paid.');
      const balance = round2(num(invoice.total) - num(invoice.amountPaid));
      if (request.amount > balance + 0.004)
        throw ApiError.validation(
          `That is more than the amount due (${balance.toFixed(2)}).`,
          'amount',
        );
      if (invoice.status === 'DRAFT') {
        await tx.invoice.update({
          where: { id: invoiceId },
          data: { status: 'ISSUED', issuedAt: new Date() },
        });
      }
      await tx.payment.create({
        data: {
          invoiceId,
          amount: request.amount,
          paidAt: request.paidAt ?? new Date(),
          method: request.method,
          reference: request.reference ?? null,
          notes: request.notes ?? null,
          recordedById: actor.userId,
        },
      });
      await this.recompute(tx, invoiceId);
      await this.audit.record(
        actor,
        {
          action: 'crm.payment_recorded',
          targetType: 'Invoice',
          targetId: invoiceId,
          metadata: { number: invoice.number, amount: request.amount, method: request.method },
        },
        tx,
      );
    });
    return this.getInvoice(actor, invoiceId);
  }

  async voidPayment(actor: Actor, invoiceId: string, paymentId: string): Promise<InvoiceDto> {
    await this.requireBilling(actor);
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.payment.updateMany({
        where: { id: paymentId, invoiceId, voidedAt: null },
        data: { voidedAt: new Date() },
      });
      if (updated.count === 0) throw ApiError.notFound('Payment');
      await this.recompute(tx, invoiceId);
      await this.audit.record(
        actor,
        { action: 'crm.payment_voided', targetType: 'Invoice', targetId: invoiceId },
        tx,
      );
    });
    return this.getInvoice(actor, invoiceId);
  }

  /** Sends the invoice as an HTML email to the bill-to address. */
  async emailInvoice(actor: Actor, invoiceId: string): Promise<InvoiceDto> {
    await this.requireBilling(actor);
    const invoice = await this.getInvoice(actor, invoiceId);
    if (invoice.status === 'DRAFT') throw ApiError.conflict('Issue the invoice before sending it.');
    if (invoice.status === 'VOID') throw ApiError.conflict('This invoice was voided.');
    if (!invoice.billToEmail)
      throw ApiError.validation('Add the customer’s email address first.', 'billToEmail');
    if (!this.mail.enabled)
      throw ApiError.conflict('Email is not set up yet. Add the mail server in Integrations.');
    const sent = await this.mail.send({
      to: invoice.billToEmail,
      subject: `Invoice ${invoice.number} from ${this.config.INVOICE_COMPANY_NAME}`,
      text: invoiceText(invoice, this.invoiceSettings()),
      html: invoiceHtml(invoice, this.invoiceSettings()),
    });
    if (!sent) throw ApiError.conflict('The mail server did not accept the email. Try again later.');
    await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: { lastEmailedAt: new Date() },
    });
    return this.getInvoice(actor, invoiceId);
  }

  // ───────────────────────────── Customers ─────────────────────────────

  async customers(actor: Actor): Promise<CrmCustomerDto[]> {
    await this.access(actor);
    const businesses = await this.prisma.business.findMany({
      where: { internal: false, deletedAt: null },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        createdAt: true,
        sourceLead: {
          select: { id: true, convertedAt: true, owner: { select: publicUserSelect } },
        },
        _count: { select: { stores: { where: { deletedAt: null } } } },
        deals: {
          where: { deletedAt: null },
          select: {
            status: true,
            type: true,
            amount: true,
            items: { select: { name: true } },
          },
        },
        invoices: {
          where: { status: { not: 'VOID' } },
          select: { total: true, amountPaid: true, status: true },
        },
      },
      orderBy: { name: 'asc' },
    });
    return businesses.map((b) => {
      const won = b.deals.filter((d) => d.status === 'WON');
      const invoiced = round2(
        b.invoices.filter((i) => i.status !== 'DRAFT').reduce((s, i) => s + num(i.total), 0),
      );
      const paid = round2(b.invoices.reduce((s, i) => s + num(i.amountPaid), 0));
      return {
        id: b.id,
        name: b.name,
        slug: b.slug,
        status: b.status,
        createdAt: b.createdAt.toISOString(),
        lead: b.sourceLead
          ? {
              id: b.sourceLead.id,
              owner: b.sourceLead.owner ? toPublicUser(b.sourceLead.owner) : null,
              convertedAt: b.sourceLead.convertedAt?.toISOString() ?? null,
            }
          : null,
        storeCount: b._count.stores,
        wonDeals: won.length,
        upsells: won.filter((d) => d.type === 'UPSELL').length,
        lifetimeValue: round2(won.reduce((s, d) => s + num(d.amount), 0)),
        invoiced,
        paid,
        outstanding: round2(invoiced - paid),
        openDeals: b.deals.filter((d) => d.status === 'OPEN').length,
        services: [...new Set(won.flatMap((d) => d.items.map((i) => i.name)))].slice(0, 12),
      };
    });
  }

  // ───────────────────────────── Targets ─────────────────────────────

  private async salesPeople(teamId: string) {
    const rows = await this.prisma.roleAssignment.findMany({
      where: {
        businessId: teamId,
        revokedAt: null,
        role: { key: { in: ['SALES_MANAGER', 'SALES_AGENT'] }, isSystem: true },
        user: { deletedAt: null, status: 'ACTIVE' },
      },
      select: { user: { select: publicUserSelect } },
    });
    const people = new Map(rows.map((r) => [r.user.id, toPublicUser(r.user)]));
    return [...people.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  /** Won value, counts, closed leads and collected payments per owner for a month. */
  private async achievements(start: Date, end: Date, userIds: string[]) {
    const [deals, leads, payments] = await Promise.all([
      this.prisma.deal.findMany({
        where: {
          deletedAt: null,
          status: 'WON',
          closedAt: { gte: start, lt: end },
          ownerId: { in: userIds },
        },
        select: { ownerId: true, amount: true, type: true },
      }),
      this.prisma.lead.groupBy({
        by: ['ownerId', 'stage'],
        where: {
          deletedAt: null,
          closedAt: { gte: start, lt: end },
          stage: { in: ['WON', 'LOST'] },
          ownerId: { in: userIds },
        },
        _count: { _all: true },
      }),
      this.prisma.payment.findMany({
        where: {
          voidedAt: null,
          paidAt: { gte: start, lt: end },
          invoice: { status: { not: 'VOID' }, deal: { ownerId: { in: userIds } } },
        },
        select: { amount: true, invoice: { select: { deal: { select: { ownerId: true } } } } },
      }),
    ]);
    const by = new Map<
      string,
      { achieved: number; won: number; upsells: number; closed: number; leadsWon: number; collected: number }
    >();
    const get = (id: string) => {
      let v = by.get(id);
      if (!v) {
        v = { achieved: 0, won: 0, upsells: 0, closed: 0, leadsWon: 0, collected: 0 };
        by.set(id, v);
      }
      return v;
    };
    for (const d of deals) {
      const v = get(d.ownerId!);
      v.achieved = round2(v.achieved + num(d.amount));
      v.won += 1;
      if (d.type === 'UPSELL') v.upsells += 1;
    }
    for (const l of leads) {
      const v = get(l.ownerId!);
      v.closed += l._count._all;
      if (l.stage === 'WON') v.leadsWon += l._count._all;
    }
    for (const p of payments) {
      const owner = p.invoice.deal?.ownerId;
      if (owner) get(owner).collected = round2(get(owner).collected + num(p.amount));
    }
    return by;
  }

  async targets(actor: Actor, month: string): Promise<TargetsDto> {
    const access = await this.access(actor);
    const [start, end] = monthRange(month);
    let people = await this.salesPeople(access.teamId);
    if (!access.seeAll && !access.targets) people = people.filter((p) => p.id === actor.userId);
    const ids = people.map((p) => p.id);
    const [targets, achieved] = await Promise.all([
      this.prisma.salesTarget.findMany({
        where: { userId: { in: ids }, month: monthDate(month) },
        select: { userId: true, amount: true },
      }),
      this.achievements(start, end, ids),
    ]);
    const targetBy = new Map(targets.map((t) => [t.userId, num(t.amount)]));
    const team: TargetProgressDto[] = people.map((user) => {
      const a = achieved.get(user.id);
      const target = targetBy.get(user.id) ?? null;
      const value = a?.achieved ?? 0;
      return {
        user,
        month,
        target,
        achieved: value,
        progress: target && target > 0 ? value / target : null,
        wonDeals: a?.won ?? 0,
        upsells: a?.upsells ?? 0,
        leadsClosed: a?.closed ?? 0,
        leadsWon: a?.leadsWon ?? 0,
        collected: a?.collected ?? 0,
      };
    });
    return {
      month,
      currency: this.currency,
      team,
      totals: {
        target: round2(team.reduce((s, t) => s + (t.target ?? 0), 0)),
        achieved: round2(team.reduce((s, t) => s + t.achieved, 0)),
        collected: round2(team.reduce((s, t) => s + t.collected, 0)),
      },
      canManage: access.targets,
    };
  }

  async setTarget(actor: Actor, request: SetTargetRequest): Promise<TargetsDto> {
    const access = await this.access(actor);
    if (!access.targets) throw ApiError.forbidden('Only sales managers can set targets.');
    await this.requireSalesUser(access.teamId, request.userId);
    const month = monthDate(request.month);
    await this.prisma.salesTarget.upsert({
      where: { userId_month: { userId: request.userId, month } },
      create: {
        userId: request.userId,
        month,
        amount: request.amount,
        currency: this.currency,
        setById: actor.userId,
      },
      update: { amount: request.amount, setById: actor.userId },
    });
    return this.targets(actor, request.month);
  }

  async targetHistory(actor: Actor, userId: string, months = 12): Promise<TargetHistoryDto> {
    const access = await this.access(actor);
    if (userId !== actor.userId && !access.seeAll && !access.targets) throw ApiError.forbidden();
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: publicUserSelect });
    if (!user) throw ApiError.notFound('User');
    const now = new Date();
    const keys = Array.from({ length: months }, (_, i) =>
      monthKey(new Date(now.getFullYear(), now.getMonth() - (months - 1 - i), 1)),
    );
    const [first] = monthRange(keys[0]!);
    const [, last] = monthRange(keys[keys.length - 1]!);
    const [targets, deals, leads] = await Promise.all([
      this.prisma.salesTarget.findMany({
        where: { userId, month: { gte: monthDate(keys[0]!), lte: monthDate(keys.at(-1)!) } },
        select: { month: true, amount: true },
      }),
      this.prisma.deal.findMany({
        where: { ownerId: userId, status: 'WON', deletedAt: null, closedAt: { gte: first, lt: last } },
        select: { amount: true, closedAt: true },
      }),
      this.prisma.lead.findMany({
        where: { ownerId: userId, stage: 'WON', deletedAt: null, closedAt: { gte: first, lt: last } },
        select: { closedAt: true },
      }),
    ]);
    const targetBy = new Map(
      targets.map((t) => [t.month.toISOString().slice(0, 7), num(t.amount)]),
    );
    return {
      user: toPublicUser(user),
      currency: this.currency,
      months: keys.map((key) => ({
        month: key,
        target: targetBy.get(key) ?? null,
        achieved: round2(
          deals
            .filter((d) => d.closedAt && monthKey(d.closedAt) === key)
            .reduce((s, d) => s + num(d.amount), 0),
        ),
        leadsWon: leads.filter((l) => l.closedAt && monthKey(l.closedAt) === key).length,
      })),
    };
  }

  // ───────────────────────────── Overview ─────────────────────────────

  async overview(actor: Actor): Promise<CrmOverviewDto> {
    const access = await this.access(actor);
    const dealScope = this.dealWhere(actor, access);
    const invoiceScope = this.invoiceWhere(actor, access);
    const now = new Date();
    const month = monthKey(now);
    const [start, end] = monthRange(month);
    const trendStart = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const today = dateOnly(now);
    const [won, open, invoices, payments, items] = await Promise.all([
      this.prisma.deal.findMany({
        where: { AND: [dealScope, { status: 'WON', closedAt: { gte: trendStart, lt: end } }] },
        select: { amount: true, closedAt: true, type: true },
      }),
      this.prisma.deal.aggregate({
        where: { AND: [dealScope, { status: 'OPEN' }] },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.invoice.findMany({
        where: { AND: [invoiceScope, { status: { in: ['ISSUED', 'PARTIALLY_PAID', 'PAID'] } }] },
        select: { total: true, amountPaid: true, status: true, dueDate: true, issueDate: true },
      }),
      this.prisma.payment.findMany({
        where: {
          voidedAt: null,
          paidAt: { gte: trendStart, lt: end },
          invoice: { AND: [invoiceScope, { status: { not: 'VOID' } }] },
        },
        select: { amount: true, paidAt: true },
      }),
      this.prisma.dealItem.findMany({
        where: { deal: { AND: [dealScope, { status: 'WON' }] } },
        select: { name: true, total: true },
      }),
    ]);
    const thisMonth = won.filter((d) => d.closedAt && d.closedAt >= start);
    const unpaid = invoices.filter((i) => i.status !== 'PAID');
    const overdue = unpaid.filter((i) => i.dueDate < today);
    const services = new Map<string, { name: string; count: number; value: number }>();
    for (const i of items) {
      const s = services.get(i.name) ?? { name: i.name, count: 0, value: 0 };
      s.count += 1;
      s.value = round2(s.value + num(i.total));
      services.set(i.name, s);
    }
    const trend = Array.from({ length: 6 }, (_, i) => {
      const key = monthKey(new Date(now.getFullYear(), now.getMonth() - 5 + i, 1));
      return {
        month: key,
        won: round2(
          won
            .filter((d) => d.closedAt && monthKey(d.closedAt) === key)
            .reduce((s, d) => s + num(d.amount), 0),
        ),
        collected: round2(
          payments.filter((p) => monthKey(p.paidAt) === key).reduce((s, p) => s + num(p.amount), 0),
        ),
      };
    });
    return {
      currency: this.currency,
      month,
      wonThisMonth: round2(thisMonth.reduce((s, d) => s + num(d.amount), 0)),
      wonCountThisMonth: thisMonth.length,
      upsellThisMonth: round2(
        thisMonth.filter((d) => d.type === 'UPSELL').reduce((s, d) => s + num(d.amount), 0),
      ),
      openPipeline: num(open._sum.amount),
      openDeals: open._count._all,
      invoicedThisMonth: round2(
        invoices
          .filter((i) => i.issueDate >= dateOnly(start) && i.issueDate < dateOnly(end))
          .reduce((s, i) => s + num(i.total), 0),
      ),
      collectedThisMonth: trend.at(-1)!.collected,
      outstanding: round2(unpaid.reduce((s, i) => s + num(i.total) - num(i.amountPaid), 0)),
      overdue: round2(overdue.reduce((s, i) => s + num(i.total) - num(i.amountPaid), 0)),
      overdueCount: overdue.length,
      trend,
      topServices: [...services.values()].sort((a, b) => b.value - a.value).slice(0, 6),
      canManageBilling: access.billing,
      canManageCatalog: access.catalog,
      canManageTargets: access.targets,
    };
  }
}

// ───────────────────────────── Invoice email ─────────────────────────────

type InvoiceSettings = ReturnType<CrmService['invoiceSettings']>;

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function money(value: number, currency: string): string {
  return `${currency} ${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function invoiceText(i: InvoiceDto, s: InvoiceSettings): string {
  return [
    `Invoice ${i.number} from ${s.companyName}`,
    `Issued ${i.issueDate}, due ${i.dueDate}`,
    '',
    ...i.items.map((it) => `${it.name} × ${it.quantity}: ${money(it.total, i.currency)}`),
    '',
    `Total: ${money(i.total, i.currency)}`,
    `Paid: ${money(i.amountPaid, i.currency)}`,
    `Balance due: ${money(i.balance, i.currency)}`,
    ...(s.paymentDetails ? ['', 'How to pay:', s.paymentDetails] : []),
  ].join('\n');
}

function invoiceHtml(i: InvoiceDto, s: InvoiceSettings): string {
  const rows = i.items
    .map(
      (it) =>
        `<tr><td style="padding:8px;border-bottom:1px solid #eee">${esc(it.name)}${
          it.description ? `<br><small style="color:#666">${esc(it.description)}</small>` : ''
        }</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${it.quantity}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${money(it.unitPrice, i.currency)}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${money(it.total, i.currency)}</td></tr>`,
    )
    .join('');
  return `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#111">
<h2 style="color:#ea580c;margin:0">${esc(s.companyName)}</h2>
<p style="color:#666;margin:4px 0 16px">${[s.companyAddress, s.companyEmail, s.companyPhone].filter(Boolean).map((v) => esc(v!)).join(' · ')}</p>
<h3 style="margin:0">Invoice ${esc(i.number)}</h3>
<p style="margin:4px 0">Bill to: <b>${esc(i.billToName)}</b><br>Issued ${i.issueDate} · Due ${i.dueDate}</p>
<table style="width:100%;border-collapse:collapse;margin-top:12px"><thead><tr style="background:#fff7ed"><th style="padding:8px;text-align:left">Item</th><th style="padding:8px;text-align:right">Qty</th><th style="padding:8px;text-align:right">Price</th><th style="padding:8px;text-align:right">Amount</th></tr></thead><tbody>${rows}</tbody></table>
<p style="text-align:right;margin-top:12px">Subtotal ${money(i.subtotal, i.currency)}${i.discount ? `<br>Discount −${money(i.discount, i.currency)}` : ''}${i.taxAmount ? `<br>Tax (${i.taxRate}%) ${money(i.taxAmount, i.currency)}` : ''}<br><b style="font-size:18px">Total ${money(i.total, i.currency)}</b><br>Paid ${money(i.amountPaid, i.currency)}<br><b>Balance due ${money(i.balance, i.currency)}</b></p>
${s.paymentDetails ? `<p style="background:#f5f5f5;padding:12px;border-radius:8px;white-space:pre-line"><b>How to pay</b><br>${esc(s.paymentDetails)}</p>` : ''}
${i.notes ? `<p style="white-space:pre-line">${esc(i.notes)}</p>` : ''}
</div>`;
}
