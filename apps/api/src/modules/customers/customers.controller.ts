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
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  createCustomerCampaignRequestSchema,
  createStoreCustomerRequestSchema,
  previewCustomerCampaignRequestSchema,
  unsubscribeRequestSchema,
  type CreateCustomerCampaignRequest,
  type CustomerCampaignDetailDto,
  type CustomerCampaignDto,
  type CustomerCampaignPreviewDto,
  type MarketingChannelsDto,
  type PreviewCustomerCampaignRequest,
  type UnsubscribeRequest,
  listStoreCustomersQuerySchema,
  updateStoreCustomerRequestSchema,
  type CreateStoreCustomerRequest,
  type ListStoreCustomersQuery,
  type StoreCustomerDto,
  type StoreCustomerSummaryDto,
  type UpdateStoreCustomerRequest,
} from '@storeline/shared';
import type { Response } from 'express';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../../infra/http/zod';
import { CurrentActor, Public, type Actor } from '../auth/actor';
import { CustomerCampaignsService } from './customer-campaigns.service';
import { CustomersService } from './customers.service';

@ApiTags('customers')
@ApiBearerAuth()
@Controller({ version: '1' })
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get('businesses/:businessId/customers')
  @ApiZodQuery(listStoreCustomersQuerySchema)
  list(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Query(new ZodPipe(listStoreCustomersQuerySchema)) query: ListStoreCustomersQuery,
  ): Promise<{ items: StoreCustomerDto[]; summary: StoreCustomerSummaryDto }> {
    return this.customers.list(actor, businessId, query);
  }

  @Post('businesses/:businessId/customers')
  @ApiZodBody(createStoreCustomerRequestSchema)
  create(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Body(new ZodPipe(createStoreCustomerRequestSchema)) body: CreateStoreCustomerRequest,
  ): Promise<StoreCustomerDto> {
    return this.customers.create(actor, businessId, body);
  }

  /** Opted-in customers as CSV, for a campaign. */
  @Get('businesses/:businessId/customers-export.csv')
  async export(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const csv = await this.customers.exportCsv(actor, businessId);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="store-customers-opted-in.csv"');
    return '﻿' + csv;
  }

  @Patch('customers/:id')
  @ApiZodBody(updateStoreCustomerRequestSchema)
  update(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateStoreCustomerRequestSchema)) body: UpdateStoreCustomerRequest,
  ): Promise<StoreCustomerDto> {
    return this.customers.update(actor, id, body);
  }

  @Delete('customers/:id')
  @HttpCode(204)
  async remove(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.customers.remove(actor, id);
  }
}

/** Campaigns to opted-in store customers (email, SMS, WhatsApp). */
@ApiTags('customers')
@ApiBearerAuth()
@Controller({ version: '1' })
export class CustomerCampaignsController {
  constructor(private readonly campaigns: CustomerCampaignsService) {}

  @Get('marketing/channels')
  channels(): MarketingChannelsDto {
    return this.campaigns.channelsAvailable();
  }

  @Get('businesses/:businessId/customer-campaigns')
  list(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
  ): Promise<CustomerCampaignDto[]> {
    return this.campaigns.list(actor, businessId);
  }

  @Post('businesses/:businessId/customer-campaigns/preview')
  @HttpCode(200)
  @ApiZodBody(previewCustomerCampaignRequestSchema)
  preview(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Body(new ZodPipe(previewCustomerCampaignRequestSchema)) body: PreviewCustomerCampaignRequest,
  ): Promise<CustomerCampaignPreviewDto> {
    return this.campaigns.preview(actor, businessId, body);
  }

  @Post('businesses/:businessId/customer-campaigns')
  @ApiZodBody(createCustomerCampaignRequestSchema)
  create(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Body(new ZodPipe(createCustomerCampaignRequestSchema)) body: CreateCustomerCampaignRequest,
  ): Promise<CustomerCampaignDto> {
    return this.campaigns.create(actor, businessId, body);
  }

  @Get('customer-campaigns/:id')
  get(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CustomerCampaignDetailDto> {
    return this.campaigns.get(actor, id);
  }

  @Post('customer-campaigns/:id/send')
  @HttpCode(200)
  send(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CustomerCampaignDetailDto> {
    return this.campaigns.send(actor, id);
  }

  @Post('customer-campaigns/:id/cancel')
  @HttpCode(200)
  cancel(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CustomerCampaignDetailDto> {
    return this.campaigns.cancel(actor, id);
  }
}

/** The unsubscribe link in every campaign message. No sign-in. */
@ApiTags('customers')
@Controller({ path: 'public/unsubscribe', version: '1' })
export class PublicUnsubscribeController {
  constructor(private readonly campaigns: CustomerCampaignsService) {}

  @Public()
  @Post()
  @HttpCode(200)
  @ApiZodBody(unsubscribeRequestSchema)
  unsubscribe(
    @Body(new ZodPipe(unsubscribeRequestSchema)) body: UnsubscribeRequest,
  ): Promise<{ businessName: string }> {
    return this.campaigns.unsubscribe(body);
  }
}
