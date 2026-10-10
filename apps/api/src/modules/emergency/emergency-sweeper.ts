import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../infra/config/config';
import { EmergencyEscalationService } from './emergency-escalation.service';

/**
 * Worker-only timer that escalates unacknowledged alerts. Safe to run in several worker
 * replicas: each incident row is locked with SKIP LOCKED and updated conditionally.
 */
@Injectable()
export class EmergencySweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(EmergencySweeper.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly escalation: EmergencyEscalationService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), this.config.EMERGENCY_SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const escalated = await this.escalation.sweepOnce();
      if (escalated > 0)
        this.logger.warn({ escalated }, 'Escalated unacknowledged emergency alerts');
    } catch (error) {
      this.logger.error({ err: error }, 'Emergency sweep failed');
    } finally {
      this.running = false;
    }
  }
}
