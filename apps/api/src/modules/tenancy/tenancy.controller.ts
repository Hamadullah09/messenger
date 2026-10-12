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
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  createBusinessRequestSchema,
  createStoreRequestSchema,
  paginationQuerySchema,
  updateBusinessRequestSchema,
  updateStoreRequestSchema,
  type BusinessDto,
  type BusinessGroupDto,
  type CreateBusinessRequest,
  type CreateStoreRequest,
  type Page,
  type PaginationQuery,
  type StoreDto,
  type UpdateBusinessRequest,
  type UpdateStoreRequest,
} from '@storeline/shared';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../../infra/http/zod';
import type { Request, Response } from 'express';
import { ApiError } from '../../infra/http/api-error';
import { CurrentActor, Public, type Actor } from '../auth/actor';
import { BusinessesService } from './businesses.service';
import { StoresService } from './stores.service';

/** Logos are re-encoded WebP; immutable per version (the URL carries ?v=<updatedAt>). */
function sendLogo(res: Response, logo: Buffer | null): void {
  if (!logo) throw ApiError.notFound('Logo');
  res.setHeader('Content-Type', 'image/webp');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.end(logo);
}

@ApiTags('businesses')
@ApiBearerAuth()
@Controller({ path: 'businesses', version: '1' })
export class BusinessesController {
  constructor(
    private readonly businesses: BusinessesService,
    private readonly stores: StoresService,
  ) {}

  @Get()
  @ApiZodQuery(paginationQuerySchema)
  list(
    @CurrentActor() actor: Actor,
    @Query(new ZodPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<Page<BusinessDto>> {
    return this.businesses.list(actor, query);
  }

  @Post()
  @ApiZodBody(createBusinessRequestSchema)
  create(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(createBusinessRequestSchema)) body: CreateBusinessRequest,
  ): Promise<BusinessDto> {
    return this.businesses.create(actor, body);
  }

  @Get(':id')
  get(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string): Promise<BusinessDto> {
    return this.businesses.get(actor, id);
  }

  @Patch(':id')
  @ApiZodBody(updateBusinessRequestSchema)
  update(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateBusinessRequestSchema)) body: UpdateBusinessRequest,
  ): Promise<BusinessDto> {
    return this.businesses.update(actor, id, body);
  }

  /** Delete a business (Super Admin). */
  @Delete(':id')
  @HttpCode(204)
  async delete(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.businesses.delete(actor, id);
  }

  @Post(':id/suspend')
  @HttpCode(200)
  suspend(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BusinessDto> {
    return this.businesses.setStatus(actor, id, 'SUSPENDED');
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  reactivate(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BusinessDto> {
    return this.businesses.setStatus(actor, id, 'ACTIVE');
  }

  @Post(':id/archive')
  @HttpCode(200)
  archive(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BusinessDto> {
    return this.businesses.setStatus(actor, id, 'ARCHIVED');
  }

  /** Upload a logo: the request body is the image itself (PNG, JPEG or WebP, up to 2 MB). */
  @Put(':id/logo')
  setLogo(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<BusinessDto> {
    return this.businesses.setLogo(actor, id, req.body);
  }

  @Delete(':id/logo')
  removeLogo(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BusinessDto> {
    return this.businesses.setLogo(actor, id, null);
  }

  @Public()
  @Get(':id/logo')
  async logo(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    sendLogo(res, await this.businesses.logo(id));
  }

  @Get(':id/groups')
  groups(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BusinessGroupDto[]> {
    return this.businesses.listGroups(actor, id);
  }

  @Get(':id/stores')
  listStores(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('includeArchived') includeArchived?: string,
  ): Promise<StoreDto[]> {
    return this.stores.list(actor, id, includeArchived === 'true');
  }

  @Post(':id/stores')
  @ApiZodBody(createStoreRequestSchema)
  createStore(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(createStoreRequestSchema)) body: CreateStoreRequest,
  ): Promise<StoreDto> {
    return this.stores.create(actor, id, body);
  }
}

@ApiTags('stores')
@ApiBearerAuth()
@Controller({ path: 'stores', version: '1' })
export class StoresController {
  constructor(private readonly stores: StoresService) {}

  @Get(':id')
  get(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string): Promise<StoreDto> {
    return this.stores.get(actor, id);
  }

  @Patch(':id')
  @ApiZodBody(updateStoreRequestSchema)
  update(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateStoreRequestSchema)) body: UpdateStoreRequest,
  ): Promise<StoreDto> {
    return this.stores.update(actor, id, body);
  }

  @Put(':id/logo')
  setLogo(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<StoreDto> {
    return this.stores.setLogo(actor, id, req.body);
  }

  @Delete(':id/logo')
  removeLogo(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StoreDto> {
    return this.stores.setLogo(actor, id, null);
  }

  @Public()
  @Get(':id/logo')
  async logo(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    sendLogo(res, await this.stores.logo(id));
  }

  /** Delete a store. */
  @Delete(':id')
  @HttpCode(204)
  async delete(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.stores.delete(actor, id);
  }

  @Post(':id/archive')
  @HttpCode(200)
  archive(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string): Promise<StoreDto> {
    return this.stores.archive(actor, id);
  }
}
