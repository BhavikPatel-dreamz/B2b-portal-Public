-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "companyWelcomeEmailEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "companyWelcomeEmailTemplate" TEXT;
