import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  createQuoteRequestSchema,
  createSubscriptionRequestSchema,
  leadImportPreviewRequestSchema,
  leadImportRequestSchema,
  respondToQuoteRequestSchema,
  submitPaymentClaimSchema,
  updateSubscriptionRequestSchema,
  type CreateQuoteRequest,
  type CreateSubscriptionRequest,
  type InvoiceDto,
  type LeadDuplicateDto,
  type LeadImportPreviewDto,
  type LeadImportPreviewRequest,
  type LeadImportRequest,
  type LeadImportResultDto,
  type PublicInvoiceDto,
  type PublicQuoteDto,
  type QuoteDto,
  type RespondToQuoteRequest,
  type SubmitPaymentClaimRequest,
  type SubscriptionDto,
  type UpdateSubscriptionRequest,
} from '@storeline/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { ApiError } from '../../infra/http/api-error';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../../infra/http/zod';
import { CurrentActor, Public, type Actor } from '../auth/actor';
import { PublicPayService, SubscriptionsService } from './billing.service';
import { BillingRunner } from './billing-scheduler';
import { CrmService } from './crm.service';
import { LeadImportService } from './lead-import.service';
import { QuotesService } from './quotes.service';

const quotesQuerySchema = z.object({
  status: z.enum(['DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED']).optional(),
  dealId: z.uuid().optional(),
});
const sendQuoteSchema = z.object({ email: z.boolean().default(false) });
const subscriptionsQuerySchema = z.object({ businessId: z.uuid().optional() });
const duplicatesQuerySchema = z.object({
  companyName: z.string().trim().max(120).optional(),
  email: z.string().trim().max(254).optional(),
  phone: z.string().trim().max(30).optional(),
});

/** Quotes, subscriptions, reminders and lead import (signed-in sales users). */
@ApiTags('crm')
@ApiBearerAuth()
@Controller({ path: 'sales/crm', version: '1' })
export class BillingController {
  constructor(
    private readonly quotes: QuotesService,
    private readonly subscriptions: SubscriptionsService,
    private readonly runner: BillingRunner,
    private readonly crm: CrmService,
    private readonly leads: LeadImportService,
  ) {}

  // ── Quotes ──

  @Get('quotes')
  @ApiZodQuery(quotesQuerySchema)
  listQuotes(
    @CurrentActor() actor: Actor,
    @Query(new ZodPipe(quotesQuerySchema)) query: z.infer<typeof quotesQuerySchema>,
  ): Promise<QuoteDto[]> {
    return this.quotes.list(actor, query);
  }

