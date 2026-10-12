-- "Delete for me": messages hidden for one person only.
-- CreateTable
CREATE TABLE "HiddenMessage" (
    "userId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HiddenMessage_pkey" PRIMARY KEY ("userId","messageId")
);

-- CreateIndex
CREATE INDEX "HiddenMessage_messageId_idx" ON "HiddenMessage"("messageId");

-- AddForeignKey
ALTER TABLE "HiddenMessage" ADD CONSTRAINT "HiddenMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HiddenMessage" ADD CONSTRAINT "HiddenMessage_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

