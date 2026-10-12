-- Password reset links, public business/store details and logos.
-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "address" JSONB,
ADD COLUMN     "description" VARCHAR(500),
ADD COLUMN     "email" VARCHAR(254),
ADD COLUMN     "logo" BYTEA,
ADD COLUMN     "logoUpdatedAt" TIMESTAMPTZ(3),
ADD COLUMN     "mapUrl" VARCHAR(500),
ADD COLUMN     "phone" VARCHAR(16),
ADD COLUMN     "socialLinks" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "website" VARCHAR(500);

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "description" VARCHAR(500),
ADD COLUMN     "email" VARCHAR(254),
ADD COLUMN     "logo" BYTEA,
ADD COLUMN     "logoUpdatedAt" TIMESTAMPTZ(3),
ADD COLUMN     "mapUrl" VARCHAR(500),
ADD COLUMN     "phone" VARCHAR(16),
ADD COLUMN     "socialLinks" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "website" VARCHAR(500);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "requestedIp" VARCHAR(64),

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_usedAt_idx" ON "PasswordResetToken"("userId", "usedAt");

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

