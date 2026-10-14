import { Injectable } from '@nestjs/common';
import type {
  FbrSettingsDto,
  SubmitToFbrRequest,
  UpdateFbrSettingsRequest,
} from '@storeline/shared';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { ApiError } from '../../infra/http/api-error';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { AuthorizationService } from '../authorization/authorization.service';
import { isoDate, num } from './crm-core';
import { fbrInvoicePayload, postToFbr } from './gateways/fbr';
import { SalesService } from './sales.service';

/** FBR Digital Invoicing per business: settings (token encrypted) and sending invoices. */
@Injectable()
export class FbrService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly authz: AuthorizationService,
    private readonly sales: SalesService,
    private readonly audit: AuditService,
  ) {}

  private aad(businessId: string) {
    return `fbr:${businessId}`;
  }

  private async requireBilling(actor: Actor): Promise<string> {
    const { businessId } = await this.sales.tenant(actor);
    await this.authz.require(actor, 'sales.billing.manage', { businessId });
    return businessId;
  }

  async settings(actor: Actor): Promise<FbrSettingsDto | null> {
    const businessId = await this.requireBilling(actor);
    const row = await this.prisma.fbrConfig.findUnique({ where: { businessId } });
    if (!row) return null;
    const { tokenEnc: _t, businessId: _b, updatedAt: _u, updatedById: _by, ...rest } = row;
    return { ...rest, tokenSaved: true };
  }

  async updateSettings(
    actor: Actor,
    request: UpdateFbrSettingsRequest,
  ): Promise<FbrSettingsDto | null> {
    const businessId = await this.requireBilling(actor);
    const current = await this.prisma.fbrConfig.findUnique({
      where: { businessId },
      select: { tokenEnc: true },
    });
    if (!request.token && !current) throw ApiError.validation('Enter the PRAL token.', 'token');
    const tokenEnc = request.token
      ? this.crypto.encrypt(request.token, this.aad(businessId))
      : current!.tokenEnc;
    const { token: _token, ...fields } = request;
    const data = {
      ...fields,
      scenarioId: request.scenarioId ?? null,
      tokenEnc,
      updatedById: actor.userId,
    };
    await this.prisma.fbrConfig.upsert({
      where: { businessId },
      create: { businessId, ...data },
      update: data,
    });
    await this.audit.record(actor, {
      action: 'crm.fbr_settings_changed',
      businessId,
      metadata: { enabled: request.enabled, sandbox: request.sandbox },
    });
    return this.settings(actor);
  }

  /** Posts an issued invoice to FBR and keeps the FBR invoice number (or the error) on it. */
  async submit(actor: Actor, invoiceId: string, request: SubmitToFbrRequest): Promise<void> {
    const businessId = await this.requireBilling(actor);
    const config = await this.prisma.fbrConfig.findUnique({ where: { businessId } });
    if (!config?.enabled)
      throw ApiError.conflict('Turn on FBR invoicing in Sales → CRM settings first.');
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, tenantId: businessId },
      include: { items: { orderBy: { position: 'asc' } } },
    });
    if (!invoice) throw ApiError.notFound('Invoice');
    if (invoice.status === 'DRAFT' || invoice.status === 'VOID')
      throw ApiError.conflict('Only issued invoices can be sent to FBR.');
    if (invoice.fbrInvoiceNumber && !(invoice.fbrSandbox && !config.sandbox))
      throw ApiError.conflict('This invoice is already registered with FBR.');
    if (invoice.currency !== 'PKR') throw ApiError.conflict('FBR invoices must be in PKR.');
    const seller = { ...config, sandbox: config.sandbox };
    const payload = fbrInvoicePayload(seller, {
      number: invoice.number,
      issueDate: isoDate(invoice.issueDate),
      taxRate: num(invoice.taxRate),
      discount: num(invoice.discount),
      buyer: {
        ntnCnic: request.buyerNtnCnic || null,
        name: invoice.billToName,
        province: request.buyerProvince,
        address: invoice.billToAddress,
      },
      items: invoice.items.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        total: num(i.total),
      })),
    });
    const token = this.crypto.decrypt(config.tokenEnc, this.aad(businessId));
    const result = await postToFbr(seller, token, payload);
    await this.prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        billToTaxNumber: request.buyerNtnCnic || null,
        billToProvince: request.buyerProvince,
        ...(result.ok
          ? {
              fbrInvoiceNumber: result.invoiceNumber,
              fbrSubmittedAt: new Date(),
              fbrSandbox: config.sandbox,
              fbrError: null,
            }
          : { fbrError: result.error }),
      },
    });
    await this.audit.record(actor, {
      action: result.ok ? 'crm.fbr_invoice_registered' : 'crm.fbr_invoice_failed',
      businessId,
      targetType: 'Invoice',
      targetId: invoice.id,
      metadata: { number: invoice.number, sandbox: config.sandbox },
    });
    if (!result.ok)
      throw ApiError.validation(`FBR did not accept the invoice: ${result.error}`, 'invoice');
  }
}
