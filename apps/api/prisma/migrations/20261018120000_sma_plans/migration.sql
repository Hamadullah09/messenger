-- CreateEnum
CREATE TYPE "SmaPlanKey" AS ENUM ('TRIAL', 'STARTER', 'BUSINESS', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "SmaPlanStatus" AS ENUM ('TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED');

-- CreateTable
CREATE TABLE "BusinessPlan" (
    "businessId" UUID NOT NULL,
    "plan" "SmaPlanKey" NOT NULL,
    "status" "SmaPlanStatus" NOT NULL,
    "trialEndsAt" TIMESTAMPTZ(3),
    "subscriptionId" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BusinessPlan_pkey" PRIMARY KEY ("businessId")
);

-- CreateIndex
CREATE UNIQUE INDEX "BusinessPlan_subscriptionId_key" ON "BusinessPlan"("subscriptionId");

-- AddForeignKey
ALTER TABLE "BusinessPlan" ADD CONSTRAINT "BusinessPlan_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "BusinessPlan" ADD CONSTRAINT "BusinessPlan_trial_check" CHECK ("status" <> 'TRIAL' OR "trialEndsAt" IS NOT NULL);

-- Businesses that exist today keep working: Business plan, active, billed by hand.
INSERT INTO "BusinessPlan" ("businessId", "plan", "status", "updatedAt")
SELECT "id", 'BUSINESS', 'ACTIVE', CURRENT_TIMESTAMP FROM "Business" WHERE NOT "internal" AND "deletedAt" IS NULL;
