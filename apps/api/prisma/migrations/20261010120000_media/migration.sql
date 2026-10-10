-- CreateEnum
CREATE TYPE "FileSharingPolicy" AS ENUM ('ALL_MEMBERS', 'ADMINS_ONLY', 'DISABLED');

-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('IMAGE', 'VIDEO', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('PENDING_UPLOAD', 'VERIFYING', 'READY', 'QUARANTINED', 'REJECTED', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MessageKind" ADD VALUE 'IMAGE';
ALTER TYPE "MessageKind" ADD VALUE 'VIDEO';
ALTER TYPE "MessageKind" ADD VALUE 'DOCUMENT';

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "fileSharingPolicy" "FileSharingPolicy" NOT NULL DEFAULT 'ALL_MEMBERS';

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "uploaderId" UUID NOT NULL,
    "kind" "MediaKind" NOT NULL,
    "status" "MediaStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "fileName" VARCHAR(200) NOT NULL,
    "mimeType" VARCHAR(120) NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" VARCHAR(64),
    "incomingKey" VARCHAR(200) NOT NULL,
    "objectKey" VARCHAR(200),
    "thumbnailKey" VARCHAR(200),
    "multipartUploadId" VARCHAR(1024),
    "partSize" INTEGER,
    "partCount" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "failureReason" VARCHAR(64),
    "uploadExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "readyAt" TIMESTAMPTZ(3),

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageAttachment" (
    "messageId" UUID NOT NULL,
    "mediaId" UUID NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MessageAttachment_pkey" PRIMARY KEY ("messageId","position")
);

-- CreateIndex
CREATE INDEX "MediaAsset_businessId_status_idx" ON "MediaAsset"("businessId", "status");

-- CreateIndex
CREATE INDEX "MediaAsset_status_uploadExpiresAt_idx" ON "MediaAsset"("status", "uploadExpiresAt");

-- CreateIndex
CREATE INDEX "MediaAsset_conversationId_idx" ON "MediaAsset"("conversationId");

-- CreateIndex
CREATE INDEX "MessageAttachment_mediaId_idx" ON "MessageAttachment"("mediaId");

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───── Hand-written (not expressible in the Prisma schema) ─────

ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_size_check" CHECK ("sizeBytes" > 0);
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_dimensions_check" CHECK (
  ("width" IS NULL OR "width" > 0) AND ("height" IS NULL OR "height" > 0)
);
-- A READY asset always has a verified object key.
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_ready_key_check" CHECK ("status" <> 'READY' OR "objectKey" IS NOT NULL);

-- Full-text search now also covers media captions (body of IMAGE/VIDEO/DOCUMENT messages).
DROP INDEX "Message_body_fts_idx";
CREATE INDEX "Message_body_fts_idx" ON "Message"
  USING GIN (to_tsvector('simple', COALESCE("body", '')))
  WHERE "deletedAt" IS NULL AND "kind" <> 'SYSTEM';

-- Sweeper for abandoned uploads scans only pending rows.
CREATE INDEX "MediaAsset_pending_expiry_idx" ON "MediaAsset" ("uploadExpiresAt") WHERE "status" = 'PENDING_UPLOAD';
