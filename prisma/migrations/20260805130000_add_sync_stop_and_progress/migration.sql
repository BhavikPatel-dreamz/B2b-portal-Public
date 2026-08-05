-- The stop flag and the progress counters the log page's Stop sync button and
-- "n of m orders" line are built on. They were added to schema.prisma when that
-- feature landed but never given a migration, so every deployed database was
-- missing the columns: requestSyncStop's UPDATE failed and the button did
-- nothing.
ALTER TABLE "NetsuiteAppSettings" ADD COLUMN IF NOT EXISTS "syncStopRequestedAt" TIMESTAMP(3);
ALTER TABLE "NetsuiteAppSettings" ADD COLUMN IF NOT EXISTS "syncTotalOrders" INTEGER;
ALTER TABLE "NetsuiteAppSettings" ADD COLUMN IF NOT EXISTS "syncDoneOrders" INTEGER;
