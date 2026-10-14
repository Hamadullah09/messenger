import { randomBytes } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  checkoutRequestSchema,
  PAYMENT_GATEWAYS,
  updatePaymentGatewayRequestSchema,
  type CheckoutDto,
  type CheckoutRequest,
  type PaymentGateway,
  type PaymentGatewaySettingsDto,
  type UpdatePaymentGatewayRequest,
} from '@storeline/shared';
import type { Request, Response } from 'express';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { ApiError } from '../../infra/http/api-error';
import { ApiZodBody, ZodPipe } from '../../infra/http/zod';
import { CurrentActor, Public, type Actor } from '../auth/actor';
import { CrmSettingsService } from './crm-core';
import { escapeHtml } from './crm-core';
import { type GatewayResult, OnlinePaymentsService } from './online-payments.service';

const gatewayParam = (value: string): PaymentGateway => {
  const g = value.toUpperCase();
  if (!(PAYMENT_GATEWAYS as readonly string[]).includes(g))
    throw ApiError.notFound('Payment method');
  return g as PaymentGateway;
};

/** Sales → CRM settings: the business's own JazzCash / Easypaisa merchant accounts. */
@ApiTags('crm')
@ApiBearerAuth()
@Controller({ path: 'sales/crm/payment-gateways', version: '1' })
export class PaymentGatewaysController {
  constructor(private readonly online: OnlinePaymentsService) {}

  @Get()
  list(@CurrentActor() actor: Actor): Promise<PaymentGatewaySettingsDto[]> {
    return this.online.listSettings(actor);
  }

  @Put(':gateway')
  @ApiZodBody(updatePaymentGatewayRequestSchema)
  update(
    @CurrentActor() actor: Actor,
    @Param('gateway') gateway: string,
    @Body(new ZodPipe(updatePaymentGatewayRequestSchema)) body: UpdatePaymentGatewayRequest,
  ): Promise<PaymentGatewaySettingsDto[]> {
    return this.online.updateSettings(actor, gatewayParam(gateway), body);
  }
}

/**
 * The customer pays online, and the gateways' answers. No sign-in: checkout needs the invoice's
 * pay link; answers are trusted only when signed (JazzCash) or confirmed by asking the
 * gateway (Easypaisa).
 */
@ApiTags('crm')
@Controller({ path: 'public', version: '1' })
export class OnlinePaymentsPublicController {
  constructor(
    private readonly online: OnlinePaymentsService,
    private readonly settings: CrmSettingsService,
    private readonly crypto: CryptoService,
  ) {}

  private ip(req: Request): string {
    return this.crypto.keyedHash(req.ip ?? 'unknown');
  }

  /** Back to the pay page with the result shown. */
  private back(res: Response, result: GatewayResult): void {
    const path = result.payToken ? `/pay/${result.payToken}?payment=${result.outcome}` : '/';
    res.redirect(303, this.settings.link(path));
  }

  @Public()
  @Post('invoices/:token/checkout')
  @HttpCode(200)
  @ApiZodBody(checkoutRequestSchema)
  checkout(
    @Param('token') token: string,
    @Body(new ZodPipe(checkoutRequestSchema)) body: CheckoutRequest,
    @Req() req: Request,
  ): Promise<CheckoutDto> {
    return this.online.checkout(token.slice(0, 64), body, this.ip(req));
  }

  /** JazzCash sends the customer back here (form post) after paying. */
  @Public()
  @Post('payments/jazzcash/return')
  async jazzcashReturn(@Req() req: Request, @Res() res: Response): Promise<void> {
    const result = await this.online.jazzcashResult(formBody(req), this.ip(req));
    this.back(res, result);
  }

  /** JazzCash's server-to-server notification (set this address in the merchant portal). */
  @Public()
  @Post('payments/jazzcash/ipn')
  @HttpCode(200)
  async jazzcashIpn(@Req() req: Request): Promise<{ received: boolean }> {
    await this.online.jazzcashResult(formBody(req), this.ip(req));
    return { received: true };
  }

  /** Easypaisa step 1: auto-post the token back to Easypaisa to complete the payment. */
  @Public()
  @Get('payments/easypaisa/return')
  async easypaisaReturn(
    @Query('ref') ref: string | undefined,
    @Query('auth_token') authToken: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const form = await this.online.easypaisaContinue(ref, authToken);
    if (!form) {
      res.redirect(303, this.settings.link('/'));
      return;
    }
    const nonce = randomBytes(16).toString('base64');
    const inputs = Object.entries(form.fields)
      .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
      .join('');
    // Only this page may run its one inline script and post to Easypaisa.
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; form-action ${new URL(form.action).origin}; base-uri 'none'; frame-ancestors 'none'`,
    );
    res
      .type('html')
      .send(
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Completing payment…</title></head>` +
          `<body style="font-family:system-ui,sans-serif;text-align:center;padding:48px 16px">` +
          `<p>Completing your Easypaisa payment…</p>` +
          `<form id="f" method="post" action="${escapeHtml(form.action)}">${inputs}<button type="submit">Continue</button></form>` +
          `<script nonce="${nonce}">document.getElementById('f').submit()</script></body></html>`,
      );
  }

  /** Easypaisa final step: confirmed by asking Easypaisa, then back to the pay page. */
  @Public()
  @Get('payments/easypaisa/done')
  async easypaisaDone(
    @Query('ref') ref: string | undefined,
    @Query('status') status: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    this.back(res, await this.online.easypaisaResult(ref, status, this.ip(req)));
  }
}

/** A form post's fields as strings (only flat string values are kept). */
function formBody(req: Request): Record<string, string> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body))
    if (typeof v === 'string' && k.length <= 60) out[k] = v.slice(0, 1000);
  return out;
}
