import { unauthenticated } from "../../shopify.server.js";
import { DEFAULT_TIME_ZONE, isValidTimeZone, resolveTimeZone } from "./index.js";

// Which timezone a shop's sync runs in.
//
//   SYNC_TIMEZONE set    -> that zone, for every shop
//   SYNC_TIMEZONE blank  -> the shop's own zone, as Shopify reports it
//   neither usable       -> UTC, which is what everything was before this existed
//
// The env var wins because the zone that decides what a run FETCHES is really the
// NetSuite account's, and that is not necessarily the Shopify store's. NetSuite
// evaluates the date literals in the order query against its own account
// timezone (see nsQueryDateTime), so on a store in one zone reading a NetSuite account
// configured in another, the store's zone is the wrong answer and SYNC_TIMEZONE is
// how you say which one to use. Where they agree — the common case — leaving it
// blank and letting the shop's zone through is right and needs no configuration.

// The shop's zone changes about never, and this is asked once per run per shop
// (and once per loader on the log page), so it is cached rather than re-queried.
// A TTL rather than forever: a store that fixes its zone in Shopify settings
// shouldn't have to wait for a deploy for the sync to notice.
const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map();

// Named so the warning below fires once per process rather than once per run — a
// typo in SYNC_TIMEZONE otherwise fills a cron log with the same line forever.
let warnedAboutEnv = false;

function envTimeZone() {
  const raw = (process.env.SYNC_TIMEZONE || "").trim();
  if (!raw) return null;
  if (isValidTimeZone(raw)) return raw;
  if (!warnedAboutEnv) {
    warnedAboutEnv = true;
    console.warn(
      `[timezone] SYNC_TIMEZONE="${raw}" is not a timezone this runtime knows — falling back to the shop's own zone. It must be an IANA name, e.g. "Asia/Kolkata" or "America/New_York".`,
    );
  }
  return null;
}

// What Shopify says the store's zone is. Best-effort by design: a failure here
// must not take a sync down, because the sync has a perfectly good answer without
// it (UTC, or the env override). Returns null and lets resolveTimeZone decide.
async function fetchShopTimeZone(shop) {
  try {
    const { admin } = await unauthenticated.admin(shop);
    const resp = await admin.graphql(`#graphql
      query ShopTimeZone { shop { ianaTimezone } }`);
    const body = await resp.json();
    const zone = body?.data?.shop?.ianaTimezone || null;
    if (zone && !isValidTimeZone(zone)) {
      console.warn(`[timezone] ${shop}: Shopify reported ianaTimezone "${zone}", which this runtime does not know — using ${DEFAULT_TIME_ZONE}.`);
      return null;
    }
    return zone;
  } catch (err) {
    console.warn(`[timezone] ${shop}: could not read the shop timezone (${err?.message || err}) — using ${DEFAULT_TIME_ZONE} unless SYNC_TIMEZONE is set.`);
    return null;
  }
}

export async function getSyncTimeZone(shop) {
  // Checked before the cache, so changing SYNC_TIMEZONE takes effect on the next
  // run rather than waiting out a cached shop lookup it now overrides anyway.
  const fromEnv = envTimeZone();
  if (fromEnv) return fromEnv;

  const hit = cache.get(shop);
  if (hit && hit.expires > Date.now()) return hit.zone;

  const shopZone = await fetchShopTimeZone(shop);
  const zone = resolveTimeZone(null, shopZone);
  cache.set(shop, { zone, expires: Date.now() + CACHE_TTL_MS });
  return zone;
}

// For a caller that already knows it cannot wait on a network round trip — or is
// on a path where a failure to resolve must not be retried per order. Returns the
// cached or env answer, never queries.
export function peekSyncTimeZone(shop) {
  return envTimeZone() || cache.get(shop)?.zone || DEFAULT_TIME_ZONE;
}

// Testing seam, and the escape hatch for a shop whose zone was cached wrong.
export function clearTimeZoneCache(shop) {
  if (shop) cache.delete(shop);
  else cache.clear();
}
