-- CreateEnum
CREATE TYPE "DevicePlatform" AS ENUM ('WEB', 'DESKTOP', 'IOS', 'ANDROID');

-- CreateEnum
CREATE TYPE "PushProvider" AS ENUM ('WEB_PUSH', 'FCM', 'APNS');

-- CreateEnum
CREATE TYPE "PushPreview" AS ENUM ('NONE', 'SENDER', 'CONTENT');

-- CreateTable
CREATE TABLE "Device" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "platform" "DevicePlatform" NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "appVersion" VARCHAR(32),
    "pushProvider" "PushProvider",
    "pushTokenEnc" TEXT,
    "pushTokenHash" VARCHAR(64),
    "pushUpdatedAt" TIMESTAMPTZ(3),
    "lastPushAt" TIMESTAMPTZ(3),
    "lastPushError" VARCHAR(120),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "userId" UUID NOT NULL,
    "pushEnabled" BOOLEAN NOT NULL DEFAULT true,
    "preview" "PushPreview" NOT NULL DEFAULT 'NONE',
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Device_sessionId_key" ON "Device"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Device_pushTokenHash_key" ON "Device"("pushTokenHash");

-- CreateIndex
CREATE INDEX "Device_userId_idx" ON "Device"("userId");

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

