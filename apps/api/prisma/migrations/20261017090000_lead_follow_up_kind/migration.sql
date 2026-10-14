-- CreateEnum
CREATE TYPE "FollowUpKind" AS ENUM ('CALL', 'MEETING', 'VISIT', 'WHATSAPP', 'EMAIL', 'OTHER');

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "nextFollowUpKind" "FollowUpKind",
ADD COLUMN     "nextFollowUpNote" VARCHAR(300);

-- CreateIndex
CREATE INDEX "Lead_tenantId_nextFollowUpAt_idx" ON "Lead"("tenantId", "nextFollowUpAt");


-- A follow-up type or note needs a follow-up date.
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_follow_up_check" CHECK ("nextFollowUpAt" IS NOT NULL OR ("nextFollowUpKind" IS NULL AND "nextFollowUpNote" IS NULL));
