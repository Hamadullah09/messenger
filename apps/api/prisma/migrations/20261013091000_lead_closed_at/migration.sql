-- When a lead was won or lost.
ALTER TABLE "Lead" ADD COLUMN "closedAt" TIMESTAMPTZ(3);
