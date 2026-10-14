-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "billToProvince" VARCHAR(40),
ADD COLUMN     "billToTaxNumber" VARCHAR(20),
ADD COLUMN     "fbrError" VARCHAR(500),
ADD COLUMN     "fbrInvoiceNumber" VARCHAR(60),
ADD COLUMN     "fbrSandbox" BOOLEAN,
ADD COLUMN     "fbrSubmittedAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "FbrConfig" (
    "businessId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "sandbox" BOOLEAN NOT NULL DEFAULT true,
    "tokenEnc" TEXT NOT NULL,
    "sellerNtnCnic" VARCHAR(20) NOT NULL,
    "sellerBusinessName" VARCHAR(160) NOT NULL,
    "sellerProvince" VARCHAR(40) NOT NULL,
    "sellerAddress" VARCHAR(300) NOT NULL,
    "defaultHsCode" VARCHAR(20) NOT NULL,
    "defaultSaleType" VARCHAR(120) NOT NULL,
    "defaultUom" VARCHAR(60) NOT NULL,
    "scenarioId" VARCHAR(10),
    "updatedById" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "FbrConfig_pkey" PRIMARY KEY ("businessId")
);

-- AddForeignKey
ALTER TABLE "FbrConfig" ADD CONSTRAINT "FbrConfig_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

