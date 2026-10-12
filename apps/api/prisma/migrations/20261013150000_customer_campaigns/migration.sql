-- Marketing campaigns from a business to its opted-in store customers (email, SMS, WhatsApp).
-- CreateEnum
CREATE TYPE "MarketingChannel" AS ENUM ('EMAIL', 'SMS', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "CustomerCampaignStatus" AS ENUM ('DRAFT', 'SENDING', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CustomerRecipientState" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "StoreCustomer" ADD COLUMN     "unsubscribedAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "CustomerCampaign" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "channel" "MarketingChannel" NOT NULL,
    "subject" VARCHAR(150),
    "body" VARCHAR(1500) NOT NULL,
    "audience" JSONB NOT NULL,
    "status" "CustomerCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "CustomerCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerCampaignRecipient" (
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "destination" VARCHAR(254) NOT NULL,
    "state" "CustomerRecipientState" NOT NULL DEFAULT 'PENDING',
    "providerMessageId" VARCHAR(200),
    "error" VARCHAR(300),
    "sentAt" TIMESTAMPTZ(3),

    CONSTRAINT "CustomerCampaignRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerCampaign_businessId_createdAt_idx" ON "CustomerCampaign"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "CustomerCampaign_status_idx" ON "CustomerCampaign"("status");

-- CreateIndex
CREATE INDEX "CustomerCampaignRecipient_campaignId_state_idx" ON "CustomerCampaignRecipient"("campaignId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerCampaignRecipient_campaignId_customerId_key" ON "CustomerCampaignRecipient"("campaignId", "customerId");

-- AddForeignKey
ALTER TABLE "CustomerCampaign" ADD CONSTRAINT "CustomerCampaign_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCampaign" ADD CONSTRAINT "CustomerCampaign_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCampaignRecipient" ADD CONSTRAINT "CustomerCampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CustomerCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCampaignRecipient" ADD CONSTRAINT "CustomerCampaignRecipient_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "StoreCustomer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

