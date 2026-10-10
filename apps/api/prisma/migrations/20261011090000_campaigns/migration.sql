-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'SENDING', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CampaignRecipientState" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "ConversationType" ADD VALUE 'BROADCAST';

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "channelKey" VARCHAR(80);

-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN     "campaignId" UUID,
ALTER COLUMN "conversationId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "BulkCampaign" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "clientCampaignId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "body" TEXT,
    "mediaId" UUID,
    "audience" JSONB NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3),
    "startedAt" TIMESTAMPTZ(3),
    "materializedAt" TIMESTAMPTZ(3),
    "pausedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "confirmedCount" INTEGER,
    "totalRecipients" INTEGER NOT NULL DEFAULT 0,
    "lastDispatchAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BulkCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BulkCampaignRecipient" (
    "campaignId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "state" "CampaignRecipientState" NOT NULL DEFAULT 'PENDING',
    "messageId" UUID,
    "reason" VARCHAR(64),
    "processedAt" TIMESTAMPTZ(3),

    CONSTRAINT "BulkCampaignRecipient_pkey" PRIMARY KEY ("campaignId","userId")
);

-- CreateTable
CREATE TABLE "CampaignSuppression" (
    "businessId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "reason" VARCHAR(32) NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignSuppression_pkey" PRIMARY KEY ("businessId","userId")
);

-- CreateIndex
CREATE INDEX "BulkCampaign_businessId_createdAt_idx" ON "BulkCampaign"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "BulkCampaign_status_scheduledAt_idx" ON "BulkCampaign"("status", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "BulkCampaign_createdById_clientCampaignId_key" ON "BulkCampaign"("createdById", "clientCampaignId");

-- CreateIndex
CREATE UNIQUE INDEX "BulkCampaignRecipient_messageId_key" ON "BulkCampaignRecipient"("messageId");

-- CreateIndex
CREATE INDEX "BulkCampaignRecipient_campaignId_state_idx" ON "BulkCampaignRecipient"("campaignId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_channelKey_key" ON "Conversation"("channelKey");

-- CreateIndex
CREATE INDEX "MediaAsset_campaignId_idx" ON "MediaAsset"("campaignId");

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "BulkCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkCampaign" ADD CONSTRAINT "BulkCampaign_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkCampaign" ADD CONSTRAINT "BulkCampaign_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkCampaign" ADD CONSTRAINT "BulkCampaign_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkCampaignRecipient" ADD CONSTRAINT "BulkCampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "BulkCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkCampaignRecipient" ADD CONSTRAINT "BulkCampaignRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignSuppression" ADD CONSTRAINT "CampaignSuppression_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignSuppression" ADD CONSTRAINT "CampaignSuppression_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written constraints (not expressible in Prisma).
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_context_check"
  CHECK (("conversationId" IS NULL) <> ("campaignId" IS NULL));
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_channel_key_check"
  CHECK (("type"::text = 'BROADCAST') = ("channelKey" IS NOT NULL));
ALTER TABLE "BulkCampaign" ADD CONSTRAINT "BulkCampaign_content_check"
  CHECK ("body" IS NOT NULL OR "mediaId" IS NOT NULL);
-- Dispatcher scans only campaigns with work to do.
CREATE INDEX "BulkCampaign_active_idx" ON "BulkCampaign" ("lastDispatchAt" NULLS FIRST)
  WHERE "status" = 'SENDING';
