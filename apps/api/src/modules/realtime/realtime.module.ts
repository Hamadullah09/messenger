import { Controller, Get, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { PresenceDto } from '@storeline/shared';
import { z } from 'zod';
import { ZodPipe } from '../../infra/http/zod';
import { CurrentActor, type Actor } from '../auth/actor';
import { AuthModule } from '../auth/auth.module';
import { CallsModule } from '../calls/calls.module';
import { MessagingModule } from '../messaging/messaging.module';
import { PresenceService } from './presence.service';
import { RealtimeGateway } from './realtime.gateway';

const presenceQuerySchema = z.object({
  userIds: z
    .string()
    .transform((v) => v.split(',').filter(Boolean))
    .pipe(z.array(z.uuid()).min(1).max(100)),
});

@ApiTags('presence')
@ApiBearerAuth()
@Controller({ path: 'presence', version: '1' })
export class PresenceController {
  constructor(private readonly presence: PresenceService) {}

  @Get()
  lookup(
    @CurrentActor() actor: Actor,
    @Query(new ZodPipe(presenceQuerySchema)) query: z.infer<typeof presenceQuerySchema>,
  ): Promise<PresenceDto[]> {
    return this.presence.lookup(actor.userId, query.userIds);
  }
}

@Module({
  imports: [AuthModule, MessagingModule, CallsModule],
  controllers: [PresenceController],
  providers: [RealtimeGateway, PresenceService],
})
export class RealtimeModule {}
