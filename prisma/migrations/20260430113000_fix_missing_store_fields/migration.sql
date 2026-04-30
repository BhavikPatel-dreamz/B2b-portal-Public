-- Corrective migration for Store fields that exist in schema.prisma
-- but were never applied because earlier migration folders were empty.
ALTER TABLE "Store"
ADD COLUMN IF NOT EXISTS "currencyCode" TEXT DEFAULT 'USD',
ADD COLUMN IF NOT EXISTS "privacyPolicylink" TEXT,
ADD COLUMN IF NOT EXISTS "privacyPolicyContent" TEXT,
ADD COLUMN IF NOT EXISTS "completedSetupSteps" JSONB,
ADD COLUMN IF NOT EXISTS "setupFinished" BOOLEAN NOT NULL DEFAULT false;
