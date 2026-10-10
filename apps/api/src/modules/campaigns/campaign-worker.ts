import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../infra/config/config';
import { CampaignDispatcher } from './campaign-dispatcher.service';

/** Worker-only timer that drives campaign dispatch rounds (safe with several replicas). */
@Injectable()
export class CampaignWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CampaignWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly dispatcher: CampaignDispatcher,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), this.config.CAMPAIGN_DISPATCH_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.dispatcher.runOnce();
    } catch (error) {
      this.logger.error({ err: error }, 'Campaign dispatch round failed');
    } finally {
      this.running = false;
    }
  }
}
