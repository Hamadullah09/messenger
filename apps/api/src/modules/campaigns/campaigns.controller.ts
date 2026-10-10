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
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  createCampaignRequestSchema,
  listCampaignRecipientsQuerySchema,
  paginationQuerySchema,
  scheduleCampaignRequestSchema,
  sendCampaignRequestSchema,
  suppressionRequestSchema,
  updateCampaignRequestSchema,
  type CampaignDto,
  type CampaignPreviewDto,
  type CampaignRecipientDto,
  type CampaignSuppressionDto,
  type CreateCampaignRequest,
  type ListCampaignRecipientsQuery,
  type Page,
  type PaginationQuery,
  type ScheduleCampaignRequest,
  type SendCampaignRequest,
  type SuppressionRequest,
  type UpdateCampaignRequest,
} from '@storeline/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../../infra/http/zod';
import { CurrentActor, type Actor } from '../auth/actor';
import { CampaignsService } from './campaigns.service';

const optOutRequestSchema = z.object({ optOut: z.boolean() });

@ApiTags('campaigns')
@ApiBearerAuth()
@Controller({ path: 'campaigns', version: '1' })
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  /** Creates a draft. Idempotent by clientCampaignId. */
  @Post()
  @ApiZodBody(createCampaignRequestSchema)
  create(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(createCampaignRequestSchema)) body: CreateCampaignRequest,
  ): Promise<CampaignDto> {
    return this.campaigns.create(actor, body);
  }

  @Get(':id')
  get(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string): Promise<CampaignDto> {
    return this.campaigns.get(actor, id);
  }

  @Patch(':id')
  @ApiZodBody(updateCampaignRequestSchema)
  update(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateCampaignRequestSchema)) body: UpdateCampaignRequest,
  ): Promise<CampaignDto> {
    return this.campaigns.update(actor, id, body);
  }

  /** Recipient counts only — never the list of people. */
  @Get(':id/preview')
  preview(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CampaignPreviewDto> {
    return this.campaigns.preview(actor, id);
  }

  @Post(':id/send')
  @HttpCode(200)
  @ApiZodBody(sendCampaignRequestSchema)
  send(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(sendCampaignRequestSchema)) body: SendCampaignRequest,
  ): Promise<CampaignDto> {
    return this.campaigns.send(actor, id, body);
  }

  @Post(':id/schedule')
  @HttpCode(200)
  @ApiZodBody(scheduleCampaignRequestSchema)
  schedule(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(scheduleCampaignRequestSchema)) body: ScheduleCampaignRequest,
  ): Promise<CampaignDto> {
    return this.campaigns.schedule(actor, id, body);
  }

  @Post(':id/unschedule')
  @HttpCode(200)
  unschedule(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.unschedule(actor, id);
  }

  @Post(':id/pause')
  @HttpCode(200)
  pause(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.pause(actor, id);
  }

  @Post(':id/resume')
  @HttpCode(200)
  resume(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.resume(actor, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.cancel(actor, id);
  }

  @Post(':id/retry-failed')
  @HttpCode(200)
  retry(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.retryFailed(actor, id);
  }

  @Get(':id/recipients')
  @ApiZodQuery(listCampaignRecipientsQuerySchema)
  recipients(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(listCampaignRecipientsQuerySchema)) query: ListCampaignRecipientsQuery,
  ): Promise<Page<CampaignRecipientDto>> {
    return this.campaigns.recipients(actor, id, query);
  }

  /** Delivery report as CSV (requires report.export; audited). */
  @Get(':id/report.csv')
  async report(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const chunks: string[] = [];
    const fileName = await this.campaigns.exportCsv(actor, id, (chunk) => chunks.push(chunk));
    res
      .status(200)
      .set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Cache-Control': 'no-store',
      })
      .send('﻿' + chunks.join(''));
  }
}

@ApiTags('campaigns')
@ApiBearerAuth()
@Controller({ path: 'businesses/:businessId', version: '1' })
export class BusinessCampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get('campaigns')
  @ApiZodQuery(paginationQuerySchema)
  list(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Query(new ZodPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<Page<CampaignDto>> {
    return this.campaigns.list(actor, businessId, query);
  }

  @Get('campaign-suppressions')
  suppressions(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
  ): Promise<CampaignSuppressionDto[]> {
    return this.campaigns.listSuppressions(actor, businessId);
  }

  @Post('campaign-suppressions')
  @HttpCode(204)
  @ApiZodBody(suppressionRequestSchema)
  async suppress(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Body(new ZodPipe(suppressionRequestSchema)) body: SuppressionRequest,
  ): Promise<void> {
    await this.campaigns.suppress(actor, businessId, body.userId);
  }

  @Delete('campaign-suppressions/:userId')
  @HttpCode(204)
  async unsuppress(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    await this.campaigns.unsuppress(actor, businessId, userId);
  }

  /** The caller's own announcement preference (customers can opt out). */
  @Get('announcements/opt-out')
  optOutStatus(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
  ) {
    return this.campaigns.optOutStatus(actor, businessId);
  }

  @Put('announcements/opt-out')
  @ApiZodBody(optOutRequestSchema)
  setOptOut(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Body(new ZodPipe(optOutRequestSchema)) body: z.infer<typeof optOutRequestSchema>,
  ) {
    return this.campaigns.setOptOut(actor, businessId, body.optOut);
  }
}
