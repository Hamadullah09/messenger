-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "closureReason" VARCHAR(500),
ADD COLUMN     "closureRequestedAt" TIMESTAMPTZ(3),
ADD COLUMN     "purgedAt" TIMESTAMPTZ(3);

