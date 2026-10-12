-- WhatsApp-style group settings: who can edit group info and who can add members.
ALTER TABLE "Conversation" ADD COLUMN "editInfoPolicy" "PostingPolicy" NOT NULL DEFAULT 'ADMINS_ONLY',
ADD COLUMN "addMembersPolicy" "PostingPolicy" NOT NULL DEFAULT 'ADMINS_ONLY';
