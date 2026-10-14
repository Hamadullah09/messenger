import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  submitToFbrRequestSchema,
  updateFbrSettingsRequestSchema,
  type FbrSettingsDto,
  type InvoiceDto,
  type SubmitToFbrRequest,
  type UpdateFbrSettingsRequest,
} from '@storeline/shared';
import { ApiZodBody, ZodPipe } from '../../infra/http/zod';
import { CurrentActor, type Actor } from '../auth/actor';
import { CrmService } from './crm.service';
import { FbrService } from './fbr.service';

/** FBR Digital Invoicing: the business's PRAL connection, and sending an invoice to FBR. */
@ApiTags('crm')
@ApiBearerAuth()
@Controller({ path: 'sales/crm', version: '1' })
export class FbrController {
  constructor(
    private readonly fbr: FbrService,
    private readonly crm: CrmService,
  ) {}

  @Get('fbr-settings')
  settings(@CurrentActor() actor: Actor): Promise<FbrSettingsDto | null> {
    return this.fbr.settings(actor);
  }

  @Put('fbr-settings')
  @ApiZodBody(updateFbrSettingsRequestSchema)
  update(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(updateFbrSettingsRequestSchema)) body: UpdateFbrSettingsRequest,
  ): Promise<FbrSettingsDto | null> {
    return this.fbr.updateSettings(actor, body);
  }

  @Post('invoices/:id/fbr')
  @HttpCode(200)
  @ApiZodBody(submitToFbrRequestSchema)
  async submit(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(submitToFbrRequestSchema)) body: SubmitToFbrRequest,
  ): Promise<InvoiceDto> {
    await this.fbr.submit(actor, id, body);
    return this.crm.getInvoice(actor, id);
  }
}
