-- Delete for people, stores and businesses (hidden and anonymised; history kept).
ALTER TABLE "User" ADD COLUMN "deletedAt" TIMESTAMPTZ(3);
ALTER TABLE "Business" ADD COLUMN "deletedAt" TIMESTAMPTZ(3);
ALTER TABLE "Store" ADD COLUMN "deletedAt" TIMESTAMPTZ(3);
