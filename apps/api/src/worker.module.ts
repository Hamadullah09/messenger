import { Module } from '@nestjs/common';
import { CORE_IMPORTS } from './app.module';
import { MetricsModule } from './infra/metrics/metrics.module';
import { MalwareScanner } from './infra/scanning/malware-scanner';
import { PushGateway } from './modules/devices/push-gateway';
import { PushProcessor } from './modules/devices/push.processor';
import { CampaignDispatcher } from './modules/campaigns/campaign-dispatcher.service';
import { CampaignWorker } from './modules/campaigns/campaign-worker';
import { CustomerCampaignDispatcher } from './modules/customers/customer-campaign-dispatcher';
import { EmergencyEscalationService } from './modules/emergency/emergency-escalation.service';
import { EmergencyQueryService } from './modules/emergency/emergency-query.service';
import { EmergencySweeper } from './modules/emergency/emergency-sweeper';
import { MediaProcessor } from './modules/media/media.processor';
import { ConversationQueryService } from './modules/messaging/conversation-query.service';
import { MessageWriter } from './modules/messaging/message-writer.service';
import { DeliveryProcessor } from './modules/outbox/delivery.processor';
import { OutboxRelayService } from './modules/outbox/outbox-relay.service';

/**
 * Background worker process: outbox relay, delivery fan-out, media verification and emergency
 * escalation. No HTTP routes.
 */
@Module({
  imports: [...CORE_IMPORTS, MetricsModule.forRole('worker')],
  providers: [
    OutboxRelayService,
    DeliveryProcessor,
    ConversationQueryService,
    MediaProcessor,
    MalwareScanner,
    MessageWriter,
    EmergencyQueryService,
    EmergencyEscalationService,
    EmergencySweeper,
    CampaignDispatcher,
    CampaignWorker,
    CustomerCampaignDispatcher,
    PushGateway,
    PushProcessor,
  ],
  exports: [
    OutboxRelayService,
    DeliveryProcessor,
    MediaProcessor,
    EmergencyEscalationService,
    CampaignDispatcher,
    PushProcessor,
  ],
})
export class WorkerModule {}