  @Post('quotes')
  @ApiZodBody(createQuoteRequestSchema)
  createQuote(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(createQuoteRequestSchema)) body: CreateQuoteRequest,
  ): Promise<QuoteDto> {
    return this.quotes.create(actor, body);
  }

  @Get('quotes/:id')
  quote(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string): Promise<QuoteDto> {
    return this.quotes.get(actor, id);
  }

  /** Mark as sent (and email the link when asked). */
  @Post('quotes/:id/send')
  @HttpCode(200)
  @ApiZodBody(sendQuoteSchema)
  sendQuote(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(sendQuoteSchema)) body: z.infer<typeof sendQuoteSchema>,
  ): Promise<QuoteDto & { emailed: boolean }> {
    return this.quotes.send(actor, id, body.email);
  }

  @Delete('quotes/:id')
  @HttpCode(204)
  async removeQuote(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.quotes.remove(actor, id);
  }

  // ── Subscriptions ──

  @Get('subscriptions')
  @ApiZodQuery(subscriptionsQuerySchema)
  listSubscriptions(
    @CurrentActor() actor: Actor,
    @Query(new ZodPipe(subscriptionsQuerySchema)) query: z.infer<typeof subscriptionsQuerySchema>,
  ): Promise<SubscriptionDto[]> {
    return this.subscriptions.list(actor, query.businessId);
  }

  @Post('subscriptions')
  @ApiZodBody(createSubscriptionRequestSchema)
  createSubscription(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(createSubscriptionRequestSchema)) body: CreateSubscriptionRequest,
  ): Promise<SubscriptionDto> {
    return this.subscriptions.create(actor, body);
  }

  @Patch('subscriptions/:id')
  @ApiZodBody(updateSubscriptionRequestSchema)
  updateSubscription(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateSubscriptionRequestSchema)) body: UpdateSubscriptionRequest,
  ): Promise<SubscriptionDto> {
    return this.subscriptions.update(actor, id, body);
  }

  // ── Reminders ──

  /** Send an overdue reminder now (email/WhatsApp/SMS as configured). */
  @Post('invoices/:id/remind')
  @HttpCode(200)
  async remind(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InvoiceDto & { reminded: boolean }> {
    const invoice = await this.crm.getInvoice(actor, id);
    if (!invoice.canManage) throw ApiError.forbidden('Only sales managers can send reminders.');
    const reminded = await this.runner.remind(id);
    return { ...(await this.crm.getInvoice(actor, id)), reminded };
  }

  // ── Lead import ──

  @Post('leads/import/preview')
  @HttpCode(200)
  @ApiZodBody(leadImportPreviewRequestSchema)
  previewImport(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(leadImportPreviewRequestSchema)) body: LeadImportPreviewRequest,
  ): Promise<LeadImportPreviewDto> {
    return this.leads.preview(actor, body);
  }

  @Post('leads/import')
  @ApiZodBody(leadImportRequestSchema)
  importLeads(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(leadImportRequestSchema)) body: LeadImportRequest,
  ): Promise<LeadImportResultDto> {
    return this.leads.import(actor, body);
  }

  @Get('leads/duplicates')
  @ApiZodQuery(duplicatesQuerySchema)
  duplicates(
    @CurrentActor() actor: Actor,
    @Query(new ZodPipe(duplicatesQuerySchema)) query: z.infer<typeof duplicatesQuerySchema>,
  ): Promise<LeadDuplicateDto[]> {
    return this.leads.duplicates(actor, query);
  }
}

/** The customer's quote and pay pages (no sign-in; the link is the key). */
@ApiTags('crm')
@Controller({ path: 'public', version: '1' })
export class PublicCrmController {
  constructor(
    private readonly quotes: QuotesService,
    private readonly pay: PublicPayService,
    @Inject(CryptoService) private readonly crypto: CryptoService,
  ) {}

  private ip(req: Request): string {
    return this.crypto.keyedHash(req.ip ?? 'unknown');
  }

  @Public()
  @Get('quotes/:token')
  quote(@Param('token') token: string, @Req() req: Request): Promise<PublicQuoteDto> {
    return this.quotes.publicView(token.slice(0, 64), this.ip(req));
  }

  @Public()
  @Post('quotes/:token/respond')
  @HttpCode(200)
  @ApiZodBody(respondToQuoteRequestSchema)
  respond(
    @Param('token') token: string,
    @Body(new ZodPipe(respondToQuoteRequestSchema)) body: RespondToQuoteRequest,
    @Req() req: Request,
  ): Promise<PublicQuoteDto> {
    return this.quotes.respond(token.slice(0, 64), body, this.ip(req));
  }

  @Public()
  @Get('invoices/:token')
  invoice(@Param('token') token: string, @Req() req: Request): Promise<PublicInvoiceDto> {
    return this.pay.view(token.slice(0, 64), this.ip(req));
  }

  @Public()
  @Post('invoices/:token/claims')
  @HttpCode(200)
  @ApiZodBody(submitPaymentClaimSchema)
  claim(
    @Param('token') token: string,
    @Body(new ZodPipe(submitPaymentClaimSchema)) body: SubmitPaymentClaimRequest,
    @Req() req: Request,
  ): Promise<PublicInvoiceDto> {
    return this.pay.claim(token.slice(0, 64), body, this.ip(req));
  }
}
