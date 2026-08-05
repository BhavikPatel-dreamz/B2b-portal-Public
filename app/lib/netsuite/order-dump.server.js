import fs from "node:fs";
import path from "node:path";

import { getSyncRunState, setSyncTotal } from "./oauth.server.js";
import { fetchSalesOrders, targetedOrderIds } from "./client.server.js";

// ---------------------------------------------------------------------------
// Dump the NETSUITE_ORDER_IDS orders to a JSON log
// ---------------------------------------------------------------------------
// A diagnostic: "show me exactly what NetSuite returns for these orders". Set
// NETSUITE_ORDER_IDS, call the endpoint (app/routes/api.netsuite.order-dump.jsx),
// read the file. It is the answer to "the sync did something odd with SO20742"
// when the log page's row detail isn't enough and you want the raw record.
//
// READ-ONLY, deliberately and completely:
//
//   • nothing is written to Shopify — no order is created, updated or deleted
//   • the sync watermark is not moved, so the scheduled run still owes
//     everything it owed before
//   • no sync lock is taken, so this cannot collide with a cron tick and cannot
//     make one skip
//   • the run-progress counters are put back exactly as they were (see below)
//
// which together mean it is safe to call as often as you like, including while a
// real sync is running.

const LOG_DIR = "storage/logs";

// One file per shop per day, matching the naming of the text run log next to it
// (order-sync-<shop>-<day>.log) so the two sort together in a directory listing.
//
// The shop reaches this from a query parameter, so it is scrubbed to the
// characters a Shopify domain can actually contain before it becomes a path.
// The route also checks the shop is installed, which is the real guard; this is
// the one that stops a path separator becoming a directory traversal even if
// that check is ever loosened.
function dumpPath(shop, at) {
  const safeShop = String(shop).toLowerCase().replace(/[^a-z0-9.-]/g, "_");
  const day = at.toISOString().slice(0, 10);
  return path.join(path.resolve(LOG_DIR), `netsuite-orders-${safeShop}-${day}.json`);
}

// The day's file, or an empty shell if today's first call hasn't written one.
//
// A file that exists but doesn't parse is NOT overwritten — it is moved aside
// with a .corrupt suffix first. It is only a debug log, but it is a debug log
// someone may be in the middle of reading, and silently replacing it would
// destroy the very thing they were trying to look at.
function readDump(file, shop) {
  const empty = { shop, entries: [] };
  if (!fs.existsSync(file)) return empty;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed?.entries) ? parsed : empty;
  } catch {
    const aside = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, aside);
      console.warn(`[netsuite-dump] ${file} did not parse as JSON — moved to ${aside} and starting a new one.`);
    } catch (err) {
      console.warn(`[netsuite-dump] ${file} did not parse and could not be moved aside: ${err?.message || err}`);
    }
    return empty;
  }
}

// Fetching goes through fetchSalesOrders, which reports progress as it works —
// that is what drives the log page's bar during a real run. A dump is not a run,
// so leaving those counters where it left them would rewrite the schedule card's
// "Last run — N of M orders" with numbers from a diagnostic nobody ran as a sync.
//
// Snapshotted and put back instead. Restoring is best-effort: failing to tidy up
// a progress bar is not a reason to throw away the dump that already succeeded.
async function restoreProgress(shop, before) {
  try {
    await setSyncTotal(shop, before.totalOrders, before.doneOrders ?? 0, before.phase || "syncing");
  } catch (err) {
    console.warn(`[netsuite-dump] ${shop}: could not restore the run-progress counters: ${err?.message || err}`);
  }
}

// Reads the targeted orders out of NetSuite and appends one entry to today's
// file. `ids` overrides NETSUITE_ORDER_IDS for a single call, so the endpoint can
// be pointed at an order without an env change and a redeploy.
//
// Returns what the route reports back; it never throws for an ordinary failure
// (nothing targeted, NetSuite unreachable) — those are answers, not crashes.
export async function dumpTargetedOrders(shop, { ids } = {}) {
  const requested = (ids?.length ? ids : targetedOrderIds()).map((v) => String(v).trim()).filter(Boolean);
  const source = ids?.length ? "request" : "NETSUITE_ORDER_IDS";
  if (!requested.length) {
    return {
      ok: false,
      error: "No orders to dump: NETSUITE_ORDER_IDS is not set and no ids were given in the request.",
    };
  }

  const at = new Date();
  const before = await getSyncRunState(shop);

  let feed;
  try {
    // The same call the sync makes, so what lands in the file is exactly what a
    // real run would have to work with — including the enrichment (linked
    // invoices, tracking numbers, the customer-record email fallback), which is
    // usually the half that explains a surprising result.
    feed = await fetchSalesOrders(shop, { ids: requested });
  } catch (err) {
    await restoreProgress(shop, before);
    return { ok: false, error: `NetSuite fetch failed: ${err?.message || err}` };
  }
  await restoreProgress(shop, before);

  const orders = Array.isArray(feed?.items) ? feed.items : [];
  const entry = {
    at: at.toISOString(),
    source,
    requestedIds: requested,
    // Which identifiers came back as orders and which matched nothing. An id
    // that resolved to no sales order is the single most common reason this file
    // is emptier than expected, so it is stated rather than left to be inferred
    // from a shorter list than was asked for.
    found: orders.map((o) => ({ id: String(o.id), tranId: o.tranId ?? null })),
    unresolved: (feed?.errors || []).map(({ id, error }) => ({ id: String(id), error })),
    orders,
  };

  const file = dumpPath(shop, at);
  try {
    fs.mkdirSync(path.resolve(LOG_DIR), { recursive: true });
    const doc = readDump(file, shop);
    doc.shop = shop;
    doc.updatedAt = at.toISOString();
    doc.entries.push(entry);
    // Written whole rather than appended, because the file is one JSON document
    // and has to stay parseable. Via a temp file + rename so a reader never sees
    // a half-written document: rename is atomic within a filesystem.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    fs.renameSync(tmp, file);
    return {
      ok: true,
      file,
      at: entry.at,
      source,
      requested: requested.length,
      dumped: orders.length,
      unresolved: entry.unresolved,
      entriesInFile: doc.entries.length,
    };
  } catch (err) {
    // The fetch worked; only the write didn't. Say so plainly — "dump failed"
    // would send someone to look at NetSuite for a disk problem.
    return {
      ok: false,
      error: `Fetched ${orders.length} order(s) but could not write ${file}: ${err?.message || err}`,
    };
  }
}
