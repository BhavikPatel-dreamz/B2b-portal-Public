import fs from "node:fs";
import path from "node:path";
import { unauthenticated } from "../../shopify.server.js";
import { extraFunction } from "../cron/extra-function.server.js";
import { targetedOrderIds } from "../netsuite/client.server.js";
import { quarantinedOrders } from "./log.server.js";
import { parseCustomRange, rangeLabel, windowLabel, windowRange } from "./windows.js";
import { DEFAULT_TIME_ZONE } from "../timezone/index.js";
import { acquireSyncLock, advanceWatermarkToWindow, bumpSyncDone, getLastSyncedAt, isSyncStopRequested, isSyncStoppedError, releaseSyncLock, setLastSyncedAt, setSyncTotal } from "../netsuite/oauth.server.js";

// ---------------------------------------------------------------------------
// NetSuite feed
// ---------------------------------------------------------------------------
// By default (NETSUITE_USE_DEMO=true) this returns the local demo JSON, shaped
// like a real SuiteTalk REST salesOrder response. Set NETSUITE_USE_DEMO=false
// and fill the NETSUITE_* creds in .env to hit the live NetSuite API.
// Either way the returned shape is { items: [ salesOrder, ... ] }.

import { ordersToCsv, ordersToExcel } from "./export.js";
import { fetchExternalOrders } from "./feed.server.js";
import { mapNetsuiteOrder } from "./mapping.js";
import { MANUAL_MODE, appendSyncLogRow, logSyncCrash, pruneSyncLogs, saveSyncLogRows, syncLogBase, writeSyncLog } from "./run-log.server.js";
import { getShopCurrency } from "./shopify/common.server.js";
import { buildOrderInput, createOrder } from "./shopify/create.server.js";
import { resolveShopifyOrder } from "./shopify/match.server.js";
import { deleteOrder, syncTracking } from "./shopify/tracking.server.js";

export { logSyncCrash } from "./run-log.server.js";

// ---------------------------------------------------------------------------
// Main entry — called by the scheduled run
// ---------------------------------------------------------------------------
// Two runs for the same shop must never overlap (see acquireSyncLock), so the
// lock is held for the whole run and released however the run ends. A call that
// arrives while the previous one is still working is reported as skipped rather
// than queued — the next tick will pick the window up anyway.
//
// `options.window` ({ from, to, hours }) narrows the run to the NetSuite orders
// modified in that stretch instead of the watermark's — see buildSyncWindow.
//
// `options.lock` is a lock the CALLER already holds (startCronJobs takes it for
// the whole job list, so a run that is started in the background is visibly
// running before its route returns). When it is passed, this function neither
// acquires nor releases — whoever took it owns it.
export async function syncOrdersFromFeed(shop, options = {}) {
  const runStartedAt = new Date();
  if (options.lock) return runOrderSync(shop, runStartedAt, options);

  const lock = await acquireSyncLock(shop, runStartedAt);
  if (!lock.acquired) {
    const heldSince = lock.heldSince?.toISOString() || "unknown";
    console.warn(`[order-sync] ${shop}: a sync started at ${heldSince} is still running — skipping this run.`);
    return {
      shop,
      skipped: true,
      reason: `another sync run (started ${heldSince}) is still in progress`,
    };
  }
  try {
    return await runOrderSync(shop, runStartedAt, options);
  } finally {
    await releaseSyncLock(shop, lock.token);
  }
}

// An explicit stretch of NetSuite modification time, ending now — "everything
// that changed in the last 2 hours", as picked from the log page's range
// dropdown. Handed to syncOrdersFromFeed as `options.window`, which makes the run
// the scheduled one with its window supplied by hand instead of by the watermark:
// same lock (it must not run alongside the cron and fight it over an order), same
// per-order path, same logging.
//
// Such a run never moves the watermark, for the same reason a targeted re-sync
// doesn't: it answered a question about one stretch of time, and advancing the
// watermark to now would permanently skip everything the scheduled run still owes
// from before that stretch.
export function buildSyncWindow(hours) {
  const n = Number(hours);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`invalid sync window: ${hours}`);
  }
  // windowRange, not the arithmetic written out again: the log page shows the
  // same pair under the dropdown before the button is pressed, and a preview
  // that drifted from the run it previews would be worse than no preview.
  return { ...windowRange(n), hours: n, label: windowLabel(n) };
}

