-- How far into the current watermark period's day-granular candidate list a
-- previous scheduled run got before NETSUITE_ORDER_LIMIT capped it. Without
-- this, a backlog bigger than the limit reprocessed the same first N
-- candidates on every run and never reached the rest of the backlog.
ALTER TABLE "NetsuiteAppSettings" ADD COLUMN IF NOT EXISTS "syncListOffset" INTEGER;
