/*
  Warnings:

  - You are about to drop the column `paymentTeam` on the `CompanyAccount` table. All the data in the column will be lost.
  - You are about to drop the column `additionalInfo` on the `RegistrationSubmission` table. All the data in the column will be lost.
  - You are about to drop the column `businessType` on the `RegistrationSubmission` table. All the data in the column will be lost.
  - You are about to drop the column `contactName` on the `RegistrationSubmission` table. All the data in the column will be lost.
  - You are about to drop the column `phone` on the `RegistrationSubmission` table. All the data in the column will be lost.
  - You are about to drop the column `reviewedBy` on the `RegistrationSubmission` table. All the data in the column will be lost.
  - You are about to drop the column `website` on the `RegistrationSubmission` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[shopifyOrderId]` on the table `B2BOrder` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `billing` to the `RegistrationSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `contactTitle` to the `RegistrationSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `firstName` to the `RegistrationSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `lastName` to the `RegistrationSubmission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `shipping` to the `RegistrationSubmission` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "B2BOrder" ADD COLUMN     "notes" TEXT;

-- AlterTable
ALTER TABLE "CompanyAccount" DROP COLUMN "paymentTeam",
ADD COLUMN     "isDisable" BOOLEAN DEFAULT false,
ADD COLUMN     "paymentTerm" TEXT;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "shopifyOrderId" TEXT,
ADD COLUMN     "title" TEXT;

-- AlterTable
ALTER TABLE "RegistrationSubmission" DROP COLUMN "additionalInfo",
DROP COLUMN "businessType",
DROP COLUMN "contactName",
DROP COLUMN "phone",
DROP COLUMN "reviewedBy",
DROP COLUMN "website",
ADD COLUMN     "billing" JSONB NOT NULL DEFAULT '{}'::jsonb,
ADD COLUMN     "contactTitle" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "customFields" JSONB,
ADD COLUMN     "firstName" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "isDisable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isPrivacyPolicy" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastName" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "shipping" JSONB NOT NULL DEFAULT '{}'::jsonb;

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "allowQuickOrderForUser" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "autoApproveB2BOnboarding" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "defaultCompanyCreditLimit" DECIMAL(14,2),
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "orderConfirmationToMainAccount" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "smtpFromEmail" TEXT,
ADD COLUMN     "smtpFromName" TEXT,
ADD COLUMN     "smtpHost" TEXT,
ADD COLUMN     "smtpPassEncrypted" TEXT,
ADD COLUMN     "smtpPort" INTEGER,
ADD COLUMN     "smtpSecure" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "smtpUser" TEXT;

-- AlterTable
ALTER TABLE "WishlistItem" ADD COLUMN     "soldOut" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "FormFieldConfig" (
    "id" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "shopId" TEXT NOT NULL,

    CONSTRAINT "FormFieldConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailTemplates" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "customerRegistration" BOOLEAN DEFAULT false,
    "customerRegistrationSubject" TEXT,
    "customerRegistrationTemplate" TEXT,
    "customerRegistrationApproved" BOOLEAN DEFAULT false,
    "customerRegistrationApprovedSubject" TEXT,
    "customerRegistrationApprovedTemplate" TEXT,
    "customerRegistrationRejected" BOOLEAN DEFAULT false,
    "customerRegistrationRejectedSubject" TEXT,
    "customerRegistrationRejectedTemplate" TEXT,
    "adminRequest" BOOLEAN DEFAULT false,
    "adminRequestSubject" TEXT,
    "adminRequestTemplate" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailTemplates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FormFieldConfig_shopId_key" ON "FormFieldConfig"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "B2BOrder_shopifyOrderId_key" ON "B2BOrder"("shopifyOrderId") WHERE "shopifyOrderId" IS NOT NULL;

-- CreateIndex
CREATE INDEX "B2BOrder_companyId_paymentStatus_orderStatus_idx" ON "B2BOrder"("companyId", "paymentStatus", "orderStatus");

-- CreateIndex
CREATE INDEX "B2BOrder_shopId_createdAt_idx" ON "B2BOrder"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "B2BOrder_createdAt_idx" ON "B2BOrder"("createdAt");

-- CreateIndex
CREATE INDEX "CompanyAccount_shopifyCompanyId_idx" ON "CompanyAccount"("shopifyCompanyId");

-- CreateIndex
CREATE INDEX "CreditTransaction_companyId_createdAt_idx" ON "CreditTransaction"("companyId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "RegistrationSubmission_shopId_createdAt_idx" ON "RegistrationSubmission"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "RegistrationSubmission_createdAt_idx" ON "RegistrationSubmission"("createdAt");

-- AddForeignKey
ALTER TABLE "FormFieldConfig" ADD CONSTRAINT "FormFieldConfig_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailTemplates" ADD CONSTRAINT "EmailTemplates_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