// The same thing for a range given as two dates rather than as a number of hours
// back from now — the log page's "Custom range" option. It produces the identical
// `options.window` shape, so every path below this point (the NetSuite query, the
// per-order sync, the log rows, the watermark left alone) is shared with the
// presets and there is no second code path for a hand-typed range.
//
// The two ends are whole UTC days (see parseCustomRange), and `hours` is their
// span — kept only because the resume session records it; nothing infers the
// window from it. `custom` is what stops a range being mistaken for a preset of
// the same span, back when a capped run could resume from a saved offset.
export function buildCustomSyncWindow(fromValue, toValue, timeZone = DEFAULT_TIME_ZONE) {
  const range = parseCustomRange(fromValue, toValue, timeZone);
  if (range.error) throw new Error(`invalid sync window: ${range.error}`);
  const { from, to } = range;
  return {
    from,
    to,
    hours: Math.round((to.getTime() - from.getTime()) / (60 * 60 * 1000)),
    custom: true,
    label: rangeLabel(from, to, timeZone),
  };
}


// How long a single run may spend processing orders. Cron intervals are short and
// hosts kill long requests, so the run stops cleanly at the budget instead of
// being cut off mid-order: what it finished is logged, the watermark is left where
// it was, and the next run picks up the rest.
const DEFAULT_MAX_RUN_MS = 10 * 60 * 1000;

