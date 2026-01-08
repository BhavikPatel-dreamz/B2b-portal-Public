/*
  Warnings:

  - A unique constraint covering the columns `[shopId,email]` on the table `RegistrationSubmission` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[shopId,email]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "User_email_key";

-- AlterTable
ALTER TABLE "CompanyAccount" ADD COLUMN     "paymentTeam" TEXT;

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "storeOwnerName" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationSubmission_shopId_email_key" ON "RegistrationSubmission"("shopId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "User_shopId_email_key" ON "User"("shopId", "email");
