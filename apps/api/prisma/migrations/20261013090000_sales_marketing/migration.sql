-- Sales & Marketing: leads, their activity history, and SMA's internal sales team flag.
-- CreateEnum
CREATE TYPE "LeadStage" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('WEBSITE', 'COLD_CALL', 'REFERRAL', 'SOCIAL_MEDIA', 'EMAIL_CAMPAIGN', 'EVENT', 'WALK_IN', 'PARTNER', 'ADVERTISEMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "LeadActivityType" AS ENUM ('CREATED', 'NOTE', 'CALL', 'EMAIL', 'MEETING', 'WHATSAPP', 'STAGE_CHANGED', 'ASSIGNED', 'CONVERTED');

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "internal" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Lead" (
    "id" UUID NOT NULL,
    "companyName" VARCHAR(120) NOT NULL,
    "contactName" VARCHAR(80) NOT NULL,
    "contactTitle" VARCHAR(80),
    "email" VARCHAR(254),
    "phone" VARCHAR(16),
    "website" VARCHAR(500),
    "industry" VARCHAR(80),
    "city" VARCHAR(100),
    "country" VARCHAR(2),
    "storeCount" INTEGER,
    "estimatedValue" INTEGER,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'PKR',
    "source" "LeadSource" NOT NULL,
    "sourceDetail" VARCHAR(160),
    "stage" "LeadStage" NOT NULL DEFAULT 'NEW',
    "lostReason" VARCHAR(300),
    "notes" VARCHAR(2000),
    "ownerId" UUID,
    "createdById" UUID,
    "nextFollowUpAt" TIMESTAMPTZ(3),
    "lastActivityAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "convertedBusinessId" UUID,
    "convertedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadActivity" (
    "id" UUID NOT NULL,
    "leadId" UUID NOT NULL,
    "type" "LeadActivityType" NOT NULL,
    "body" VARCHAR(2000),
    "fromStage" "LeadStage",
    "toStage" "LeadStage",
    "actorId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Lead_convertedBusinessId_key" ON "Lead"("convertedBusinessId");

-- CreateIndex
CREATE INDEX "Lead_stage_deletedAt_idx" ON "Lead"("stage", "deletedAt");

-- CreateIndex
CREATE INDEX "Lead_ownerId_stage_idx" ON "Lead"("ownerId", "stage");

-- CreateIndex
CREATE INDEX "Lead_nextFollowUpAt_idx" ON "Lead"("nextFollowUpAt");

-- CreateIndex
CREATE INDEX "LeadActivity_leadId_createdAt_idx" ON "LeadActivity"("leadId", "createdAt");

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_convertedBusinessId_fkey" FOREIGN KEY ("convertedBusinessId") REFERENCES "Business"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadActivity" ADD CONSTRAINT "LeadActivity_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadActivity" ADD CONSTRAINT "LeadActivity_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

