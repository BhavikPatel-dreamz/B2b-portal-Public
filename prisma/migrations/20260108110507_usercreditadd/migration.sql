/*
  Warnings:

  - Added the required column `userCreditUsed` to the `B2BOrder` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "B2BOrder" ADD COLUMN     "userCreditUsed" DECIMAL(14,2) NOT NULL;

-- AlterTable
ALTER TABLE "CreditTransaction" ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "userCreditLimit" DECIMAL(14,2),
ADD COLUMN     "userCreditUsed" DECIMAL(14,2) NOT NULL DEFAULT 0;
