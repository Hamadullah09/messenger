import {
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  startCallRequestSchema,
  type CallConfigDto,
  type SfuTokenDto,
  type CallDto,
  type CallLogEntryDto,
  type StartCallRequest,
} from '@storeline/shared';
import { z } from 'zod';
import { ApiZodBody, ZodPipe } from '../../infra/http/zod';
import { CurrentActor, type Actor } from '../auth/actor';
import { MessagingModule } from '../messaging/messaging.module';
import { CallsService } from './calls.service';

const endCallSchema = z.object({
  reason: z.enum(['hangup', 'timeout', 'failed']).default('hangup'),
});

@ApiTags('calls')
@ApiBearerAuth()
@Controller({ path: 'calls', version: '1' })
export class CallsController {
  constructor(private readonly calls: CallsService) {}

  @Get('config')
  config(@CurrentActor() actor: Actor): CallConfigDto {
    return this.calls.configFor(actor);
  }

  /** Big group calls (LiveKit): the room address and this person's token. */
  @Post(':id/sfu-token')
  @HttpCode(200)
  sfuToken(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SfuTokenDto> {
    return this.calls.sfuToken(actor, id);
  }

  @Get('log')
  log(@CurrentActor() actor: Actor): Promise<CallLogEntryDto[]> {
    return this.calls.log(actor);
  }

  @Post()
  @ApiZodBody(startCallRequestSchema)
  start(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(startCallRequestSchema)) body: StartCallRequest,
  ): Promise<CallDto> {
    return this.calls.start(actor, body);
  }

  /** Group calls: join a running call. */
  @Post(':id/join')
  @HttpCode(200)
  join(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string): Promise<CallDto> {
    return this.calls.join(actor, id);
  }

  @Post(':id/accept')
  @HttpCode(200)
  accept(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string): Promise<CallDto> {
    return this.calls.accept(actor, id);
  }

  @Post(':id/decline')
  @HttpCode(200)
  decline(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string): Promise<CallDto> {
    return this.calls.decline(actor, id);
  }

  @Post(':id/end')
  @HttpCode(200)
  @ApiZodBody(endCallSchema)
  end(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(endCallSchema)) body: z.infer<typeof endCallSchema>,
  ): Promise<CallDto> {
    return this.calls.end(actor, id, body.reason);
  }
}

@Module({
  imports: [MessagingModule],
  controllers: [CallsController],
  providers: [CallsService],
  exports: [CallsService],
})
export class CallsModule {}
