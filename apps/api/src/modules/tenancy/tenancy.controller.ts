import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  createBusinessRequestSchema,
  createStoreRequestSchema,
  paginationQuerySchema,
  updateBusinessRequestSchema,
  updateStoreRequestSchema,
  type BusinessDto,
  type CreateBusinessRequest,
  type CreateStoreRequest,
  type Page,
  type PaginationQuery,
  type StoreDto,
  type UpdateBusinessRequest,
  type UpdateStoreRequest,
} from '@storeline/shared';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../../infra/http/zod';
import { CurrentActor, type Actor } from '../auth/actor';
import { BusinessesService } from './businesses.service';
import { StoresService } from './stores.service';

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

  @Post(':id/archive')
  @HttpCode(200)
  archive(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string): Promise<StoreDto> {
    return this.stores.archive(actor, id);
  }
}
