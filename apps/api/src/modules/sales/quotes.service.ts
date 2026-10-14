import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  type CrmCustomerRef,
  type CreateQuoteRequest,
  type PublicQuoteDto,
  type QuoteDto,
  type RespondToQuoteRequest,
} from '@storeline/shared';
import { APP_CONFIG, type AppConfig } from '../../infra/config/config';
import { ApiError } from '../../infra/http/api-error';
import { MailService } from '../../infra/mail/mail.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RateLimiterService } from '../../infra/redis/rate-limiter.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { AuthorizationService } from '../authorization/authorization.service';
import {
  type CrmSettings,
  CrmSettingsService,
  dateOnly,
  documentHtml,
  documentText,
  InvoiceFactory,
  isoDate,
  newPublicToken,
  num,
  round2,
  today,
} from './crm-core';
import { SalesService } from './sales.service';

const quoteInclude = {
  deal: { select: { id: true, title: true } },
  business: { select: { id: true, name: true } },
  lead: { select: { id: true, companyName: true } },
  items: { orderBy: { position: 'asc' } },
} as const satisfies Prisma.QuoteInclude;
type QuoteRow = Prisma.QuoteGetPayload<{ include: typeof quoteInclude }>;

const PUBLIC_LIMIT = { name: 'public:quote', limit: 30, windowSeconds: 3600 } as const;

interface QuoteAccess {
  tenantId: string;
  platform: boolean;
  settings: CrmSettings;
  billing: boolean;
  seeAll: boolean;
}

/**
 * Quotations: a priced offer sent before the sale. The customer opens a link, then accepts or
 * declines; accepting marks the deal won and issues the invoice.
 */
