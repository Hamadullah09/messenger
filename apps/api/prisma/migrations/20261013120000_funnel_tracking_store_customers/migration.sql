-- Inbound/outbound leads, call and message counts, responses, stage timing; store customer register.
-- CreateEnum
CREATE TYPE "LeadDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "ActivityOutcome" AS ENUM ('INTERESTED', 'NOT_INTERESTED', 'NO_ANSWER', 'CALL_BACK_LATER', 'MEETING_BOOKED', 'NEEDS_MORE_INFO', 'WRONG_CONTACT');

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "callCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "direction" "LeadDirection" NOT NULL DEFAULT 'INBOUND',
ADD COLUMN     "lastOutcome" "ActivityOutcome",
ADD COLUMN     "meetingCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "messageCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stageChangedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "LeadActivity" ADD COLUMN     "outcome" "ActivityOutcome";

-- CreateTable
CREATE TABLE "StoreCustomer" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "storeId" UUID,
    "name" VARCHAR(120) NOT NULL,
    "phone" VARCHAR(16),
    "email" VARCHAR(254),
    "city" VARCHAR(100),
    "notes" VARCHAR(1000),
    "tags" TEXT[],
    "marketingOptIn" BOOLEAN NOT NULL DEFAULT false,
    "optInAt" TIMESTAMPTZ(3),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "StoreCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StoreCustomer_businessId_deletedAt_idx" ON "StoreCustomer"("businessId", "deletedAt");

-- CreateIndex
CREATE INDEX "StoreCustomer_storeId_idx" ON "StoreCustomer"("storeId");

-- AddForeignKey
ALTER TABLE "StoreCustomer" ADD CONSTRAINT "StoreCustomer_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreCustomer" ADD CONSTRAINT "StoreCustomer_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreCustomer" ADD CONSTRAINT "StoreCustomer_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Leads we reached out to are outbound.
UPDATE "Lead" SET "direction" = 'OUTBOUND' WHERE "source" IN ('COLD_CALL', 'EMAIL_CAMPAIGN');
