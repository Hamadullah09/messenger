import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { EmergencyEscalationService } from './emergency-escalation.service';
import { EmergencyQueryService } from './emergency-query.service';
import { EmergencyController } from './emergency.controller';
import { EmergencyService } from './emergency.service';

@Module({
  imports: [MessagingModule],
  controllers: [EmergencyController],
  providers: [EmergencyService, EmergencyQueryService, EmergencyEscalationService],
})
export class EmergencyModule {}
