import { randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { PaymentGateway as DbGateway, Prisma } from '@prisma/client';
import {
  type CheckoutDto,
  type CheckoutRequest,
  type GatewayMethod,
  type PaymentGateway,
  type PaymentGatewaySettingsDto,
  type UpdatePaymentGatewayRequest,
} from '@storeline/shared';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { ApiError } from '../../infra/http/api-error';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RateLimiterService } from '../../infra/redis/rate-limiter.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { AuthorizationService } from '../authorization/authorization.service';
import { CrmSettingsService, InvoiceFactory, num, round2 } from './crm-core';
import {
  easypaisaCheckout,
  easypaisaConfirmAction,
  easypaisaInquire,
  jazzcashCheckout,
  jazzcashOutcome,
  jazzcashVerify,
} from './gateways/gateways';
import { SalesService } from './sales.service';

interface Secrets {
  password?: string;
  integritySalt?: string;
  hashKey?: string;
  inquiryUsername?: string;
  inquiryPassword?: string;
  accountNumber?: string;
}

const CHECKOUT_LIMIT = { name: 'public:checkout', limit: 20, windowSeconds: 3600 } as const;
const CALLBACK_LIMIT = { name: 'public:gateway-callback', limit: 120, windowSeconds: 600 } as const;
const GATEWAY_LABEL: Record<PaymentGateway, string> = {
  JAZZCASH: 'JazzCash',
  EASYPAISA: 'Easypaisa',
};

export type GatewayResult = { payToken: string | null; outcome: 'paid' | 'pending' | 'failed' };

/**
 * Online payment of invoices through each business's own JazzCash / Easypaisa merchant
 * account. An invoice is marked paid only from a signed (JazzCash) or server-confirmed
 * (Easypaisa inquiry) answer whose amount matches; anything else becomes a "payment to check"
 * for a manager. Credentials are stored encrypted and never returned.
 */
