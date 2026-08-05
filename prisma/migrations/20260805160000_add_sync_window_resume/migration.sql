-- Resume cursor for a WINDOWED run ("last N hours" from the log page's
-- dropdown), mirroring syncListOffset's fix for the scheduled/watermark path:
-- without it, a window with more matching orders than NETSUITE_ORDER_LIMIT
-- capped at the same first N candidates every time the dropdown was pressed,
-- and repeated presses never reached the rest.
ALTER TABLE "NetsuiteAppSettings" ADD COLUMN IF NOT EXISTS "syncWindowOffset" INTEGER;
ALTER TABLE "NetsuiteAppSettings" ADD COLUMN IF NOT EXISTS "syncWindowQuery" TEXT;
ALTER TABLE "NetsuiteAppSettings" ADD COLUMN IF NOT EXISTS "syncWindowHours" INTEGER;
