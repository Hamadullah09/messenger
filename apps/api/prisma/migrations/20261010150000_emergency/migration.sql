-- CreateEnum
CREATE TYPE "EmergencyCategory" AS ENUM ('MEDICAL', 'SECURITY', 'FIRE', 'OTHER');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'ESCALATED', 'ACKNOWLEDGED', 'RESOLVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AlertState" AS ENUM ('PENDING', 'QUEUED', 'SENT_TO_GATEWAY', 'DELIVERED_TO_DEVICE', 'READ', 'ACKNOWLEDGED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ResponderSource" AS ENUM ('CONTACT', 'STORE_MANAGER', 'BUSINESS_ADMIN', 'RESPONDER');

-- CreateEnum
CREATE TYPE "IncidentEventType" AS ENUM ('CREATED', 'NOTIFIED', 'ESCALATED', 'RECIPIENT_SKIPPED', 'CHAIN_EXHAUSTED', 'NOTIFY_FAILED', 'JOINED', 'ACKNOWLEDGED', 'RESOLVED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "emergencyAckTimeoutSeconds" INTEGER NOT NULL DEFAULT 120;

-- CreateTable
CREATE TABLE "EmergencyContact" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "priority" INTEGER NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmergencyContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmergencyIncident" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "reporterId" UUID NOT NULL,
    "clientIncidentId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "category" "EmergencyCategory" NOT NULL DEFAULT 'OTHER',
    "description" VARCHAR(1000),
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "level" INTEGER NOT NULL DEFAULT 1,
    "maxLevel" INTEGER NOT NULL,
    "ackTimeoutSeconds" INTEGER NOT NULL,
    "ackDeadlineAt" TIMESTAMPTZ(3),
    "chainExhaustedAt" TIMESTAMPTZ(3),
    "acknowledgedAt" TIMESTAMPTZ(3),
    "acknowledgedById" UUID,
    "resolvedAt" TIMESTAMPTZ(3),
    "resolvedById" UUID,
    "resolutionNote" VARCHAR(500),
    "cancelledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EmergencyIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmergencyIncidentRecipient" (
    "id" UUID NOT NULL,
    "incidentId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "source" "ResponderSource" NOT NULL,
    "state" "AlertState" NOT NULL DEFAULT 'PENDING',
    "notifiedAt" TIMESTAMPTZ(3),
    "sentAt" TIMESTAMPTZ(3),
    "deliveredAt" TIMESTAMPTZ(3),
    "readAt" TIMESTAMPTZ(3),
    "acknowledgedAt" TIMESTAMPTZ(3),
    "failedAt" TIMESTAMPTZ(3),
    "failureReason" VARCHAR(64),

    CONSTRAINT "EmergencyIncidentRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmergencyIncidentEvent" (
    "id" UUID NOT NULL,
    "seq" SERIAL NOT NULL,
    "incidentId" UUID NOT NULL,
    "type" "IncidentEventType" NOT NULL,
    "actorId" UUID,
    "level" INTEGER,
    "userIds" UUID[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmergencyIncidentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmergencyContact_storeId_userId_key" ON "EmergencyContact"("storeId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "EmergencyContact_storeId_priority_key" ON "EmergencyContact"("storeId", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "EmergencyIncident_conversationId_key" ON "EmergencyIncident"("conversationId");

-- CreateIndex
CREATE INDEX "EmergencyIncident_businessId_storeId_createdAt_idx" ON "EmergencyIncident"("businessId", "storeId", "createdAt");

-- CreateIndex
CREATE INDEX "EmergencyIncident_status_ackDeadlineAt_idx" ON "EmergencyIncident"("status", "ackDeadlineAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmergencyIncident_reporterId_clientIncidentId_key" ON "EmergencyIncident"("reporterId", "clientIncidentId");

-- CreateIndex
CREATE INDEX "EmergencyIncidentRecipient_userId_state_idx" ON "EmergencyIncidentRecipient"("userId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "EmergencyIncidentRecipient_incidentId_userId_key" ON "EmergencyIncidentRecipient"("incidentId", "userId");

-- CreateIndex
CREATE INDEX "EmergencyIncidentEvent_incidentId_seq_idx" ON "EmergencyIncidentEvent"("incidentId", "seq");

-- AddForeignKey
ALTER TABLE "EmergencyContact" ADD CONSTRAINT "EmergencyContact_businessId_storeId_fkey" FOREIGN KEY ("businessId", "storeId") REFERENCES "Store"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyContact" ADD CONSTRAINT "EmergencyContact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyIncident" ADD CONSTRAINT "EmergencyIncident_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyIncident" ADD CONSTRAINT "EmergencyIncident_businessId_storeId_fkey" FOREIGN KEY ("businessId", "storeId") REFERENCES "Store"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyIncident" ADD CONSTRAINT "EmergencyIncident_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyIncident" ADD CONSTRAINT "EmergencyIncident_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyIncident" ADD CONSTRAINT "EmergencyIncident_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyIncident" ADD CONSTRAINT "EmergencyIncident_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyIncidentRecipient" ADD CONSTRAINT "EmergencyIncidentRecipient_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "EmergencyIncident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyIncidentRecipient" ADD CONSTRAINT "EmergencyIncidentRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyIncidentEvent" ADD CONSTRAINT "EmergencyIncidentEvent_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "EmergencyIncident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written constraints (not expressible in Prisma).
ALTER TABLE "Store" ADD CONSTRAINT "Store_emergency_ack_timeout_check"
  CHECK ("emergencyAckTimeoutSeconds" BETWEEN 15 AND 1800);
ALTER TABLE "EmergencyContact" ADD CONSTRAINT "EmergencyContact_priority_check"
  CHECK ("priority" BETWEEN 1 AND 10);
ALTER TABLE "EmergencyIncident" ADD CONSTRAINT "EmergencyIncident_level_check"
  CHECK ("level" >= 1 AND "level" <= "maxLevel");
-- At most one active incident per reporter and store; a second press re-opens the first.
CREATE UNIQUE INDEX "EmergencyIncident_active_reporter_unique" ON "EmergencyIncident" ("reporterId", "storeId")
  WHERE "status" IN ('OPEN', 'ESCALATED', 'ACKNOWLEDGED');
-- Sweeper scan: only incidents still waiting for acknowledgement.
CREATE INDEX "EmergencyIncident_due_idx" ON "EmergencyIncident" ("ackDeadlineAt")
  WHERE "status" IN ('OPEN', 'ESCALATED') AND "ackDeadlineAt" IS NOT NULL;
