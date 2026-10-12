import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  changeDealStatusRequestSchema,
  createDealRequestSchema,
  createInvoiceRequestSchema,
  listDealsQuerySchema,
  listInvoicesQuerySchema,
  monthSchema,
  recordPaymentRequestSchema,
  setTargetRequestSchema,
  updateDealRequestSchema,
  updateInvoiceRequestSchema,
  upsertServiceRequestSchema,
  type ChangeDealStatusRequest,
  type CreateDealRequest,
  type CreateInvoiceRequest,
  type CrmCustomerDto,
  type CrmOverviewDto,
  type CrmServiceDto,
  type DealDto,
  type InvoiceDto,
  type ListDealsQuery,
  type ListInvoicesQuery,
  type RecordPaymentRequest,
  type SetTargetRequest,
  type TargetHistoryDto,
  type TargetsDto,
  type UpdateDealRequest,
  type UpdateInvoiceRequest,
  type UpsertServiceRequest,
} from '@storeline/shared';
import { z } from 'zod';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../../infra/http/zod';
import { CurrentActor, type Actor } from '../auth/actor';
import { CrmService } from './crm.service';

const monthQuerySchema = z.object({ month: monthSchema.optional() });
const voidSchema = z.object({ reason: z.string().trim().min(1).max(300) });

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

@ApiTags('crm')
@ApiBearerAuth()
@Controller({ path: 'sales/crm', version: '1' })
export class CrmController {
  constructor(private readonly crm: CrmService) {}

  @Get('overview')
  overview(@CurrentActor() actor: Actor): Promise<CrmOverviewDto> {
    return this.crm.overview(actor);
  }

  @Get('settings')
  settings(): ReturnType<CrmService['invoiceSettings']> {
    return this.crm.invoiceSettings();
  }

  // ── Services ──

  @Get('services')
  services(@CurrentActor() actor: Actor): Promise<CrmServiceDto[]> {
    return this.crm.listServices(actor);
  }

  @Post('services')
  @ApiZodBody(upsertServiceRequestSchema)
  createService(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(upsertServiceRequestSchema)) body: UpsertServiceRequest,
  ): Promise<CrmServiceDto[]> {
    return this.crm.saveService(actor, null, body);
  }

  @Patch('services/:id')
  @ApiZodBody(upsertServiceRequestSchema)
  updateService(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(upsertServiceRequestSchema)) body: UpsertServiceRequest,
  ): Promise<CrmServiceDto[]> {
    return this.crm.saveService(actor, id, body);
  }

  // ── Deals ──

  @Get('deals')
  @ApiZodQuery(listDealsQuerySchema)
  deals(
    @CurrentActor() actor: Actor,
    @Query(new ZodPipe(listDealsQuerySchema)) query: ListDealsQuery,
  ): Promise<DealDto[]> {
    return this.crm.listDeals(actor, query);
  }

  @Post('deals')
  @ApiZodBody(createDealRequestSchema)
  createDeal(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(createDealRequestSchema)) body: CreateDealRequest,
  ): Promise<DealDto> {
    return this.crm.createDeal(actor, body);
  }

  @Get('deals/:id')
  deal(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string): Promise<DealDto> {
    return this.crm.getDeal(actor, id);
  }

  @Patch('deals/:id')
  @ApiZodBody(updateDealRequestSchema)
  updateDeal(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateDealRequestSchema)) body: UpdateDealRequest,
  ): Promise<DealDto> {
    return this.crm.updateDeal(actor, id, body);
  }

  @Put('deals/:id/status')
  @ApiZodBody(changeDealStatusRequestSchema)
  dealStatus(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(changeDealStatusRequestSchema)) body: ChangeDealStatusRequest,
  ): Promise<DealDto> {
    return this.crm.changeDealStatus(actor, id, body);
  }

  @Delete('deals/:id')
  @HttpCode(204)
  async removeDeal(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.crm.removeDeal(actor, id);
  }

  // ── Invoices ──

  @Get('invoices')
  @ApiZodQuery(listInvoicesQuerySchema)
  invoices(
    @CurrentActor() actor: Actor,
    @Query(new ZodPipe(listInvoicesQuerySchema)) query: ListInvoicesQuery,
  ): Promise<InvoiceDto[]> {
    return this.crm.listInvoices(actor, query);
  }

  @Post('invoices')
  @ApiZodBody(createInvoiceRequestSchema)
  createInvoice(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(createInvoiceRequestSchema)) body: CreateInvoiceRequest,
  ): Promise<InvoiceDto> {
    return this.crm.createInvoice(actor, body);
  }

  @Get('invoices/:id')
  invoice(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InvoiceDto> {
    return this.crm.getInvoice(actor, id);
  }

  @Patch('invoices/:id')
  @ApiZodBody(updateInvoiceRequestSchema)
  updateInvoice(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateInvoiceRequestSchema)) body: UpdateInvoiceRequest,
  ): Promise<InvoiceDto> {
    return this.crm.updateInvoice(actor, id, body);
  }

  @Post('invoices/:id/issue')
  @HttpCode(200)
  issue(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InvoiceDto> {
    return this.crm.issueInvoice(actor, id);
  }

  @Post('invoices/:id/void')
  @HttpCode(200)
  @ApiZodBody(voidSchema)
  voidInvoice(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(voidSchema)) body: z.infer<typeof voidSchema>,
  ): Promise<InvoiceDto> {
    return this.crm.voidInvoice(actor, id, body.reason);
  }

  @Post('invoices/:id/email')
  @HttpCode(200)
  email(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InvoiceDto> {
    return this.crm.emailInvoice(actor, id);
  }

  @Post('invoices/:id/payments')
  @ApiZodBody(recordPaymentRequestSchema)
  pay(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(recordPaymentRequestSchema)) body: RecordPaymentRequest,
  ): Promise<InvoiceDto> {
    return this.crm.recordPayment(actor, id, body);
  }

  @Delete('invoices/:id/payments/:paymentId')
  voidPayment(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
  ): Promise<InvoiceDto> {
    return this.crm.voidPayment(actor, id, paymentId);
  }

  // ── Customers and targets ──

  @Get('customers')
  customers(@CurrentActor() actor: Actor): Promise<CrmCustomerDto[]> {
    return this.crm.customers(actor);
  }

  @Get('targets')
  @ApiZodQuery(monthQuerySchema)
  targets(
    @CurrentActor() actor: Actor,
    @Query(new ZodPipe(monthQuerySchema)) query: z.infer<typeof monthQuerySchema>,
  ): Promise<TargetsDto> {
    return this.crm.targets(actor, query.month ?? currentMonth());
  }

  @Put('targets')
  @ApiZodBody(setTargetRequestSchema)
  setTarget(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(setTargetRequestSchema)) body: SetTargetRequest,
  ): Promise<TargetsDto> {
    return this.crm.setTarget(actor, body);
  }

  @Get('targets/history/:userId')
  history(
    @CurrentActor() actor: Actor,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<TargetHistoryDto> {
    return this.crm.targetHistory(actor, userId);
  }
}
