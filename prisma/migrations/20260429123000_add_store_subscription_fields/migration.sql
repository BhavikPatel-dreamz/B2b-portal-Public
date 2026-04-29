-- Add subscription tracking fields to Store
ALTER TABLE "Store"
ADD COLUMN IF NOT EXISTS "plan" TEXT,
ADD COLUMN IF NOT EXISTS "planKey" TEXT;
