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
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  createBroadcastListRequestSchema,
  updateBroadcastListRequestSchema,
  type BroadcastListDto,
  type CreateBroadcastListRequest,
  type UpdateBroadcastListRequest,
} from '@storeline/shared';
import { ApiZodBody, ZodPipe } from '../../infra/http/zod';
import { CurrentActor, type Actor } from '../auth/actor';
import { BroadcastService } from './broadcast.service';

/** Broadcast lists. Messages are sent with the normal send endpoint on the list's chat. */
@ApiTags('messaging')
@ApiBearerAuth()
@Controller({ path: 'broadcast-lists', version: '1' })
export class BroadcastListsController {
  constructor(private readonly broadcast: BroadcastService) {}

  @Post()
  @ApiZodBody(createBroadcastListRequestSchema)
  create(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(createBroadcastListRequestSchema)) body: CreateBroadcastListRequest,
  ): Promise<BroadcastListDto> {
    return this.broadcast.create(actor, body);
  }

  @Get(':id')
  get(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BroadcastListDto> {
    return this.broadcast.get(actor, id);
  }

  @Patch(':id')
  @ApiZodBody(updateBroadcastListRequestSchema)
  update(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateBroadcastListRequestSchema)) body: UpdateBroadcastListRequest,
  ): Promise<BroadcastListDto> {
    return this.broadcast.update(actor, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.broadcast.remove(actor, id);
  }
}