function maxRunMs() {
  const n = Number(process.env.SYNC_MAX_RUN_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_RUN_MS;
}

// The per-order sync itself, over whatever set of NetSuite records it was handed.
// Shared by the scheduled run and by a manual re-sync of hand-picked orders
// (runResync), so both take exactly the same path per order.
//
// `results` is appended to in place — the caller has usually already put the
// fetch failures in it, and the stopped-early message counts them as work done.
// Returns the stopped-early reason, or null if it got through every record.
export async function processOrderRecords({ admin, shop, records, currencyCode, caches, deadline, results, onResult }) {
  for (const rec of records) {
    const entry = mapNetsuiteOrder(rec);
    const { externalId, action } = entry;
    // Checked between orders, never inside one: an order is created, tagged and
    // linked to its company across several calls, and abandoning it half way is
    // worse than running a minute over.
    if (Date.now() > deadline) {
      const stoppedEarly = `run time budget reached after ${results.length} of ${records.length} order(s) — the rest are left for the next run`;
      console.warn(`[order-sync] ${shop}: ${stoppedEarly}`);
      return stoppedEarly;
    }
    // Stop sync, pressed on the log page. Checked in the same place and for the
    // same reason as the budget above: an order is created, tagged and linked to
    // its company across several calls, so the only safe place to stop is
    // between two of them. What is already done stays done, the watermark is
    // left where it was (a stopped-early run never advances it), and the next
    // run picks the rest up.
    if (await isSyncStopRequested(shop)) {
      const stoppedEarly = `stopped by hand after ${results.length} of ${records.length} order(s) — the rest are left for the next run`;
      console.warn(`[order-sync] ${shop}: ${stoppedEarly}`);
      return stoppedEarly;
    }
    try {
      let outcome;
      if (action === "delete") {
        outcome = await deleteOrder(admin, entry);
      } else {
        // upsert: work out which Shopify order (if any) this NetSuite order
        // belongs to. A match is a tracking-only update — never a full
        // overwrite. Only an unmatched NetSuite-native order is created.
        const match = await resolveShopifyOrder(admin, entry);
        if (match.id) {
          outcome = await syncTracking(admin, entry, match.id, match.via);
        } else if (match.allowCreate) {
          outcome = await createOrder(admin, entry, currencyCode, caches);
        } else {
          outcome = { ok: true, action: "skip", skipped: true, matchedBy: match.via, reason: match.reason };
        }
      }
      // `reference` (the SO number) rides along so the run log and the API
      // response name orders the way NetSuite users do, not just by internal id.
      const result = { externalId, reference: entry.reference, action: outcome.action || action, ...outcome };
      results.push(result);
      // Straight into the table, before the next order is started — this is what
      // makes the log fill in live instead of arriving in one batch at the end.
      await onResult?.(result);
    } catch (err) {
      // A NetSuite call that gave up because the run was stopped is not this
      // order failing — recording it as one would leave a red row in the log
      // blaming the order for a button someone pressed. The order is simply not
      // done: the watermark stays put and the next run picks it up.
      if (isSyncStoppedError(err)) {
        const stoppedEarly = `stopped by hand after ${results.length} of ${records.length} order(s) — the rest are left for the next run`;
        console.warn(`[order-sync] ${shop}: ${stoppedEarly}`);
        return stoppedEarly;
      }
      // A failed order gets its row too, and gets it now: a failure is exactly
      // the row someone is waiting to see, and holding it back until the run ends
      // is the opposite of useful.
      const failure = { externalId, reference: entry.reference, action, ok: false, error: err?.message || String(err) };
      results.push(failure);
      await onResult?.(failure);
    }
    // Counted here, outside the try, because "done" means "this run is finished
    // with this order" — a failed one is as done as a successful one, and a
    // progress count that stalled on failures would read as a hung sync.
    await bumpSyncDone(shop);
  }
  return null;
}

function summarise(results) {
  return {
    total: results.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  };
}

// ---------------------------------------------------------------------------
// Manual re-sync — called by the log page's Sync buttons
// ---------------------------------------------------------------------------
// Re-runs specific NetSuite orders, given as internal ids or SO numbers. It is
// the scheduled run narrowed to a hand-picked set: same lock (a re-sync must not
// run alongside the cron and fight it over the same order), same per-order path,
// same file/database logging — so the retry shows up in the log table as its own
// run, next to the failure it was retrying.
//
// The watermark is never moved. Like a targeted run, this looked at only the
// orders it was asked about, so advancing it would permanently skip everything
// else modified in the meantime. SYNC_ORDER_EXPORT is ignored too: a re-sync is
// an explicit "write this order to Shopify now", not a preview.
//
// Started, NOT awaited — same trick as startCronJobs, and for the same reason:
// this used to hold the browser's request open for the whole re-sync (a fetch
// from NetSuite plus a second of rate-limit sleep per order), and the log
// page's syncRunning — the thing that shows progress and the Stop button — is
// read from the LOADER. The loader only learns a re-sync is happening once this
// request returns, so while it stayed open for the full run, Sync selected and
// the per-row Sync button both looked, from the page's side, like nothing was
// running at all: no progress, no way to stop. Returning as soon as the lock is
// held fixes that the same way it already worked for Sync now.
// `knownInternalIds`, if given, is the subset of `ids` the caller already knows
// to be NetSuite internal ids rather than SO numbers a human typed — a re-sync
// row's own externalId, for instance. It buys those a direct lookup instead of
// resolveOrderId's tranId-search-first ambiguity handling — see
// resolveKnownInternalId in netsuite.server.js for why that matters for how long
// a re-sync of one or two known rows takes.
export async function startResync(shop, ids, { knownInternalIds } = {}) {
  const requested = [...new Set((ids || []).map((v) => String(v).trim()).filter(Boolean))];
  if (!requested.length) {
    return { started: false, requested, reason: "nothing to sync" };
  }

  const runStartedAt = new Date();
  const lock = await acquireSyncLock(shop, runStartedAt);
  if (!lock.acquired) {
    return { started: false, requested, heldSince: lock.heldSince ?? null };
  }

  const promise = (async () => {
    try {
      return await runResync(shop, requested, runStartedAt, knownInternalIds);
    } catch (err) {
      // Died before it produced a summary — a NetSuite auth failure, a Shopify
      // connection error. There is no request left to report this to, so it is
      // logged the way a crashed cron job is, leaving a trace in the table
      // instead of only in a console nobody is watching.
      await logSyncCrash(shop, runStartedAt, err);
      throw err;
    } finally {
      await releaseSyncLock(shop, lock.token);
    }
  })();
  // Nothing may reject out of here unobserved — see startCronJobs for why.
  promise.catch((err) => {
    console.error(`[order-sync] ${shop}: re-sync failed outside its own handling: ${err?.message || err}`);
  });

  return { started: true, requested, promise };
}

// The actual work of a re-sync, once startResync is holding the lock.
async function runResync(shop, requested, runStartedAt, knownInternalIds) {
  const feed = await fetchExternalOrders(shop, { ids: requested, knownInternalIds });
  const records = Array.isArray(feed?.items) ? feed.items : [];
  // Orders that could not be fetched (or resolved to a sales order at all) are
  // failures of this re-sync, not silent no-ops.
  const results = (feed?.errors || []).map(({ id, error }) => ({
    externalId: String(id),
    action: "fetch",
    ok: false,
    error: `NetSuite fetch failed: ${error}`,
  }));

  const { admin } = await unauthenticated.admin(shop);
  const currencyCode = await getShopCurrency(admin);
  const caches = { company: new Map(), variant: new Map() };
  // Stopped while the ids were still being resolved, or straight after. A
  // re-sync moves no watermark, so unlike the scheduled run there is nothing to
  // protect here — it simply does none of the orders rather than an arbitrary
  // prefix of the ones that were ticked.
  //
  // Checked BEFORE setSyncTotal below, same as runOrderSync: fetchNetsuiteOrders
  // already left "fetching" progress behind (how many of the requested ids it
  // got through), and a stopped run should keep reporting that rather than
  // being overwritten with a "syncing" total that never moves off 0.
  const stopped = feed?.stopped || (await isSyncStopRequested(shop));
  // What every row this run writes has in common. Built before the loop, because
  // the rows are now written DURING it rather than from the finished run object.
  const logBase = syncLogBase({ shop, startedAt: runStartedAt.toISOString(), mode: MANUAL_MODE });
  // Which results already have their row, so the end-of-run write doesn't repeat
  // them. Identity, not id: two attempts at the same order are two results.
  const logged = new Set();
  let stoppedEarly;
  if (stopped) {
    stoppedEarly = `stopped by hand before any of the ${records.length} re-synced order(s) were written`;
    console.warn(`[order-sync] ${shop}: ${stoppedEarly}`);
  } else {
    // A hand-picked re-sync holds the same lock and shows up in the same place
    // on the page, so it reports progress the same way a scheduled run does.
    await setSyncTotal(shop, records.length);
    stoppedEarly = await processOrderRecords({
      admin,
      shop,
      records,
      currencyCode,
      caches,
      deadline: runStartedAt.getTime() + maxRunMs(),
      results,
      // One row per order, written as that order finishes — see appendSyncLogRow.
      onResult: (r) => {
        logged.add(r);
        return appendSyncLogRow(logBase, r);
      },
    });
  }

  const summary = summarise(results);

  // The extra work runs after a re-sync too, so this path doesn't quietly do
  // less than the others. The cron and Sync now reach it through CRON_JOBS; a
  // re-sync never touches that list — it is deliberately narrowed to the orders
  // that were ticked — so the one job that is about the SHOP rather than about
  // this run's orders is called here directly.
  //
  // Best effort, because by this point the orders are already in Shopify:
  // failing to do the extra work is not a reason to report the re-sync as
  // broken. It is reported instead.
  let extra;
  try {
    extra = await extraFunction(shop);
  } catch (err) {
    extra = { failed: true, error: err?.message || String(err) };
    console.warn(`[order-sync] ${shop}: extraFunction failed after the re-sync: ${extra.error}`);
  }

  const run = {
    shop,
    mode: MANUAL_MODE,
    startedAt: runStartedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    targeted: requested,
    summary,
    results,
    stoppedEarly,
    extra,
  };
  const logFile = writeSyncLog(run);
  await saveSyncLogRows(run, logged);
  return {
    shop,
    requested,
    summary,
    results,
    logFile,
    extra,
    ...(stoppedEarly ? { stoppedEarly } : {}),
  };
}

async function runOrderSync(shop, runStartedAt, { window } = {}) {
  // Targeted mode (NETSUITE_ORDER_IDS) fetches a hand-picked set of orders and
  // ignores the date window, so such a run must never move the watermark.
  const targeted = targetedOrderIds();
  // A windowed run doesn't read the watermark at all — its window was given to it.
  // `since` still stands for "the oldest modification time this run looked at", so
  // the log lines below read the same either way.
  const since = window ? window.from : await getLastSyncedAt(shop);
  // One list call, one batch. There is no resume session and no backlog carried
  // between runs any more: the filter is asked once, and whatever it returns is
  // what this run syncs. If it matched more than the page limit, the fetch
  // reports `capped` and the watermark is left where it is, so the next run asks
  // the same question rather than moving past orders it never saw.
  const feed = await fetchExternalOrders(shop, window ? { window } : { since });
  let records = Array.isArray(feed?.items) ? feed.items : [];

  // Stop sync, pressed while the fetch was in flight. Fetching is the longest
  // stretch of a big run — NetSuite is paged and then each order is expanded
  // with a second of rate-limit sleep between — so the fetch stops itself part
  // way through and says so in `feed.stopped`, and this is where that lands:
  // before anything is written to Shopify, exported, or logged as synced.
  //
  // Both conditions are asked, because they are different facts. `feed.stopped`
  // means the fetch broke off and the records in hand are an arbitrary prefix of
  // the run's real scope — syncing them and advancing the watermark would skip
  // the rest for good. The flag means the press landed after the fetch finished.
  // Note this is checked BEFORE the export branch too, so a stopped dry run
  // doesn't leave a set of export files behind describing work that was called off.
  if (feed?.stopped || (await isSyncStopRequested(shop))) {
    const stoppedEarly = feed?.stopped
      ? `stopped by hand while fetching — ${records.length} order(s) had been read and none were synced`
      : `stopped by hand before any of the ${records.length} fetched order(s) were synced`;
    console.warn(`[order-sync] ${shop}: ${stoppedEarly}`);
    const run = {
      shop,
      mode: window ? `window sync (${window.label})` : undefined,
      startedAt: runStartedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      since: since?.toISOString() || null,
      window,
      targeted,
      summary: { total: 0, ok: 0, failed: 0 },
      results: [],
      stoppedEarly,
    };
    const logFile = writeSyncLog(run);
    await saveSyncLogRows(run);
    return { shop, stopped: true, stoppedEarly, summary: run.summary, results: [], logFile };
  }

  // What this run has to get through. Set before any of it is done, so the page
  // can show "0 of 50" rather than nothing at all — the log rows do not arrive
  // until the run ends, and on a 50-order run that is minutes of silence.
  // What every row this run writes has in common — same shape the run object
  // below produces, so a row written mid-run is indistinguishable from one the
  // old end-of-run batch would have written.
  const logBase = syncLogBase({
    shop,
    startedAt: runStartedAt.toISOString(),
    mode: window ? `window sync (${window.label})` : undefined,
  });
  // See the note on the same set in runResync.
  const logged = new Set();
  // The bar counts the orders THIS run has: what the list call returned, and how
  // many of them are finished. Not feed.capped.matched — on a capped run that is
  // how many the filter matched in NetSuite, which this run is not going to
  // sync, and a bar measured against it would stop short of 100% every time and
  // read as a run that stalled.
  await setSyncTotal(shop, records.length);

  if (process.env.SYNC_ORDER_EXPORT === "true") {
    const exportDir = path.resolve("storage/exports");
    fs.mkdirSync(exportDir, { recursive: true });
    const timestamp = runStartedAt.toISOString().replace(/[:.]/g, "-");
    const mapped = records.map(mapNetsuiteOrder);

    // Raw NetSuite records
    const jsonPath = path.join(exportDir, `orders-${shop}-${timestamp}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify({ shop, exportedAt: runStartedAt.toISOString(), since: since?.toISOString() || null, raw: records, mapped }, null, 2));

    const csvPath = path.join(exportDir, `orders-${shop}-${timestamp}.csv`);
    fs.writeFileSync(csvPath, ordersToCsv(mapped));

    const xlsxPath = path.join(exportDir, `orders-${shop}-${timestamp}.xlsx`);
    fs.writeFileSync(xlsxPath, ordersToExcel(mapped));

    // Shopify orderCreate input preview — exact objects that would be sent
    const currencyCode = "USD";
    const shopifyInputs = mapped.map((entry) => ({
      netsuiteId: entry.externalId,
      netsuiteRef: entry.reference,
      action: entry.action,
      // The company whose Shopify location the real create would resolve and
      // attach (companyLocationId) — it can't be looked up here, this block runs
      // before an admin client exists.
      netsuiteCompany: entry.companyName,
      shopifyOrderInput: buildOrderInput(entry, currencyCode),
      options: { sendReceipt: false, sendFulfillmentReceipt: false },
    }));
    const previewPath = path.join(exportDir, `shopify-preview-${shop}-${timestamp}.json`);
    fs.writeFileSync(previewPath, JSON.stringify({ shop, currencyCode, exportedAt: runStartedAt.toISOString(), orders: shopifyInputs }, null, 2));

    if (process.env.NETSUITE_USE_DEMO === "false" && !targeted.length && !window) {
      await setLastSyncedAt(shop, runStartedAt, since);
    }
    // A dry run handled every record it fetched, in one step — see setSyncTotal.
    await setSyncTotal(shop, mapped.length, mapped.length);
    const exportRun = {
      shop,
      mode: "export (dry run — nothing written to Shopify)",
      startedAt: runStartedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      since: since?.toISOString() || null,
      window,
      targeted,
      summary: { total: mapped.length, ok: mapped.length, failed: (feed?.errors || []).length },
      results: (feed?.errors || []).map(({ id, error }) => ({
        externalId: String(id), action: "fetch", ok: false, error: `NetSuite fetch failed: ${error}`,
      })),
      files: { json: jsonPath, csv: csvPath, xlsx: xlsxPath, preview: previewPath },
    };
    const logFile = writeSyncLog(exportRun);
    await saveSyncLogRows(exportRun);
    return { shop, mode: "export", jsonFile: jsonPath, csvFile: csvPath, xlsxFile: xlsxPath, previewFile: previewPath, logFile, total: mapped.length, since: since?.toISOString() || null };
  }

  const { admin } = await unauthenticated.admin(shop);
  const currencyCode = await getShopCurrency(admin);

  // Orders NetSuite listed but whose detail fetch failed never became records
  // above — surface them as failed results instead of dropping them silently.
  const results = (feed?.errors || []).map(({ id, error }) => ({
    externalId: String(id),
    action: "fetch",
    ok: false,
    error: `NetSuite fetch failed: ${error}`,
  }));
  // Company-location and sku->variant lookups, shared across the whole run: a
  // window normally holds many orders for the same handful of companies and
  // repeats the same items across orders.
  const caches = { company: new Map(), variant: new Map() };
  const deadline = runStartedAt.getTime() + maxRunMs();
  // A capped fetch means the same thing to the watermark as running out of time:
  // orders matching this run's filter were never listed, so it must not move
  // past them. Worded the same for both kinds of run now — neither continues on
  // its own. Without paging, a run asks its filter once and gets at most one
  // page; the way to reach the rest is to raise the limit (1000 is the REST
  // maximum) or narrow the range so fewer orders match.
  const cappedMessage = (f) =>
    f?.capped
      ? `${f.capped.matched} order(s) match this filter but NetSuite returns at most ${f.capped.limit} per call — ${f.capped.skipped} were not listed. Narrow the range to reach them; the next run asks the same question.`
      : null;

  // One batch, processed once. The run used to keep fetching further batches in
  // place to drain a backlog; without paging there is no backlog to drain — the
  // single list call already returned everything this run will act on, and
  // anything past the page limit is reported as capped and left for the next run.
  const capped = cappedMessage(feed);
  const stoppedEarly = (await processOrderRecords({
    admin, shop, records, currencyCode, caches, deadline, results,
    onResult: (r) => {
      logged.add(r);
      return appendSyncLogRow(logBase, r);
    },
  })) || capped;

  const summary = summarise(results);

  // Orders that have failed so many runs in a row that they are no longer allowed
  // to hold the watermark back (see quarantinedOrders). Marked on the result
  // itself so the log row and its detail dialog say so — a quarantined order is
  // still failed, still listed, still re-syncable by hand; the only thing that
  // changed is that the rest of the sync gets to move past it.
  const failures = results.filter((r) => !r.ok);
  // Never allowed to fail the run: quarantine status is an annotation on results
  // that are already final. A DB hiccup here must not cost every per-order log
  // row this run already earned — see saveSyncLogRows, the one place they're
  // written, at the end of this function.
  let quarantined = new Map();
  if (failures.length) {
    try {
      quarantined = await quarantinedOrders(shop, failures);
    } catch (err) {
      console.warn(`[order-sync] ${shop}: could not check quarantine status: ${err?.message || err}`);
    }
  }
  for (const failure of failures) {
    const attempts = quarantined.get(String(failure.externalId || "") || failure.reference);
    if (attempts) {
      failure.attempts = attempts;
      failure.quarantined = true;
    }
  }
  // A failure that is NOT quarantined is what parks the watermark.
  const blocking = failures.length - quarantined.size;

  // Advance the watermark only on a fully clean run that ALSO reached the end
  // of this period's candidate list. If anything failed (a NetSuite fetch
  // error or a Shopify create/update error), we leave it where it was so the
  // next run re-pulls the same window and retries — the sync is idempotent, so
  // re-processing succeeded orders is harmless. A run that stopped at its time
  // budget is in the same position: orders in the window were never looked at,
  // and moving the watermark past them would skip them for good. Demo mode
  // never advances the watermark (there's no real modified-date to track), and
  // neither does a targeted run — it only looked at a hand-picked set of
  // orders, so moving the watermark would permanently skip everything else
  // modified in the meantime.
  // A windowed run (Sync now) advances it too, but to the END OF ITS WINDOW
  // rather than to now — see advanceWatermarkToWindow, which also refuses to move
  // it backwards. It used to leave the watermark alone entirely, on the grounds
  // that a hand-picked window says nothing about the stretch before it. That is
  // still true, and it is the cost of this: whatever the schedule owed from
  // before the window is now behind the watermark unread. The reason it is worth
  // paying is the state it replaces — a shop whose scheduled runs have never
  // finished cleanly has no watermark at all, so every run re-reads the whole
  // NETSUITE_INITIAL_SYNC_DAYS lookback (50 days on this account) no matter how
  // many hand-run syncs have succeeded in the meantime.
  // Cursor bookkeeping below is best-effort, same reasoning as quarantinedOrders
  // above: results are already final, so a write failure here must move on to
  // saveSyncLogRows rather than take the run's log rows down with it. Worst case
  // a cursor doesn't advance and the next run re-covers the same ground —
  // annoying, not data loss.
  try {
    if (process.env.NETSUITE_USE_DEMO === "false" && !targeted.length) {
      if (blocking === 0 && !stoppedEarly) {
        // Fully clean AND the day-granular candidate list for this period was
        // exhausted (not capped) — this period is completely drained.
        // `since` rides along so the schedule card can say what this run
        // covered, not only when it ran. setLastSyncedAt also resets the
        // list-offset cursor, so the fresh period that starts next lists from
        // the top rather than resuming a position that no longer means anything.
        if (window) await advanceWatermarkToWindow(shop, window);
        else await setLastSyncedAt(shop, runStartedAt, since);
      }
      // Capped, or a genuine failure blocked progress: the watermark stays
      // exactly where it was, so the next run asks the same question and the
      // orders this one could not reach come up again.
    }
  } catch (err) {
    console.warn(`[order-sync] ${shop}: could not update the sync watermark/offset: ${err?.message || err}`);
  }

  const run = {
    shop,
    mode: window ? `window sync (${window.label})` : undefined,
    startedAt: runStartedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    since: since?.toISOString() || null,
    window,
    outsideWindow: feed?.outsideWindow || 0,
    quarantined: [...quarantined.entries()].map(([order, attempts]) => ({ order, attempts })),
    targeted,
    summary,
    results,
    stoppedEarly,
  };
  const logFile = writeSyncLog(run);
  await saveSyncLogRows(run, logged);
  await pruneSyncLogs(shop);
  return {
    shop,
    summary,
    results,
    logFile,
    ...(stoppedEarly ? { stoppedEarly } : {}),
    since: since?.toISOString() || null,
    ...(window
      ? { window: { hours: window.hours, label: window.label, from: window.from.toISOString(), to: window.to.toISOString() } }
      : {}),
    ...(targeted.length ? { targetedOrderIds: targeted } : {}),
  };
}

