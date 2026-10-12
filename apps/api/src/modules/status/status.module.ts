import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  createStatusRequestSchema,
  type CreateStatusRequest,
  type StatusFeedDto,
  type StatusPostDto,
  type StatusViewerDto,
} from '@storeline/shared';
import { z } from 'zod';
import { ApiZodBody, ZodPipe } from '../../infra/http/zod';
import { CurrentActor, type Actor } from '../auth/actor';
import { StatusService } from './status.service';

const feedQuerySchema = z.object({ businessId: z.uuid().optional() });

@ApiTags('status')
@ApiBearerAuth()
@Controller({ path: 'status', version: '1' })
export class StatusController {
  constructor(private readonly status: StatusService) {}

  @Get()
  feed(
    @CurrentActor() actor: Actor,
    @Query(new ZodPipe(feedQuerySchema)) query: z.infer<typeof feedQuerySchema>,
  ): Promise<StatusFeedDto> {
    return this.status.feed(actor, query.businessId);
  }

  @Post()
  @ApiZodBody(createStatusRequestSchema)
  create(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(createStatusRequestSchema)) body: CreateStatusRequest,
  ): Promise<StatusPostDto> {
    return this.status.create(actor, body);
  }

  @Post(':id/view')
  @HttpCode(204)
  async view(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.status.view(actor, id);
  }

  @Get(':id/viewers')
  viewers(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StatusViewerDto[]> {
    return this.status.viewers(actor, id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.status.remove(actor, id);
  }
}

@Module({
  controllers: [StatusController],
  providers: [StatusService],
})
export class StatusModule {}
