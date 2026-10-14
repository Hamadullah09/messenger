import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  setBusinessPlanRequestSchema,
  type BusinessBillingDto,
  type SetBusinessPlanRequest,
  type SmaPlanOptionDto,
} from '@storeline/shared';
import { ApiZodBody, ZodPipe } from '../../infra/http/zod';
import { CurrentActor, type Actor } from '../auth/actor';
import { SmaBillingService } from './sma-billing.service';

/** SMA plans: the Super Admin sets them; business owners and admins see theirs. */
@ApiTags('billing')
@ApiBearerAuth()
@Controller({ version: '1' })
export class SmaBillingController {
  constructor(private readonly billing: SmaBillingService) {}

  @Get('platform/sma-plans')
  plans(@CurrentActor() actor: Actor): Promise<SmaPlanOptionDto[]> {
    return this.billing.options(actor);
  }

  @Get('businesses/:businessId/billing')
  get(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
  ): Promise<BusinessBillingDto> {
    return this.billing.billing(actor, businessId);
  }

  @Put('businesses/:businessId/plan')
  @ApiZodBody(setBusinessPlanRequestSchema)
  setPlan(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Body(new ZodPipe(setBusinessPlanRequestSchema)) body: SetBusinessPlanRequest,
  ): Promise<BusinessBillingDto> {
    return this.billing.setPlan(actor, businessId, body);
  }
}