@Injectable()
export class QuotesService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly sales: SalesService,
    private readonly settings: CrmSettingsService,
    private readonly factory: InvoiceFactory,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  private async access(actor: Actor): Promise<QuoteAccess> {
    const tenant = await this.sales.tenant(actor);
    const businessId = tenant.businessId;
    await this.authz.require(actor, 'sales.access', { businessId });
    const [billing, seeAll, settings] = await Promise.all([
      this.authz.can(actor, 'sales.billing.manage', { businessId }),
      this.authz.can(actor, 'sales.lead.read_all', { businessId }),
      this.settings.load(businessId),
    ]);
    return { tenantId: businessId, platform: tenant.platform, settings, billing, seeAll };
  }

  private toDto(row: QuoteRow, a: QuoteAccess, canManage: boolean): QuoteDto {
    const customer: CrmCustomerRef | null = row.business
      ? { ...row.business, kind: 'BUSINESS' }
      : !a.platform && row.lead
        ? { id: row.lead.id, name: row.lead.companyName, kind: 'LEAD' }
        : null;
    return {
      id: row.id,
      number: row.number,
      status: row.status,
      deal: row.deal,
      customer,
      lead: row.lead,
      billToName: row.billToName,
      billToEmail: row.billToEmail,
      billToPhone: row.billToPhone,
      billToAddress: row.billToAddress,
      issueDate: isoDate(row.issueDate),
      validUntil: isoDate(row.validUntil),
      currency: row.currency,
      subtotal: num(row.subtotal),
      discount: num(row.discount),
      taxRate: num(row.taxRate),
      taxAmount: num(row.taxAmount),
      total: num(row.total),
      notes: row.notes,
      terms: row.terms,
      items: row.items.map((i) => ({
        id: i.id,
        name: i.name,
        description: i.description,
        quantity: i.quantity,
        unitPrice: num(i.unitPrice),
        total: num(i.total),
        billing: i.billing,
      })),
      publicUrl: `/quote/${row.publicToken}`,
      sentAt: row.sentAt?.toISOString() ?? null,
      viewedAt: row.viewedAt?.toISOString() ?? null,
      respondedAt: row.respondedAt?.toISOString() ?? null,
      responseName: row.responseName,
      responseNote: row.responseNote,
      invoiceId: row.invoiceId,
      createdAt: row.createdAt.toISOString(),
      canManage,
    };
  }

  /** Sales managers see all quotes; agents see quotes of their own deals. */
  private visibleWhere(actor: Actor, a: QuoteAccess): Prisma.QuoteWhereInput {
    return a.billing || a.seeAll
      ? { tenantId: a.tenantId }
      : {
          tenantId: a.tenantId,
          OR: [{ createdById: actor.userId }, { deal: { ownerId: actor.userId } }],
        };
  }

  async list(actor: Actor, query: { status?: string; dealId?: string }): Promise<QuoteDto[]> {
    const a = await this.access(actor);
    await this.expireOld();
    const rows = await this.prisma.quote.findMany({
      where: {
        AND: [
          this.visibleWhere(actor, a),
          query.status ? { status: query.status as QuoteRow['status'] } : {},
          query.dealId ? { dealId: query.dealId } : {},
        ],
      },
      include: quoteInclude,
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    return rows.map((r) => this.toDto(r, a, a.billing || r.createdById === actor.userId));
  }

  async get(actor: Actor, quoteId: string): Promise<QuoteDto> {
    const a = await this.access(actor);
    const row = await this.prisma.quote.findFirst({
      where: { AND: [{ id: quoteId }, this.visibleWhere(actor, a)] },
      include: quoteInclude,
    });
    if (!row) throw ApiError.notFound('Quote');
    return this.toDto(row, a, a.billing || row.createdById === actor.userId);
  }

  private async billTo(a: QuoteAccess, businessId: string | null, leadId: string | null) {
    if (businessId) {
      if (!a.platform)
        throw ApiError.validation('Choose the customer from your leads.', 'businessId');
      const b = await this.prisma.business.findFirst({
        where: { id: businessId, internal: false, deletedAt: null },
        select: { name: true, email: true, phone: true, address: true },
      });
      if (!b) throw ApiError.validation('Choose an SMA customer.', 'businessId');
      const addr = (b.address ?? {}) as Record<string, string | undefined>;
      const address = [addr.line1, addr.line2, addr.city, addr.region, addr.country]
        .filter(Boolean)
        .join(', ');
      return { name: b.name, email: b.email, phone: b.phone, address: address || null };
    }
    if (leadId) {
      const l = await this.prisma.lead.findFirst({
        where: { id: leadId, tenantId: a.tenantId, deletedAt: null },
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

  async create(actor: Actor, request: CreateQuoteRequest): Promise<QuoteDto> {
    const a = await this.access(actor);
    const settings = a.settings;
    let businessId = request.businessId ?? null;
    let leadId = request.leadId ?? null;
    let currency: string = request.currency ?? settings.defaultCurrency;
    let items: Array<{
      serviceId: string | null;
      name: string;
      description: string | null;
      quantity: number;
      unitPrice: number;
      total: number;
      billing: 'ONE_TIME' | 'MONTHLY' | 'YEARLY';
      position: number;
    }> = [];
    if (request.dealId) {
      const deal = await this.prisma.deal.findFirst({
        where: { id: request.dealId, tenantId: a.tenantId, deletedAt: null },
        include: { items: { orderBy: { position: 'asc' } } },
      });
      if (!deal) throw ApiError.notFound('Deal');
      if (!a.billing && !a.seeAll && deal.ownerId !== actor.userId)
        throw ApiError.forbidden('You can only quote your own deals.');
      if (deal.status === 'LOST') throw ApiError.conflict('This deal was lost.');
      businessId = businessId ?? deal.businessId;
      leadId = leadId ?? deal.leadId;
      currency = deal.currency;
      items = deal.items.map((i, position) => {
        const discount = num(i.discountPct);
        return {
          serviceId: i.serviceId,
          name: i.name,
          description: discount > 0 ? `${discount}% discount` : null,
          quantity: i.quantity,
          unitPrice: round2(num(i.total) / i.quantity),
          total: num(i.total),
          billing: i.billing,
          position,
        };
      });
    } else if (!a.billing) {
      throw ApiError.forbidden('Create quotes from a deal, or ask a sales manager.');
    }
    if (request.items?.length) {
      items = request.items.map((i, position) => ({
        serviceId: i.serviceId ?? null,
        name: i.name,
        description: i.description ?? null,
        quantity: i.quantity,
        unitPrice: round2(i.unitPrice),
        total: round2(i.quantity * i.unitPrice),
        billing: i.billing ?? 'ONE_TIME',
        position,
      }));
    }
    if (items.length === 0) throw ApiError.validation('Add at least one item.', 'items');
    if (items.some((i) => i.serviceId)) {
      const ids = [...new Set(items.map((i) => i.serviceId).filter((v): v is string => !!v))];
      const found = await this.prisma.crmService.count({
        where: { id: { in: ids }, tenantId: a.tenantId },
      });
      if (found !== ids.length)
        throw ApiError.validation('A chosen service was not found.', 'items');
    }
    const party = await this.billTo(a, businessId, leadId);
    const name = request.billToName ?? party.name;
    if (!name) throw ApiError.validation('Who is the quote for?', 'billToName');
    const issueDate = today();
    const validUntil = dateOnly(request.validUntil ?? new Date(Date.now() + 14 * 86_400_000));
    if (validUntil < issueDate)
      throw ApiError.validation('The quote must be valid until today or later.', 'validUntil');
    const id = await this.prisma.$transaction(async (tx) => {
      const quote = await tx.quote.create({
        data: {
          tenantId: a.tenantId,
          number: await this.factory.nextQuoteNumber(tx, a.tenantId),
          dealId: request.dealId ?? null,
          businessId,
          leadId,
          billToName: name,
          billToEmail: request.billToEmail !== undefined ? request.billToEmail : party.email,
          billToPhone: request.billToPhone !== undefined ? request.billToPhone : party.phone,
          billToAddress:
            request.billToAddress !== undefined ? request.billToAddress : party.address,
          issueDate,
          validUntil,
          currency,
          discount: request.discount ?? 0,
          taxRate: request.taxRate ?? settings.taxRate,
          notes: request.notes ?? null,
          terms: request.terms ?? null,
          publicToken: newPublicToken(),
          createdById: actor.userId,
          items: { create: items },
        },
        select: { id: true },
      });
      await this.factory.recomputeQuote(tx, quote.id);
      return quote.id;
    });
    return this.get(actor, id);
  }

  /** Marks it sent and emails the link when email works (otherwise share the link yourself). */
  async send(
    actor: Actor,
    quoteId: string,
    email: boolean,
  ): Promise<QuoteDto & { emailed: boolean }> {
    const quote = await this.get(actor, quoteId);
    if (!quote.canManage) throw ApiError.forbidden();
    if (quote.status === 'ACCEPTED' || quote.status === 'DECLINED')
      throw ApiError.conflict('The customer already answered this quote.');
    let emailed = false;
    if (email) {
      if (!quote.billToEmail)
        throw ApiError.validation('Add the customer’s email address first.', 'billToEmail');
      if (!this.mail.enabled)
        throw ApiError.conflict('Email is not set up yet. Add the mail server in Integrations.');
      const settings = (await this.access(actor)).settings;
      const doc = {
        kind: 'Quotation' as const,
        number: quote.number,
        billToName: quote.billToName,
        issueDate: quote.issueDate,
        dueLabel: 'Valid until',
        dueDate: quote.validUntil,
        currency: quote.currency,
        items: quote.items,
        subtotal: quote.subtotal,
        discount: quote.discount,
        taxRate: quote.taxRate,
        taxAmount: quote.taxAmount,
        total: quote.total,
        notes: quote.notes,
        actionUrl: this.settings.link(quote.publicUrl),
        actionLabel: 'View and accept the quote',
      };
      emailed = await this.mail.send({
        to: quote.billToEmail,
        subject: `Quotation ${quote.number} from ${settings.companyName}`,
        text: documentText(doc, settings),
        html: documentHtml(doc, settings),
      });
      if (!emailed)
        throw ApiError.conflict('The mail server did not accept the email. Try again later.');
    }
    await this.prisma.quote.update({
      where: { id: quoteId },
      data: { status: 'SENT', sentAt: new Date() },
    });
    return { ...(await this.get(actor, quoteId)), emailed };
  }

  async remove(actor: Actor, quoteId: string): Promise<void> {
    const quote = await this.get(actor, quoteId);
    if (!quote.canManage) throw ApiError.forbidden();
    if (quote.status === 'ACCEPTED')
      throw ApiError.conflict('An accepted quote cannot be deleted.');
    await this.prisma.quote.delete({ where: { id: quoteId } });
  }

  /** Sent quotes past their date become EXPIRED (every business's). */
  async expireOld(): Promise<number> {
    const result = await this.prisma.quote.updateMany({
      where: { status: { in: ['DRAFT', 'SENT'] }, validUntil: { lt: today() } },
      data: { status: 'EXPIRED' },
    });
    return result.count;
  }

  // ───────────────────────────── Customer side (public link) ─────────────────────────────

  private async byToken(token: string) {
    const row = await this.prisma.quote.findUnique({
      where: { publicToken: token },
      include: { items: { orderBy: { position: 'asc' } }, invoice: { select: { payToken: true } } },
    });
    if (!row || row.status === 'DRAFT') throw ApiError.notFound('Quote');
    return row;
  }

  private async publicDto(
    row: Awaited<ReturnType<QuotesService['byToken']>>,
  ): Promise<PublicQuoteDto> {
    const s = await this.settings.load(row.tenantId);
    return {
      number: row.number,
      status: row.status,
      company: {
        name: s.companyName,
        address: s.companyAddress,
        email: s.companyEmail,
        phone: s.companyPhone,
        taxNumber: s.taxNumber,
        taxName: s.taxName,
      },
      billToName: row.billToName,
      issueDate: isoDate(row.issueDate),
      validUntil: isoDate(row.validUntil),
      currency: row.currency,
      items: row.items.map((i) => ({
        name: i.name,
        description: i.description,
        quantity: i.quantity,
        unitPrice: num(i.unitPrice),
        total: num(i.total),
        billing: i.billing,
      })),
      subtotal: num(row.subtotal),
      discount: num(row.discount),
      taxRate: num(row.taxRate),
      taxAmount: num(row.taxAmount),
      total: num(row.total),
      notes: row.notes,
      terms: row.terms,
      respondedAt: row.respondedAt?.toISOString() ?? null,
      payUrl: row.invoice?.payToken ? `/pay/${row.invoice.payToken}` : null,
    };
  }

  async publicView(token: string, ipHash: string): Promise<PublicQuoteDto> {
    await this.rateLimiter.consume(PUBLIC_LIMIT, ipHash);
    await this.expireOld();
    const row = await this.byToken(token);
    if (!row.viewedAt)
      await this.prisma.quote.update({ where: { id: row.id }, data: { viewedAt: new Date() } });
    return this.publicDto(row);
  }

  async respond(
    token: string,
    request: RespondToQuoteRequest,
    ipHash: string,
  ): Promise<PublicQuoteDto> {
    await this.rateLimiter.consume(PUBLIC_LIMIT, ipHash);
    await this.expireOld();
    const quote = await this.byToken(token);
    if (quote.status === 'EXPIRED')
      throw ApiError.conflict('This quote has expired. Please ask for a new one.');
    if (quote.status !== 'SENT') throw ApiError.conflict('This quote was already answered.');
    await this.prisma.$transaction(async (tx) => {
      // Only one answer, even if the button is pressed twice.
      const claimed = await tx.quote.updateMany({
        where: { id: quote.id, status: 'SENT' },
        data: {
          status: request.accept ? 'ACCEPTED' : 'DECLINED',
          respondedAt: new Date(),
          responseName: request.name,
          responseNote: request.note ?? null,
        },
      });
      if (claimed.count === 0) throw ApiError.conflict('This quote was already answered.');
      if (!request.accept) return;
      if (quote.dealId) {
        const deal = await tx.deal.findFirst({
          where: { id: quote.dealId, tenantId: quote.tenantId },
          select: { status: true, leadId: true, type: true, title: true },
        });
        if (deal && deal.status === 'OPEN') {
          await tx.deal.update({
            where: { id: quote.dealId },
            data: { status: 'WON', closedAt: new Date() },
          });
          if (deal.leadId) {
            const lead = await tx.lead.findUnique({
              where: { id: deal.leadId },
              select: { stage: true },
            });
            const open = lead && !['WON', 'LOST'].includes(lead.stage);
            if (open && deal.type === 'NEW_BUSINESS')
              await tx.lead.update({
                where: { id: deal.leadId },
                data: {
                  stage: 'WON',
                  closedAt: new Date(),
                  stageChangedAt: new Date(),
                  lastActivityAt: new Date(),
                },
              });
            await tx.leadActivity.create({
              data: {
                leadId: deal.leadId,
                type: open && deal.type === 'NEW_BUSINESS' ? 'STAGE_CHANGED' : 'NOTE',
                ...(open && deal.type === 'NEW_BUSINESS'
                  ? { fromStage: lead!.stage, toStage: 'WON' as const }
                  : {}),
                body: `Quote ${quote.number} accepted by ${request.name} — deal won`,
              },
            });
          }
        }
      }
      const issue = today();
      const invoice = await tx.invoice.create({
        data: {
          tenantId: quote.tenantId,
          number: await this.factory.nextInvoiceNumber(tx, quote.tenantId),
          dealId: quote.dealId,
          businessId: quote.businessId,
          leadId: quote.leadId,
          billToName: quote.billToName,
          billToEmail: quote.billToEmail,
          billToPhone: quote.billToPhone,
          billToAddress: quote.billToAddress,
          issueDate: issue,
          dueDate: dateOnly(new Date(Date.now() + this.config.INVOICE_DUE_DAYS * 86_400_000)),
          currency: quote.currency,
          discount: quote.discount,
          taxRate: quote.taxRate,
          notes: `From quotation ${quote.number}${quote.notes ? `\n${quote.notes}` : ''}`,
          status: 'ISSUED',
          issuedAt: new Date(),
          payToken: newPublicToken(),
          items: {
            create: quote.items.map((i) => ({
              serviceId: i.serviceId,
              name: i.name,
              description: i.description,
              quantity: i.quantity,
              unitPrice: i.unitPrice,
              total: i.total,
              position: i.position,
            })),
          },
        },
        select: { id: true },
      });
      await this.factory.recompute(tx, invoice.id);
      await tx.quote.update({ where: { id: quote.id }, data: { invoiceId: invoice.id } });
    });
    await this.audit.record(null, {
      action: request.accept ? 'crm.quote_accepted' : 'crm.quote_declined',
      businessId: quote.tenantId,
      targetType: 'Quote',
      targetId: quote.id,
      metadata: { number: quote.number },
    });
    return this.publicDto(await this.byToken(token));
  }
}
