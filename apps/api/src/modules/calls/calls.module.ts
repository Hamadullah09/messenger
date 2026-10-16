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
import { CurrentActor, Public, type Actor } from '../auth/actor';
import { MessagingModule } from '../messaging/messaging.module';
import { CallsService } from './calls.service';

const ringSchema = z.object({ userIds: z.array(z.uuid()).min(1).max(50) });
const notificationDeclineSchema = z.object({
  userId: z.uuid(),
  token: z.string().min(16).max(128),
});
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

  /** Group calls: ring people who are not in the call. */
  @Post(':id/ring')
  @HttpCode(200)
  @ApiZodBody(ringSchema)
  ring(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ringSchema)) body: z.infer<typeof ringSchema>,
  ): Promise<CallDto> {
    return this.calls.ring(actor, id, body.userIds);
  }

  /** A call ringing for me right now (the app asks after it reconnects or reloads). */
  @Get('incoming')
  incoming(@CurrentActor() actor: Actor): Promise<{ call: CallDto | null }> {
    return this.calls.incoming(actor);
  }

  /** "Still in the call", every 10 s from each device in it; abandoned calls end by themselves. */
  @Post(':id/alive')
  @HttpCode(200)
  alive(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ state: 'ringing' | 'active' | 'ended' }> {
    return this.calls.alive(actor, id);
  }

  @Get('log')
  log(@CurrentActor() actor: Actor): Promise<CallLogEntryDto[]> {
    return this.calls.log(actor);
  }

  /** One call this person is part of (opened from a "calling" notification). */
  @Get(':id')
  get(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string): Promise<CallDto> {
    return this.calls.get(actor, id);
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

/** The Decline button on a phone's "calling" notification (no signed-in session there). */
@ApiTags('calls')
@Controller({ path: 'public/calls', version: '1' })
export class PublicCallsController {
  constructor(private readonly calls: CallsService) {}

  @Public()
  @Post(':id/decline')
  @HttpCode(204)
  @ApiZodBody(notificationDeclineSchema)
  async decline(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(notificationDeclineSchema)) body: z.infer<typeof notificationDeclineSchema>,
  ): Promise<void> {
    await this.calls.declineWithToken(id, body.userId, body.token);
  }
}

@Module({
  imports: [MessagingModule],
  controllers: [CallsController, PublicCallsController],
  providers: [CallsService],
  exports: [CallsService],
})
export class CallsModule {}
