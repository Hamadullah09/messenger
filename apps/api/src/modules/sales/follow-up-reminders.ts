import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { resolveBusinessPolicy, type FollowUpKind, type PushPayload } from '@storeline/shared';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { PushProcessor } from '../devices/push.processor';
import { RealtimeEmitter } from '../realtime/realtime-emitter.service';

const EVERY_MS = 60_000;
/** How long before a planned follow-up its owner is reminded. */
export const REMIND_BEFORE_MINUTES = 15;

const KIND_LABEL: Record<FollowUpKind, string> = {
  MEETING: 'Meeting',
  CALL: 'Call',
  VISIT: 'Visit',
  WHATSAPP: 'WhatsApp follow-up',
  EMAIL: 'Email follow-up',
  OTHER: 'Follow-up',
};

/**
 * Worker: 15 minutes before a planned meeting, call or other follow-up with a lead, reminds the
 * lead's owner on their phone (push) and in the open app. Each planned time is reminded once;
 * moving the follow-up to a new time gives a new reminder. Missed ones (worker down) are not
 * sent late.
 */
@Injectable()
export class FollowUpReminders implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(FollowUpReminders.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushProcessor,
    private readonly realtime: RealtimeEmitter,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.run(), EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async run(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let reminded = 0;
    try {
      const now = new Date();
      const soon = new Date(now.getTime() + REMIND_BEFORE_MINUTES * 60_000);
      const due = await this.prisma.lead.findMany({
        where: {
          deletedAt: null,
          stage: { not: 'LOST' },
          ownerId: { not: null },
          nextFollowUpAt: { gt: now, lte: soon },
        },
        select: {
          id: true,
          ownerId: true,
          companyName: true,
          contactName: true,
          phone: true,
          nextFollowUpAt: true,
          nextFollowUpKind: true,
          nextFollowUpNote: true,
          followUpRemindedFor: true,
          tenant: { select: { policy: true } },
        },
        take: 500,
      });
      for (const lead of due) {
        const at = lead.nextFollowUpAt!;
        if (lead.followUpRemindedFor?.getTime() === at.getTime()) continue;
        // Claim it: only one worker round (or instance) reminds this planned time.
        const claimed = await this.prisma.lead.updateMany({
          where: { id: lead.id, nextFollowUpAt: at, followUpRemindedFor: lead.followUpRemindedFor },
          data: { followUpRemindedFor: at },
        });
        if (claimed.count === 0) continue;
        await this.notify(lead, at, now);
        reminded += 1;
      }
      if (reminded > 0) this.logger.log({ reminded }, 'Follow-up reminders sent');
    } catch (error) {
      this.logger.error({ err: error }, 'Follow-up reminders failed');
    } finally {
      this.running = false;
    }
    return reminded;
  }

  private async notify(
    lead: {
      id: string;
      ownerId: string | null;
      companyName: string;
      contactName: string;
      phone: string | null;
      nextFollowUpKind: FollowUpKind | null;
      nextFollowUpNote: string | null;
      tenant: { policy: unknown };
    },
    at: Date,
    now: Date,
  ): Promise<void> {
    const ownerId = lead.ownerId!;
    this.realtime.toUsers([ownerId], 'sales.reminder', {
      leadId: lead.id,
      companyName: lead.companyName,
      contactName: lead.contactName,
      phone: lead.phone,
      kind: lead.nextFollowUpKind,
      note: lead.nextFollowUpNote,
      at: at.toISOString(),
    });
    const minutes = Math.max(1, Math.round((at.getTime() - now.getTime()) / 60_000));
    const title = `${KIND_LABEL[lead.nextFollowUpKind ?? 'OTHER']} in ${minutes} min`;
    const contentAllowed = resolveBusinessPolicy(lead.tenant.policy).pushContentAllowed;
    const details = [lead.companyName, lead.contactName, lead.nextFollowUpNote].filter(Boolean).join(' · ');
    try {
      await this.push.reminder([ownerId], (preview): PushPayload => ({
        type: 'reminder',
        // Lock-screen privacy: who it is with only as far as the person and business allow.
        title,
        body:
          preview === 'CONTENT' && contentAllowed
            ? details
            : preview === 'NONE'
              ? 'Open SMA to see who it is with'
              : lead.companyName,
        url: `/sales?tab=today&lead=${lead.id}`,
        leadId: lead.id,
        tag: `r-${lead.id.slice(0, 8)}`,
      }));
    } catch (error) {
      this.logger.warn({ err: error, leadId: lead.id }, 'Reminder push failed');
    }
  }
}
