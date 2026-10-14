import { randomBytes } from 'node:crypto';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { StorageService } from '../../infra/storage/storage.service';

const EVERY_MS = 6 * 3600_000;
/** Days between deleting a business and erasing its data for good (time to change one's mind). */
export const PURGE_AFTER_DAYS = 30;

/**
 * Worker: permanently erases a deleted business's data 30 days after it was deleted —
 * messages, files, customers, campaigns, store work, its own CRM, roles and stores — and
 * anonymises people who belonged to no other business. Kept: the business row as a tombstone
 * (SMA's own invoices to it point at it) and the audit log (security record).
 */
@Injectable()
export class BusinessPurger implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(BusinessPurger.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.runOnce(), EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let purged = 0;
    try {
      const due = await this.prisma.business.findMany({
        where: {
          internal: false,
          purgedAt: null,
          deletedAt: { lt: new Date(Date.now() - PURGE_AFTER_DAYS * 86_400_000) },
        },
        select: { id: true },
        take: 5,
      });
      for (const b of due) {
        try {
          await this.purge(b.id);
          purged += 1;
        } catch (error) {
          this.logger.error({ err: error, businessId: b.id }, 'Business purge failed');
        }
      }
    } finally {
      this.running = false;
    }
    return purged;
  }

  /** Erases one deleted business's data (all or nothing for the database part). */
  async purge(businessId: string): Promise<void> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { deletedAt: true, internal: true, purgedAt: true },
    });
    if (!business?.deletedAt || business.internal || business.purgedAt) return;
    const files = await this.prisma.mediaAsset.findMany({
      where: { businessId },
      select: { incomingKey: true, objectKey: true, thumbnailKey: true },
    });
    const members = await this.prisma.businessMembership.findMany({
      where: { businessId },
      select: { userId: true },
    });

    await this.prisma.$transaction(
      async (tx) => {
        const B = businessId;
        // Chats: break the last-message links, then messages (their children cascade), members.
        await tx.$executeRaw`UPDATE "Conversation" SET "lastMessageId" = NULL WHERE "businessId" = ${B}::uuid`;
        await tx.$executeRaw`DELETE FROM "PinnedMessage" WHERE "conversationId" IN (SELECT "id" FROM "Conversation" WHERE "businessId" = ${B}::uuid)`;
        await tx.$executeRaw`DELETE FROM "Message" WHERE "conversationId" IN (SELECT "id" FROM "Conversation" WHERE "businessId" = ${B}::uuid)`;
        await tx.$executeRaw`DELETE FROM "ConversationMember" WHERE "conversationId" IN (SELECT "id" FROM "Conversation" WHERE "businessId" = ${B}::uuid)`;
        // Emergencies.
        await tx.$executeRaw`DELETE FROM "EmergencyIncidentEvent" WHERE "incidentId" IN (SELECT "id" FROM "EmergencyIncident" WHERE "businessId" = ${B}::uuid)`;
        await tx.$executeRaw`DELETE FROM "EmergencyIncidentRecipient" WHERE "incidentId" IN (SELECT "id" FROM "EmergencyIncident" WHERE "businessId" = ${B}::uuid)`;
        await tx.$executeRaw`DELETE FROM "EmergencyIncident" WHERE "businessId" = ${B}::uuid`;
        await tx.$executeRaw`DELETE FROM "EmergencyContact" WHERE "businessId" = ${B}::uuid`;
        // Status updates, staff campaigns (break the campaign ↔ file loop first).
        await tx.$executeRaw`DELETE FROM "StatusPost" WHERE "businessId" = ${B}::uuid`;
        await tx.$executeRaw`UPDATE "BulkCampaign" SET "mediaId" = NULL WHERE "businessId" = ${B}::uuid`;
        await tx.$executeRaw`UPDATE "MediaAsset" SET "campaignId" = NULL WHERE "businessId" = ${B}::uuid`;
        await tx.$executeRaw`DELETE FROM "BulkCampaignRecipient" WHERE "campaignId" IN (SELECT "id" FROM "BulkCampaign" WHERE "businessId" = ${B}::uuid)`;
        await tx.$executeRaw`DELETE FROM "BulkCampaign" WHERE "businessId" = ${B}::uuid`;
        await tx.$executeRaw`DELETE FROM "CampaignSuppression" WHERE "businessId" = ${B}::uuid`;
        // Store work.
        await tx.$executeRaw`DELETE FROM "ChecklistRun" WHERE "businessId" = ${B}::uuid`;
        await tx.$executeRaw`DELETE FROM "ChecklistTemplate" WHERE "businessId" = ${B}::uuid`;
        await tx.$executeRaw`DELETE FROM "AttendanceRecord" WHERE "businessId" = ${B}::uuid`;
        await tx.$executeRaw`DELETE FROM "LeaveRequest" WHERE "businessId" = ${B}::uuid`;
        await tx.$executeRaw`DELETE FROM "Shift" WHERE "businessId" = ${B}::uuid`;
        await tx.$executeRaw`DELETE FROM "StoreTask" WHERE "businessId" = ${B}::uuid`;
        // Files, then the chats themselves.
        await tx.$executeRaw`DELETE FROM "MediaAsset" WHERE "businessId" = ${B}::uuid`;
        await tx.$executeRaw`DELETE FROM "Conversation" WHERE "businessId" = ${B}::uuid`;
        // Store customers and their campaigns.
        await tx.$executeRaw`DELETE FROM "CustomerCampaign" WHERE "businessId" = ${B}::uuid`;
        await tx.$executeRaw`DELETE FROM "StoreCustomer" WHERE "businessId" = ${B}::uuid`;
        // The business's own CRM (SMA's invoices to it are kept: they belong to SMA's CRM).
        await tx.$executeRaw`DELETE FROM "Quote" WHERE "tenantId" = ${B}::uuid`;
        await tx.$executeRaw`DELETE FROM "Invoice" WHERE "tenantId" = ${B}::uuid`;
        await tx.$executeRaw`DELETE FROM "Subscription" WHERE "tenantId" = ${B}::uuid`;
        await tx.$executeRaw`DELETE FROM "Deal" WHERE "tenantId" = ${B}::uuid`;
        await tx.$executeRaw`DELETE FROM "Lead" WHERE "tenantId" = ${B}::uuid`;
        await tx.$executeRaw`DELETE FROM "CrmService" WHERE "tenantId" = ${B}::uuid`;
        await tx.$executeRaw`DELETE FROM "SalesTarget" WHERE "tenantId" = ${B}::uuid`;
        await tx.$executeRaw`DELETE FROM "CommissionPlan" WHERE "tenantId" = ${B}::uuid`;
        await tx.$executeRaw`DELETE FROM "CrmSetting" WHERE "businessId" = ${B}::uuid`;
        await tx.$executeRaw`DELETE FROM "CrmCounter" WHERE "businessId" = ${B}::uuid`;
        await tx.$executeRaw`DELETE FROM "PaymentGatewayConfig" WHERE "businessId" = ${B}::uuid`;
        await tx.$executeRaw`DELETE FROM "FbrConfig" WHERE "businessId" = ${B}::uuid`;
        // People's access, roles, stores.
        await tx.$executeRaw`DELETE FROM "RoleAssignment" WHERE "businessId" = ${B}::uuid`;
        await tx.$executeRaw`DELETE FROM "Role" WHERE "businessId" = ${B}::uuid`;
        await tx.$executeRaw`DELETE FROM "StoreMembership" WHERE "businessId" = ${B}::uuid`;
        await tx.$executeRaw`DELETE FROM "Department" WHERE "businessId" = ${B}::uuid`;
        await tx.$executeRaw`DELETE FROM "BusinessMembership" WHERE "businessId" = ${B}::uuid`;
        await tx.$executeRaw`DELETE FROM "Store" WHERE "businessId" = ${B}::uuid`;
        await tx.$executeRaw`DELETE FROM "OutboxEvent" WHERE "businessId" = ${B}::uuid`;
        await tx.$executeRaw`DELETE FROM "BusinessPlan" WHERE "businessId" = ${B}::uuid`;
        // People who belonged to no other business and hold no platform role: anonymised.
        const orphans = await tx.user.findMany({
          where: {
            id: { in: members.map((m) => m.userId) },
            businessMemberships: { none: {} },
            roleAssignments: { none: { scopeType: 'PLATFORM' } },
          },
          select: { id: true },
        });
        for (const { id } of orphans) {
          await tx.$executeRaw`DELETE FROM "UserContact" WHERE "userId" = ${id}::uuid`;
          await tx.$executeRaw`DELETE FROM "Device" WHERE "userId" = ${id}::uuid`;
          await tx.$executeRaw`DELETE FROM "NotificationPreference" WHERE "userId" = ${id}::uuid`;
          await tx.$executeRaw`DELETE FROM "PasswordResetToken" WHERE "userId" = ${id}::uuid`;
          await tx.$executeRaw`UPDATE "Session" SET "revokedAt" = COALESCE("revokedAt", now()) WHERE "userId" = ${id}::uuid`;
          await tx.user.update({
            where: { id },
            data: {
              username: `deleted-${id.replace(/-/g, '').slice(0, 20)}`,
              displayName: 'Deleted user',
              passwordHash: `!${randomBytes(24).toString('base64url')}`,
              status: 'DEACTIVATED',
              mfaSecretEnc: null,
              mfaPendingSecretEnc: null,
              mfaEnabledAt: null,
            },
          });
        }
        await tx.business.update({
          where: { id: B },
          data: {
            name: 'Deleted business',
            description: null,
            phone: null,
            email: null,
            website: null,
            mapUrl: null,
            socialLinks: {},
            logo: null,
            logoUpdatedAt: null,
            closureReason: null,
            purgedAt: new Date(),
          },
        });
        await tx.$executeRaw`UPDATE "Business" SET "address" = NULL WHERE "id" = ${B}::uuid`;
      },
      { timeout: 120_000 },
    );

    // Files in storage (after the database: a failure here only leaves orphaned objects).
    for (const f of files)
      for (const key of [f.incomingKey, f.objectKey, f.thumbnailKey])
        if (key) await this.storage.delete(key).catch(() => undefined);
    this.logger.log({ businessId, files: files.length }, 'Business data erased');
  }
}
