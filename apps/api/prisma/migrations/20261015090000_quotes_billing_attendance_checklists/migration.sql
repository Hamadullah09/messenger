-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentClaimStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CommissionBasis" AS ENUM ('WON', 'COLLECTED');

-- CreateEnum
CREATE TYPE "LeaveType" AS ENUM ('ANNUAL', 'SICK', 'CASUAL', 'UNPAID', 'OTHER');

-- CreateEnum
CREATE TYPE "LeaveStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "disappearAfterSeconds" INTEGER;

-- AlterTable
ALTER TABLE "CrmService" ADD COLUMN     "currency" VARCHAR(3) NOT NULL DEFAULT 'USD';

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "lastReminderAt" TIMESTAMPTZ(3),
ADD COLUMN     "payToken" VARCHAR(64),
ADD COLUMN     "periodEnd" DATE,
ADD COLUMN     "periodStart" DATE,
ADD COLUMN     "reminderCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "subscriptionId" UUID;

-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN     "forOps" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "expiresAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "geofenceMeters" INTEGER NOT NULL DEFAULT 200,
ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "Quote" (
    "id" UUID NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "dealId" UUID,
    "businessId" UUID,
    "leadId" UUID,
    "billToName" VARCHAR(160) NOT NULL,
    "billToEmail" VARCHAR(254),
    "billToPhone" VARCHAR(16),
    "billToAddress" VARCHAR(500),
    "status" "QuoteStatus" NOT NULL DEFAULT 'DRAFT',
    "issueDate" DATE NOT NULL,
    "validUntil" DATE NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "taxRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "notes" VARCHAR(2000),
    "terms" VARCHAR(2000),
    "publicToken" VARCHAR(64) NOT NULL,
    "sentAt" TIMESTAMPTZ(3),
    "viewedAt" TIMESTAMPTZ(3),
    "respondedAt" TIMESTAMPTZ(3),
    "responseName" VARCHAR(120),
    "responseNote" VARCHAR(500),
    "invoiceId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteItem" (
    "id" UUID NOT NULL,
    "quoteId" UUID NOT NULL,
    "serviceId" UUID,
    "name" VARCHAR(160) NOT NULL,
    "description" VARCHAR(500),
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "billing" "ServiceBilling" NOT NULL DEFAULT 'ONE_TIME',
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "QuoteItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "dealId" UUID,
    "name" VARCHAR(160) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "interval" "ServiceBilling" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "nextInvoiceAt" DATE NOT NULL,
    "dueDays" INTEGER NOT NULL DEFAULT 14,
    "taxRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "autoEmail" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "cancelledAt" TIMESTAMPTZ(3),

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionItem" (
    "id" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "serviceId" UUID,
    "name" VARCHAR(160) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SubscriptionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentClaim" (
    "id" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reference" VARCHAR(120) NOT NULL,
    "payerName" VARCHAR(120),
    "note" VARCHAR(500),
    "status" "PaymentClaimStatus" NOT NULL DEFAULT 'PENDING',
    "paymentId" UUID,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMPTZ(3),
    "reviewNote" VARCHAR(300),
    "ipHash" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionPlan" (
    "scope" VARCHAR(40) NOT NULL,
    "baseRate" DECIMAL(5,2) NOT NULL,
    "bonusRate" DECIMAL(5,2) NOT NULL,
    "basis" "CommissionBasis" NOT NULL DEFAULT 'WON',
    "updatedById" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CommissionPlan_pkey" PRIMARY KEY ("scope")
);

-- CreateTable
CREATE TABLE "AttendanceRecord" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "shiftId" UUID,
    "checkInAt" TIMESTAMPTZ(3) NOT NULL,
    "checkInLat" DOUBLE PRECISION,
    "checkInLng" DOUBLE PRECISION,
    "checkInAccuracy" INTEGER,
    "checkInDistance" INTEGER,
    "checkOutAt" TIMESTAMPTZ(3),
    "checkOutLat" DOUBLE PRECISION,
    "checkOutLng" DOUBLE PRECISION,
    "checkOutDistance" INTEGER,
    "note" VARCHAR(300),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChecklistTemplate" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "storeId" UUID,
    "name" VARCHAR(80) NOT NULL,
    "items" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ChecklistTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChecklistRun" (
    "id" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "completedAt" TIMESTAMPTZ(3),
    "completedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChecklistRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChecklistRunItem" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "itemKey" VARCHAR(40) NOT NULL,
    "checked" BOOLEAN NOT NULL DEFAULT false,
    "checkedById" UUID,
    "checkedAt" TIMESTAMPTZ(3),
    "note" VARCHAR(300),
    "mediaId" UUID,
    "userId" UUID,

    CONSTRAINT "ChecklistRunItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveRequest" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "LeaveType" NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "reason" VARCHAR(500),
    "status" "LeaveStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionNote" VARCHAR(300),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LeaveRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Quote_number_key" ON "Quote"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_publicToken_key" ON "Quote"("publicToken");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_invoiceId_key" ON "Quote"("invoiceId");

-- CreateIndex
CREATE INDEX "Quote_status_validUntil_idx" ON "Quote"("status", "validUntil");

-- CreateIndex
CREATE INDEX "Quote_dealId_idx" ON "Quote"("dealId");

-- CreateIndex
CREATE INDEX "QuoteItem_quoteId_idx" ON "QuoteItem"("quoteId");

-- CreateIndex
CREATE INDEX "Subscription_status_nextInvoiceAt_idx" ON "Subscription"("status", "nextInvoiceAt");

-- CreateIndex
CREATE INDEX "Subscription_businessId_idx" ON "Subscription"("businessId");

-- CreateIndex
CREATE INDEX "SubscriptionItem_subscriptionId_idx" ON "SubscriptionItem"("subscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentClaim_paymentId_key" ON "PaymentClaim"("paymentId");

-- CreateIndex
CREATE INDEX "PaymentClaim_status_createdAt_idx" ON "PaymentClaim"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentClaim_invoiceId_idx" ON "PaymentClaim"("invoiceId");

-- CreateIndex
CREATE INDEX "AttendanceRecord_storeId_checkInAt_idx" ON "AttendanceRecord"("storeId", "checkInAt");

-- CreateIndex
CREATE INDEX "AttendanceRecord_userId_checkInAt_idx" ON "AttendanceRecord"("userId", "checkInAt");

-- CreateIndex
CREATE INDEX "ChecklistTemplate_businessId_idx" ON "ChecklistTemplate"("businessId");

-- CreateIndex
CREATE INDEX "ChecklistRun_storeId_day_idx" ON "ChecklistRun"("storeId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "ChecklistRun_templateId_storeId_day_key" ON "ChecklistRun"("templateId", "storeId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "ChecklistRunItem_runId_itemKey_key" ON "ChecklistRunItem"("runId", "itemKey");

-- CreateIndex
CREATE INDEX "LeaveRequest_storeId_status_idx" ON "LeaveRequest"("storeId", "status");

-- CreateIndex
CREATE INDEX "LeaveRequest_userId_startDate_idx" ON "LeaveRequest"("userId", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_payToken_key" ON "Invoice"("payToken");

-- CreateIndex
CREATE INDEX "Message_expiresAt_idx" ON "Message"("expiresAt");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteItem" ADD CONSTRAINT "QuoteItem_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionItem" ADD CONSTRAINT "SubscriptionItem_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentClaim" ADD CONSTRAINT "PaymentClaim_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_businessId_storeId_fkey" FOREIGN KEY ("businessId", "storeId") REFERENCES "Store"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistRun" ADD CONSTRAINT "ChecklistRun_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ChecklistTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistRunItem" ADD CONSTRAINT "ChecklistRunItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ChecklistRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistRunItem" ADD CONSTRAINT "ChecklistRunItem_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistRunItem" ADD CONSTRAINT "ChecklistRunItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_businessId_storeId_fkey" FOREIGN KEY ("businessId", "storeId") REFERENCES "Store"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Hand-written: numbering, value checks and the media context rule.
CREATE SEQUENCE "quote_number_seq" START 1;
ALTER TABLE "QuoteItem" ADD CONSTRAINT "QuoteItem_values_check" CHECK ("quantity" > 0 AND "unitPrice" >= 0);
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_dates_check" CHECK ("validUntil" >= "issueDate");
ALTER TABLE "SubscriptionItem" ADD CONSTRAINT "SubscriptionItem_values_check" CHECK ("quantity" > 0 AND "unitPrice" >= 0);
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_interval_check" CHECK ("interval" IN ('MONTHLY', 'YEARLY'));
ALTER TABLE "PaymentClaim" ADD CONSTRAINT "PaymentClaim_amount_check" CHECK ("amount" > 0);
ALTER TABLE "CommissionPlan" ADD CONSTRAINT "CommissionPlan_rates_check" CHECK ("baseRate" BETWEEN 0 AND 100 AND "bonusRate" BETWEEN 0 AND 100);
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_dates_check" CHECK ("endDate" >= "startDate");
ALTER TABLE "Store" ADD CONSTRAINT "Store_location_check" CHECK (
  ("latitude" IS NULL) = ("longitude" IS NULL)
  AND ("latitude" IS NULL OR ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180))
  AND "geofenceMeters" BETWEEN 20 AND 5000
);
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_disappear_check"
  CHECK ("disappearAfterSeconds" IS NULL OR "disappearAfterSeconds" BETWEEN 60 AND 31536000);
ALTER TABLE "MediaAsset" DROP CONSTRAINT "MediaAsset_context_check";
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_context_check"
  CHECK ((("conversationId" IS NOT NULL)::int + ("campaignId" IS NOT NULL)::int + "forStatus"::int + "forOps"::int) = 1);
