-- CreateEnum
CREATE TYPE "EventResponseKind" AS ENUM ('GOING', 'MAYBE', 'NOT_GOING');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'DONE');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- AlterEnum
ALTER TYPE "ConversationType" ADD VALUE 'BROADCAST_LIST';

-- AlterEnum
ALTER TYPE "MediaKind" ADD VALUE 'AUDIO';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MessageKind" ADD VALUE 'AUDIO';
ALTER TYPE "MessageKind" ADD VALUE 'LOCATION';
ALTER TYPE "MessageKind" ADD VALUE 'CONTACT';
ALTER TYPE "MessageKind" ADD VALUE 'POLL';
ALTER TYPE "MessageKind" ADD VALUE 'EVENT';
ALTER TYPE "MessageKind" ADD VALUE 'CALL';
ALTER TYPE "MessageKind" ADD VALUE 'STICKER';

-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN     "forStatus" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "meta" JSONB;

-- CreateTable
CREATE TABLE "PollVote" (
    "messageId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "option" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PollVote_pkey" PRIMARY KEY ("messageId","userId","option")
);

-- CreateTable
CREATE TABLE "EventResponse" (
    "messageId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "response" "EventResponseKind" NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EventResponse_pkey" PRIMARY KEY ("messageId","userId")
);

-- CreateTable
CREATE TABLE "BroadcastRecipient" (
    "conversationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "addedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BroadcastRecipient_pkey" PRIMARY KEY ("conversationId","userId")
);

-- CreateTable
CREATE TABLE "StatusPost" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "storeId" UUID,
    "authorId" UUID NOT NULL,
    "text" VARCHAR(700),
    "background" VARCHAR(7),
    "mediaId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "StatusPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatusView" (
    "statusId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "viewedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatusView_pkey" PRIMARY KEY ("statusId","userId")
);

-- CreateTable
CREATE TABLE "StoreTask" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "notes" VARCHAR(2000),
    "priority" "TaskPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "dueAt" TIMESTAMPTZ(3),
    "assigneeId" UUID,
    "createdById" UUID,
    "completedById" UUID,
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "StoreTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shift" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "title" VARCHAR(60),
    "notes" VARCHAR(300),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSetting" (
    "key" VARCHAR(64) NOT NULL,
    "valueEnc" TEXT NOT NULL,
    "updatedById" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "PollVote_messageId_idx" ON "PollVote"("messageId");

-- CreateIndex
CREATE INDEX "BroadcastRecipient_userId_idx" ON "BroadcastRecipient"("userId");

-- CreateIndex
CREATE INDEX "StatusPost_businessId_expiresAt_idx" ON "StatusPost"("businessId", "expiresAt");

-- CreateIndex
CREATE INDEX "StatusPost_authorId_createdAt_idx" ON "StatusPost"("authorId", "createdAt");

-- CreateIndex
CREATE INDEX "StoreTask_storeId_status_idx" ON "StoreTask"("storeId", "status");

-- CreateIndex
CREATE INDEX "StoreTask_assigneeId_status_idx" ON "StoreTask"("assigneeId", "status");

-- CreateIndex
CREATE INDEX "Shift_storeId_startsAt_idx" ON "Shift"("storeId", "startsAt");

-- CreateIndex
CREATE INDEX "Shift_userId_startsAt_idx" ON "Shift"("userId", "startsAt");

-- AddForeignKey
ALTER TABLE "PollVote" ADD CONSTRAINT "PollVote_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollVote" ADD CONSTRAINT "PollVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventResponse" ADD CONSTRAINT "EventResponse_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventResponse" ADD CONSTRAINT "EventResponse_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BroadcastRecipient" ADD CONSTRAINT "BroadcastRecipient_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BroadcastRecipient" ADD CONSTRAINT "BroadcastRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusPost" ADD CONSTRAINT "StatusPost_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusPost" ADD CONSTRAINT "StatusPost_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusPost" ADD CONSTRAINT "StatusPost_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusPost" ADD CONSTRAINT "StatusPost_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusView" ADD CONSTRAINT "StatusView_statusId_fkey" FOREIGN KEY ("statusId") REFERENCES "StatusPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusView" ADD CONSTRAINT "StatusView_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreTask" ADD CONSTRAINT "StoreTask_businessId_storeId_fkey" FOREIGN KEY ("businessId", "storeId") REFERENCES "Store"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreTask" ADD CONSTRAINT "StoreTask_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreTask" ADD CONSTRAINT "StoreTask_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreTask" ADD CONSTRAINT "StoreTask_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_businessId_storeId_fkey" FOREIGN KEY ("businessId", "storeId") REFERENCES "Store"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Hand-written constraints (not expressible in Prisma).
-- Upload context: exactly one of a conversation, a draft campaign or a status update.
ALTER TABLE "MediaAsset" DROP CONSTRAINT "MediaAsset_context_check";
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_context_check"
  CHECK ((("conversationId" IS NOT NULL)::int + ("campaignId" IS NOT NULL)::int + "forStatus"::int) = 1);
ALTER TABLE "PollVote" ADD CONSTRAINT "PollVote_option_check" CHECK ("option" BETWEEN 0 AND 11);
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_times_check" CHECK ("endsAt" > "startsAt");
ALTER TABLE "StatusPost" ADD CONSTRAINT "StatusPost_content_check"
  CHECK ("text" IS NOT NULL OR "mediaId" IS NOT NULL);