@Injectable()
export class OnlinePaymentsService {
  private readonly logger = new Logger(OnlinePaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly authz: AuthorizationService,
    private readonly sales: SalesService,
    private readonly settings: CrmSettingsService,
    private readonly factory: InvoiceFactory,
    private readonly audit: AuditService,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  private aad(businessId: string, gateway: PaymentGateway) {
    return `gateway:${businessId}:${gateway}`;
  }

  private async config(businessId: string, gateway: PaymentGateway) {
    const row = await this.prisma.paymentGatewayConfig.findUnique({
      where: { businessId_gateway: { businessId, gateway } },
    });
    if (!row) return null;
    const secrets = JSON.parse(
      this.crypto.decrypt(row.credentialsEnc, this.aad(businessId, gateway)),
    ) as Secrets & {
      methods?: GatewayMethod[];
    };
    return { row, secrets, methods: secrets.methods ?? (['WALLET', 'CARD'] as GatewayMethod[]) };
  }

  private callbackUrls(gateway: PaymentGateway) {
    const g = gateway === 'JAZZCASH' ? 'jazzcash' : 'easypaisa';
    return {
      returnUrl: this.settings.link(`/api/v1/public/payments/${g}/return`),
      ipnUrl: this.settings.link(`/api/v1/public/payments/${g}/ipn`),
    };
  }

  // ───────────────────────────── Settings (Sales → CRM settings) ─────────────────────────────

  private async requireBilling(actor: Actor): Promise<string> {
    const { businessId } = await this.sales.tenant(actor);
    await this.authz.require(actor, 'sales.billing.manage', { businessId });
    return businessId;
  }

  async listSettings(actor: Actor): Promise<PaymentGatewaySettingsDto[]> {
    const businessId = await this.requireBilling(actor);
    const out: PaymentGatewaySettingsDto[] = [];
    for (const gateway of ['JAZZCASH', 'EASYPAISA'] as const) {
      const c = await this.config(businessId, gateway);
      out.push({
        gateway,
        enabled: c?.row.enabled ?? false,
        sandbox: c?.row.sandbox ?? true,
        merchantId: c?.row.merchantId ?? null,
        saved: {
          password: !!c?.secrets.password,
          integritySalt: !!c?.secrets.integritySalt,
          hashKey: !!c?.secrets.hashKey,
          inquiryUsername: !!c?.secrets.inquiryUsername,
          inquiryPassword: !!c?.secrets.inquiryPassword,
        },
        accountNumber: c?.secrets.accountNumber ?? null,
        methods: c?.methods ?? ['WALLET', 'CARD'],
        callbackUrls: this.callbackUrls(gateway),
      });
    }
    return out;
  }

  async updateSettings(
    actor: Actor,
    gateway: PaymentGateway,
    request: UpdatePaymentGatewayRequest,
  ): Promise<PaymentGatewaySettingsDto[]> {
    const businessId = await this.requireBilling(actor);
    const current = await this.config(businessId, gateway);
    const keep = (value: string | undefined, saved: string | undefined) =>
      value === undefined ? saved : value.trim() || undefined;
    const secrets: Secrets & { methods: GatewayMethod[] } = {
      password: keep(request.password, current?.secrets.password),
      integritySalt: keep(request.integritySalt, current?.secrets.integritySalt),
      hashKey: keep(request.hashKey, current?.secrets.hashKey),
      inquiryUsername: keep(request.inquiryUsername, current?.secrets.inquiryUsername),
      inquiryPassword: keep(request.inquiryPassword, current?.secrets.inquiryPassword),
      accountNumber:
        request.accountNumber === undefined
          ? current?.secrets.accountNumber
          : request.accountNumber?.trim() || undefined,
      methods: [...new Set(request.methods)],
    };
    if (request.enabled) {
      if (gateway === 'JAZZCASH' && (!secrets.password || !secrets.integritySalt))
        throw ApiError.validation('Enter the JazzCash password and integrity salt.', 'password');
      if (gateway === 'EASYPAISA') {
        if (!secrets.hashKey) throw ApiError.validation('Enter the Easypaisa hash key.', 'hashKey');
        if (![16, 24, 32].includes(Buffer.byteLength(secrets.hashKey)))
          throw ApiError.validation(
            'The Easypaisa hash key must be 16, 24 or 32 characters.',
            'hashKey',
          );
      }
    }
    const credentialsEnc = this.crypto.encrypt(
      JSON.stringify(secrets),
      this.aad(businessId, gateway),
    );
    await this.prisma.paymentGatewayConfig.upsert({
      where: { businessId_gateway: { businessId, gateway } },
      create: {
        businessId,
        gateway,
        enabled: request.enabled,
        sandbox: request.sandbox,
        merchantId: request.merchantId,
        credentialsEnc,
        updatedById: actor.userId,
      },
      update: {
        enabled: request.enabled,
        sandbox: request.sandbox,
        merchantId: request.merchantId,
        credentialsEnc,
        updatedById: actor.userId,
      },
    });
    await this.audit.record(actor, {
      action: 'crm.payment_gateway_changed',
      businessId,
      metadata: { gateway, enabled: request.enabled, sandbox: request.sandbox },
    });
    return this.listSettings(actor);
  }

  // ───────────────────────────── Public pay page ─────────────────────────────

  /** Gateways the business has turned on (for the pay page). */
  async enabledFor(
    tenantId: string,
  ): Promise<Array<{ gateway: PaymentGateway; methods: GatewayMethod[]; sandbox: boolean }>> {
    const rows = await this.prisma.paymentGatewayConfig.findMany({
      where: { businessId: tenantId, enabled: true },
    });
    const out = [];
    for (const row of rows) {
      const c = await this.config(tenantId, row.gateway);
      if (c)
        out.push({
          gateway: row.gateway as PaymentGateway,
          methods: c.methods,
          sandbox: row.sandbox,
        });
    }
    return out;
  }

  async checkout(token: string, request: CheckoutRequest, ipHash: string): Promise<CheckoutDto> {
    await this.rateLimiter.consume(CHECKOUT_LIMIT, ipHash);
    const invoice = await this.prisma.invoice.findUnique({
      where: { payToken: token },
      select: {
        id: true,
        tenantId: true,
        number: true,
        status: true,
        total: true,
        amountPaid: true,
        currency: true,
        billToEmail: true,
      },
    });
    if (!invoice || invoice.status === 'DRAFT' || invoice.status === 'VOID')
      throw ApiError.notFound('Invoice');
    if (invoice.status === 'PAID')
      throw ApiError.conflict('This invoice is already paid. Thank you!');
    if (invoice.currency !== 'PKR')
      throw ApiError.conflict('Online payment is only available for invoices in PKR.');
    const c = await this.config(invoice.tenantId, request.gateway);
    if (!c?.row.enabled) throw ApiError.notFound('Payment method');
    if (!c.methods.includes(request.method))
      throw ApiError.validation('This way of paying is not available.', 'method');
    const amount = round2(num(invoice.total) - num(invoice.amountPaid));
    if (amount <= 0) throw ApiError.conflict('Nothing is due on this invoice.');
    // Short, unique, letters and digits only (both gateways accept it).
    const reference = `S${Date.now().toString(36).toUpperCase()}${randomBytes(4).toString('hex').toUpperCase()}`;
    await this.prisma.paymentAttempt.create({
      data: {
        tenantId: invoice.tenantId,
        invoiceId: invoice.id,
        gateway: request.gateway as DbGateway,
        reference,
        amount,
        currency: 'PKR',
        method: request.method,
        sandbox: c.row.sandbox,
      },
    });
    const urls = this.callbackUrls(request.gateway);
    if (request.gateway === 'JAZZCASH') {
      return jazzcashCheckout(
        {
          merchantId: c.row.merchantId,
          password: c.secrets.password!,
          integritySalt: c.secrets.integritySalt!,
          sandbox: c.row.sandbox,
        },
        {
          reference,
          amount,
          description: `Invoice ${invoice.number}`,
          billReference: invoice.number,
          returnUrl: urls.returnUrl,
          method: request.method,
        },
      );
    }
    if (request.method === 'WALLET' && !request.mobile)
      throw ApiError.validation('Enter your Easypaisa mobile number.', 'mobile');
    return easypaisaCheckout(
      { storeId: c.row.merchantId, hashKey: c.secrets.hashKey!, sandbox: c.row.sandbox },
      {
        reference,
        amount,
        postBackUrl: `${urls.returnUrl}?ref=${reference}`,
        method: request.method,
        email: request.email ?? invoice.billToEmail ?? undefined,
        mobile: request.mobile,
      },
    );
  }

  // ───────────────────────────── Gateway callbacks ─────────────────────────────

  private async attempt(gateway: PaymentGateway, reference: string | undefined) {
    if (!reference || !/^[A-Za-z0-9]{6,40}$/.test(reference)) return null;
    return this.prisma.paymentAttempt.findUnique({
      where: { gateway_reference: { gateway: gateway as DbGateway, reference } },
      include: { invoice: { select: { payToken: true, number: true } } },
    });
  }

  /** JazzCash answers (browser return and server notification): signed with the salt. */
  async jazzcashResult(body: Record<string, string>, ipHash: string): Promise<GatewayResult> {
    await this.rateLimiter.consume(CALLBACK_LIMIT, ipHash);
    const attempt = await this.attempt('JAZZCASH', body.pp_TxnRefNo);
    if (!attempt) return { payToken: null, outcome: 'failed' };
    const c = await this.config(attempt.tenantId, 'JAZZCASH');
    if (!c?.secrets.integritySalt || !jazzcashVerify(body, c.secrets.integritySalt)) {
      this.logger.warn(
        { reference: attempt.reference },
        'JazzCash answer with a wrong signature ignored',
      );
      return { payToken: attempt.invoice.payToken, outcome: 'failed' };
    }
    const outcome = jazzcashOutcome(body.pp_ResponseCode);
    const paidAmount = Number(body.pp_Amount) / 100;
    const details = {
      gatewayTxnId: (body.pp_RetreivalReferenceNo || body.pp_TxnRefNo || '').slice(0, 80),
      responseCode: (body.pp_ResponseCode ?? '').slice(0, 20),
      responseMessage: (body.pp_ResponseMessage ?? '').slice(0, 300),
    };
    return this.settle(attempt, outcome, paidAmount, details);
  }

  /**
   * Easypaisa step 1: the gateway sends the browser back with a token, which the browser must
   * post to Confirm.jsf. Returns the form to auto-submit.
   */
  async easypaisaContinue(reference: string | undefined, authToken: string | undefined) {
    const attempt = await this.attempt('EASYPAISA', reference);
    if (!attempt || !authToken || authToken.length > 500) return null;
    return {
      action: easypaisaConfirmAction(attempt.sandbox),
      fields: {
        auth_token: authToken,
        postBackURL: `${this.callbackUrls('EASYPAISA').returnUrl.replace(/\/return$/, '/done')}?ref=${attempt.reference}`,
      },
    };
  }

  /** Easypaisa final step: confirmed only by asking Easypaisa (server to server). */
  async easypaisaResult(
    reference: string | undefined,
    status: string | undefined,
    ipHash: string,
  ): Promise<GatewayResult> {
    await this.rateLimiter.consume(CALLBACK_LIMIT, ipHash);
    const attempt = await this.attempt('EASYPAISA', reference);
    if (!attempt) return { payToken: null, outcome: 'failed' };
    if (attempt.status === 'PAID') return { payToken: attempt.invoice.payToken, outcome: 'paid' };
    const c = await this.config(attempt.tenantId, 'EASYPAISA');
    const answer = c
      ? await easypaisaInquire(
          {
            storeId: c.row.merchantId,
            hashKey: c.secrets.hashKey ?? '',
            sandbox: attempt.sandbox,
            inquiryUsername: c.secrets.inquiryUsername,
            inquiryPassword: c.secrets.inquiryPassword,
            accountNumber: c.secrets.accountNumber,
          },
          attempt.reference,
        ).catch(() => null)
      : null;
    if (!answer) {
      // No way to confirm automatically: a browser status alone is never trusted.
      const outcome = status === '0000' ? 'REVIEW' : 'FAILED';
      return this.settle(attempt, outcome, num(attempt.amount), {
        gatewayTxnId: null,
        responseCode: (status ?? '').slice(0, 20),
        responseMessage:
          outcome === 'REVIEW'
            ? 'Easypaisa said paid; check it in the Easypaisa portal'
            : 'Not paid',
      });
    }
    const state = answer.status.toUpperCase();
    const outcome = state === 'PAID' ? 'PAID' : state === 'PENDING' ? 'PENDING' : 'FAILED';
    return this.settle(attempt, outcome, answer.amount ?? 0, {
      gatewayTxnId: answer.transactionId?.slice(0, 80) ?? null,
      responseCode: state.slice(0, 20),
      responseMessage: `Easypaisa: ${state}`,
    });
  }

  /** Records the outcome once; a confirmed, matching amount becomes a payment on the invoice. */
  private async settle(
    attempt: {
      id: string;
      tenantId: string;
      invoiceId: string;
      gateway: DbGateway;
      reference: string;
      amount: Prisma.Decimal;
      sandbox: boolean;
      invoice: { payToken: string | null; number: string };
    },
    outcome: 'PAID' | 'PENDING' | 'FAILED' | 'REVIEW',
    paidAmount: number,
    details: { gatewayTxnId: string | null; responseCode: string; responseMessage: string },
  ): Promise<GatewayResult> {
    const payToken = attempt.invoice.payToken;
    const label = `${GATEWAY_LABEL[attempt.gateway as PaymentGateway]}${attempt.sandbox ? ' (test)' : ''}`;
    if (outcome === 'PENDING') return { payToken, outcome: 'pending' };
    if (outcome === 'FAILED') {
      await this.prisma.paymentAttempt.updateMany({
        where: { id: attempt.id, status: 'PENDING' },
        data: { status: 'FAILED', completedAt: new Date(), ...details },
      });
      return { payToken, outcome: 'failed' };
    }
    const expected = num(attempt.amount);
    const matches = Math.abs(paidAmount - expected) < 0.005;
    const result = await this.prisma.$transaction(async (tx) => {
      // Only one answer settles an attempt (return and notification may both arrive).
      const claimed = await tx.paymentAttempt.updateMany({
        where: { id: attempt.id, status: 'PENDING' },
        data: {
          status: outcome === 'PAID' && matches ? 'PAID' : 'NEEDS_REVIEW',
          completedAt: new Date(),
          ...details,
        },
      });
      if (claimed.count === 0) return 'already';
      await tx.$executeRaw`SELECT 1 FROM "Invoice" WHERE "id" = ${attempt.invoiceId}::uuid FOR UPDATE`;
      const invoice = await tx.invoice.findUniqueOrThrow({
        where: { id: attempt.invoiceId },
        select: { status: true, total: true, amountPaid: true },
      });
      const balance = round2(num(invoice.total) - num(invoice.amountPaid));
      const reference = (details.gatewayTxnId || attempt.reference).slice(0, 120);
      if (
        outcome === 'PAID' &&
        matches &&
        invoice.status !== 'VOID' &&
        paidAmount <= balance + 0.004
      ) {
        const payment = await tx.payment.create({
          data: {
            invoiceId: attempt.invoiceId,
            amount: paidAmount,
            paidAt: new Date(),
            method: 'ONLINE',
            reference,
            notes: `Paid online with ${label}`,
          },
          select: { id: true },
        });
        await tx.paymentAttempt.update({
          where: { id: attempt.id },
          data: { paymentId: payment.id },
        });
        await this.factory.recompute(tx, attempt.invoiceId);
        await this.audit.record(
          null,
          {
            action: 'crm.online_payment_received',
            businessId: attempt.tenantId,
            targetType: 'Invoice',
            targetId: attempt.invoiceId,
            metadata: { gateway: attempt.gateway, amount: paidAmount, sandbox: attempt.sandbox },
          },
          tx,
        );
        return 'paid';
      }
      // Paid but could not be matched (amount, already paid, voided, or unconfirmed): a manager
      // checks it in "Payments to confirm".
      if (outcome === 'PAID' || outcome === 'REVIEW') {
        await tx.paymentAttempt.update({
          where: { id: attempt.id },
          data: { status: 'NEEDS_REVIEW' },
        });
        await tx.paymentClaim.create({
          data: {
            invoiceId: attempt.invoiceId,
            amount: paidAmount > 0 ? Math.min(paidAmount, 999_999_999) : expected,
            method: 'ONLINE',
            reference,
            payerName: null,
            note: `${label}: ${outcome === 'REVIEW' ? 'could not be confirmed automatically' : `amount ${paidAmount} instead of ${expected}`}. Check it in the ${label} merchant portal.`,
          },
        });
      }
      return 'review';
    });
    return {
      payToken,
      outcome:
        result === 'paid'
          ? 'paid'
          : result === 'already'
            ? await this.attemptOutcome(attempt.id)
            : 'pending',
    };
  }

  private async attemptOutcome(id: string): Promise<GatewayResult['outcome']> {
    const row = await this.prisma.paymentAttempt.findUnique({
      where: { id },
      select: { status: true },
    });
    return row?.status === 'PAID' ? 'paid' : row?.status === 'FAILED' ? 'failed' : 'pending';
  }
}
