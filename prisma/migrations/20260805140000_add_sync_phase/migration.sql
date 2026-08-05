-- Which stretch of a run syncTotalOrders/syncDoneOrders describe: "fetching"
-- (listing and expanding NetSuite orders) or "syncing" (writing the fetched set
-- to Shopify). Without it the progress counters only ever covered the syncing
-- half, so the log page's "N of M" line stayed blank for however long the
-- NetSuite fetch took — often the longer half of a run.
ALTER TABLE "NetsuiteAppSettings" ADD COLUMN IF NOT EXISTS "syncPhase" TEXT;
