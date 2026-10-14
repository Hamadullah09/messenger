-- DropIndex
DROP INDEX "Invoice_number_key";

-- DropIndex
DROP INDEX "Quote_number_key";

-- DropIndex
DROP INDEX "SalesTarget_userId_month_key";

-- AlterTable
ALTER TABLE "CommissionPlan" DROP CONSTRAINT "CommissionPlan_pkey",
ADD COLUMN     "id" UUID NOT NULL DEFAULT gen_random_uuid(),
ADD COLUMN     "tenantId" UUID,
ADD CONSTRAINT "CommissionPlan_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "CrmService" ADD COLUMN     "tenantId" UUID;

-- AlterTable
ALTER TABLE "Deal" ADD COLUMN     "tenantId" UUID;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "tenantId" UUID;

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "tenantId" UUID;

-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "tenantId" UUID;

-- AlterTable
ALTER TABLE "SalesTarget" ADD COLUMN     "tenantId" UUID;

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "leadId" UUID,
ADD COLUMN     "tenantId" UUID,
ALTER COLUMN "businessId" DROP NOT NULL;


-- Everything so far is SMA's own CRM (the internal sales team business).
UPDATE "Lead" SET "tenantId" = (SELECT "id" FROM "Business" WHERE "internal" ORDER BY "createdAt" LIMIT 1);
UPDATE "Deal" SET "tenantId" = (SELECT "id" FROM "Business" WHERE "internal" ORDER BY "createdAt" LIMIT 1);
UPDATE "Invoice" SET "tenantId" = (SELECT "id" FROM "Business" WHERE "internal" ORDER BY "createdAt" LIMIT 1);
UPDATE "CrmService" SET "tenantId" = (SELECT "id" FROM "Business" WHERE "internal" ORDER BY "createdAt" LIMIT 1);
UPDATE "SalesTarget" SET "tenantId" = (SELECT "id" FROM "Business" WHERE "internal" ORDER BY "createdAt" LIMIT 1);
UPDATE "Quote" SET "tenantId" = (SELECT "id" FROM "Business" WHERE "internal" ORDER BY "createdAt" LIMIT 1);
UPDATE "Subscription" SET "tenantId" = (SELECT "id" FROM "Business" WHERE "internal" ORDER BY "createdAt" LIMIT 1);
UPDATE "CommissionPlan" SET "tenantId" = (SELECT "id" FROM "Business" WHERE "internal" ORDER BY "createdAt" LIMIT 1);
ALTER TABLE "Lead" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Deal" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Invoice" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "CrmService" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "SalesTarget" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Quote" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Subscription" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "CommissionPlan" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "CommissionPlan" ALTER COLUMN "id" DROP DEFAULT;

-- CreateTable
CREATE TABLE "CrmSetting" (
    "businessId" UUID NOT NULL,
    "key" VARCHAR(40) NOT NULL,
    "value" VARCHAR(2000) NOT NULL,
    "updatedById" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CrmSetting_pkey" PRIMARY KEY ("businessId","key")
);

-- CreateTable
CREATE TABLE "CrmCounter" (
    "businessId" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CrmCounter_pkey" PRIMARY KEY ("businessId","kind")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommissionPlan_tenantId_scope_key" ON "CommissionPlan"("tenantId", "scope");

-- CreateIndex
CREATE INDEX "CrmService_tenantId_idx" ON "CrmService"("tenantId");

-- CreateIndex
CREATE INDEX "Deal_tenantId_idx" ON "Deal"("tenantId");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_idx" ON "Invoice"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_tenantId_number_key" ON "Invoice"("tenantId", "number");

-- CreateIndex
CREATE INDEX "Lead_tenantId_idx" ON "Lead"("tenantId");

-- CreateIndex
CREATE INDEX "Quote_tenantId_idx" ON "Quote"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_tenantId_number_key" ON "Quote"("tenantId", "number");

-- CreateIndex
CREATE INDEX "SalesTarget_tenantId_idx" ON "SalesTarget"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesTarget_tenantId_userId_month_key" ON "SalesTarget"("tenantId", "userId", "month");

-- CreateIndex
CREATE INDEX "Subscription_tenantId_idx" ON "Subscription"("tenantId");

-- CreateIndex
CREATE INDEX "Subscription_leadId_idx" ON "Subscription"("leadId");

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmService" ADD CONSTRAINT "CrmService_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesTarget" ADD CONSTRAINT "SalesTarget_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionPlan" ADD CONSTRAINT "CommissionPlan_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmSetting" ADD CONSTRAINT "CrmSetting_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmCounter" ADD CONSTRAINT "CrmCounter_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A subscription bills an SMA customer business or a business's own customer (won lead).
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_party_check" CHECK ("businessId" IS NOT NULL OR "leadId" IS NOT NULL);
ALTER TABLE "CrmCounter" ADD CONSTRAINT "CrmCounter_value_check" CHECK ("value" >= 0);

-- Numbering continues where the global sequences left off for SMA's own CRM.
INSERT INTO "CrmCounter" ("businessId", "kind", "value")
SELECT "tenantId", 'invoice', MAX(COALESCE(NULLIF(substring("number" from '([0-9]+)$'), ''), '0')::int) FROM "Invoice" GROUP BY "tenantId";
INSERT INTO "CrmCounter" ("businessId", "kind", "value")
SELECT "tenantId", 'quote', MAX(COALESCE(NULLIF(substring("number" from '([0-9]+)$'), ''), '0')::int) FROM "Quote" GROUP BY "tenantId";

DROP SEQUENCE IF EXISTS invoice_number_seq;
DROP SEQUENCE IF EXISTS quote_number_seq;
