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
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  addLeadActivityRequestSchema,
  assignLeadRequestSchema,
  changeLeadStageRequestSchema,
  convertLeadRequestSchema,
  createLeadRequestSchema,
  createSalesUserRequestSchema,
  listLeadsQuerySchema,
  publicLeadRequestSchema,
  updateLeadRequestSchema,
  type AddLeadActivityRequest,
  type AssignLeadRequest,
  type ChangeLeadStageRequest,
  type ConvertLeadRequest,
  type CreateLeadRequest,
  type CreateSalesUserRequest,
  type LeadDetailDto,
  type LeadDto,
  type ListLeadsQuery,
  type PublicLeadRequest,
  type SalesContextDto,
  type SalesOverviewDto,
  type SalesUserDto,
  type UpdateLeadRequest,
} from '@storeline/shared';
import type { Request, Response } from 'express';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../../infra/http/zod';
import { CurrentActor, Public, type Actor } from '../auth/actor';
import { SalesService } from './sales.service';

@ApiTags('sales')
@ApiBearerAuth()
@Controller({ path: 'sales', version: '1' })
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Get('context')
  context(@CurrentActor() actor: Actor): Promise<SalesContextDto> {
    return this.sales.context(actor);
  }

  @Get('overview')
  overview(@CurrentActor() actor: Actor): Promise<SalesOverviewDto> {
    return this.sales.overview(actor);
  }

  @Get('leads')
  @ApiZodQuery(listLeadsQuerySchema)
  list(
    @CurrentActor() actor: Actor,
    @Query(new ZodPipe(listLeadsQuerySchema)) query: ListLeadsQuery,
  ): Promise<LeadDto[]> {
    return this.sales.list(actor, query);
  }

  @Post('leads')
  @ApiZodBody(createLeadRequestSchema)
  create(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(createLeadRequestSchema)) body: CreateLeadRequest,
  ): Promise<LeadDetailDto> {
    return this.sales.create(actor, body);
  }

  @Get('leads/:id')
  get(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LeadDetailDto> {
    return this.sales.get(actor, id);
  }

  @Patch('leads/:id')
  @ApiZodBody(updateLeadRequestSchema)
  update(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateLeadRequestSchema)) body: UpdateLeadRequest,
  ): Promise<LeadDetailDto> {
    return this.sales.update(actor, id, body);
  }

  @Put('leads/:id/stage')
  @ApiZodBody(changeLeadStageRequestSchema)
  stage(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(changeLeadStageRequestSchema)) body: ChangeLeadStageRequest,
  ): Promise<LeadDetailDto> {
    return this.sales.changeStage(actor, id, body);
  }

  @Put('leads/:id/owner')
  @ApiZodBody(assignLeadRequestSchema)
  assign(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(assignLeadRequestSchema)) body: AssignLeadRequest,
  ): Promise<LeadDetailDto> {
    return this.sales.assign(actor, id, body.ownerId);
  }

  @Post('leads/:id/claim')
  @HttpCode(200)
  claim(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LeadDetailDto> {
    return this.sales.claim(actor, id);
  }

  @Post('leads/:id/activities')
  @ApiZodBody(addLeadActivityRequestSchema)
  addActivity(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(addLeadActivityRequestSchema)) body: AddLeadActivityRequest,
  ): Promise<LeadDetailDto> {
    return this.sales.addActivity(actor, id, body);
  }

  @Post('leads/:id/convert')
  @ApiZodBody(convertLeadRequestSchema)
  convert(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(convertLeadRequestSchema)) body: ConvertLeadRequest,
  ): Promise<LeadDetailDto> {
    return this.sales.convert(actor, id, body);
  }

  @Delete('leads/:id')
  @HttpCode(204)
  async remove(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.sales.remove(actor, id);
  }

  /** CSV of all leads, or `?customers=true` for SMA customers only. */
  @Get('leads-export.csv')
  async export(
    @CurrentActor() actor: Actor,
    @Query('customers') customers: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const onlyCustomers = customers === 'true';
    const csv = await this.sales.exportCsv(actor, onlyCustomers);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${onlyCustomers ? 'sma-customers' : 'sma-leads'}.csv"`,
    );
    return '\uFEFF' + csv;
  }

  @Get('team')
  team(@CurrentActor() actor: Actor): Promise<SalesUserDto[]> {
    return this.sales.teamMembers(actor);
  }

  @Post('team')
  @ApiZodBody(createSalesUserRequestSchema)
  addTeamMember(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(createSalesUserRequestSchema)) body: CreateSalesUserRequest,
  ): Promise<SalesUserDto[]> {
    return this.sales.addTeamMember(actor, body);
  }
}

/** The website's "Request a demo" form. No sign-in; rate limited per IP. */
@ApiTags('sales')
@Controller({ path: 'public/leads', version: '1' })
export class PublicLeadsController {
  constructor(
    private readonly sales: SalesService,
    @Inject(CryptoService) private readonly crypto: CryptoService,
  ) {}

  @Public()
  @Post()
  @HttpCode(202)
  @ApiZodBody(publicLeadRequestSchema)
  async submit(
    @Body(new ZodPipe(publicLeadRequestSchema)) body: PublicLeadRequest,
    @Req() req: Request,
  ): Promise<{ received: true }> {
    const ip = req.ip ?? 'unknown';
    await this.sales.publicLead(body, {
      ip,
      ipHash: this.crypto.keyedHash(ip),
      userAgent: null,
      requestId: null,
    });
    return { received: true };
  }
}
