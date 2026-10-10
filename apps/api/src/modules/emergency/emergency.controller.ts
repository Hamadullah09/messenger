import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  createIncidentRequestSchema,
  incidentReceiptRequestSchema,
  listIncidentsQuerySchema,
  resolveIncidentRequestSchema,
  updateEmergencySettingsRequestSchema,
  type CreateIncidentRequest,
  type CreateIncidentResponseDto,
  type EmergencySettingsDto,
  type IncidentDetailDto,
  type IncidentListItemDto,
  type IncidentReceiptRequest,
  type ListIncidentsQuery,
  type Page,
  type ResolveIncidentRequest,
  type UpdateEmergencySettingsRequest,
} from '@storeline/shared';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../../infra/http/zod';
import { CurrentActor, type Actor } from '../auth/actor';
import { EmergencyService } from './emergency.service';

@ApiTags('emergency')
@ApiBearerAuth()
@Controller({ path: 'emergency', version: '1' })
export class EmergencyController {
  constructor(private readonly emergency: EmergencyService) {}

  /** Stores where the caller can raise an alert (store picker when they work at several). */
  @Get('stores')
  stores(@CurrentActor() actor: Actor): Promise<Array<{ id: string; code: string; name: string }>> {
    return this.emergency.myStores(actor);
  }

  /** Raise an alert. Idempotent by clientIncidentId; re-opens an alert that is still active. */
  @Post('incidents')
  @ApiZodBody(createIncidentRequestSchema)
  create(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(createIncidentRequestSchema)) body: CreateIncidentRequest,
  ): Promise<CreateIncidentResponseDto> {
    return this.emergency.create(actor, body);
  }

  @Get('incidents')
  @ApiZodQuery(listIncidentsQuerySchema)
  list(
    @CurrentActor() actor: Actor,
    @Query(new ZodPipe(listIncidentsQuerySchema)) query: ListIncidentsQuery,
  ): Promise<Page<IncidentListItemDto>> {
    return this.emergency.list(actor, query);
  }

  @Get('incidents/:id')
  get(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<IncidentDetailDto> {
    return this.emergency.detail(actor, id);
  }

  @Post('incidents/:id/acknowledge')
  @HttpCode(200)
  acknowledge(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<IncidentDetailDto> {
    return this.emergency.acknowledge(actor, id);
  }

  @Post('incidents/:id/join')
  @HttpCode(200)
  join(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<IncidentDetailDto> {
    return this.emergency.join(actor, id);
  }

  @Post('incidents/:id/resolve')
  @HttpCode(200)
  @ApiZodBody(resolveIncidentRequestSchema)
  resolve(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(resolveIncidentRequestSchema)) body: ResolveIncidentRequest,
  ): Promise<IncidentDetailDto> {
    return this.emergency.resolve(actor, id, body.note);
  }

  @Post('incidents/:id/cancel')
  @HttpCode(200)
  cancel(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<IncidentDetailDto> {
    return this.emergency.cancel(actor, id);
  }

  /** The alerted device confirms delivery / that the alert was opened. */
  @Post('incidents/:id/receipt')
  @HttpCode(204)
  @ApiZodBody(incidentReceiptRequestSchema)
  async receipt(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(incidentReceiptRequestSchema)) body: IncidentReceiptRequest,
  ): Promise<void> {
    await this.emergency.receipt(actor, id, body.state);
  }

  @Get('stores/:storeId/settings')
  settings(
    @CurrentActor() actor: Actor,
    @Param('storeId', ParseUUIDPipe) storeId: string,
  ): Promise<EmergencySettingsDto> {
    return this.emergency.getSettings(actor, storeId);
  }

  @Put('stores/:storeId/settings')
  @ApiZodBody(updateEmergencySettingsRequestSchema)
  updateSettings(
    @CurrentActor() actor: Actor,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Body(new ZodPipe(updateEmergencySettingsRequestSchema)) body: UpdateEmergencySettingsRequest,
  ): Promise<EmergencySettingsDto> {
    return this.emergency.updateSettings(actor, storeId, body);
  }
}
