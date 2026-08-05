import { startCronJobs } from "../lib/cron/jobs.server.js";
import { targetedOrderIds } from "../lib/netsuite/client.server.js";
import { buildCustomSyncWindow, buildSyncWindow } from "../lib/sync/orders.server.js";
import { CUSTOM_SYNC_WINDOW, SYNC_WINDOWS, parseCustomRange } from "../lib/sync/windows.js";
import { getSyncTimeZone } from "../lib/timezone/index.server.js";
import { authenticate } from "../shopify.server";

// Sync on demand, triggered from the log page's range dropdown + Sync now button.
//
//   POST /api/orders-sync-now   window=<1 | 2 | 6 | 12 | 24 | 48>
//   POST /api/orders-sync-now   window=custom  from=YYYY-MM-DD  to=YYYY-MM-DD
//
// This is the scheduled run, fired by hand. It walks the same CRON_JOBS list the
// cron endpoint walks (app/lib/cron/jobs.server.js), so a task added there is run
// by this button too, without this route learning its name — the only difference
// between the two is that this one is always handed an explicit time window.
//
// ALWAYS a window, which is why a run started here never advances the watermark:
// it answered a question about one named stretch of modification time, and moving
// the watermark to now would permanently skip everything the cron still owes from
// before it. Advancing the watermark belongs to the cron alone. (The dropdown used
// to offer a windowless "Current" option that did advance it — the scheduled run
// fired early. It was removed from SYNC_WINDOWS; a request still carrying its
// empty value now falls through the check below as an unknown range, which is the
// correct answer rather than a silent watermark move.)
//
// (The third way orders get synced is the per-order re-sync from the log table's
// Sync buttons, api.orders-resync.jsx.)
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const value = String(form.get("window") || "").trim();

  // Both kinds of range end up as the same `window` object, so nothing past this
  // block knows or cares which one was asked for.
  //
  // A custom range is validated by parseCustomRange — the same function the page
  // previews with, so a range the page showed as "will cover …" cannot be
  // refused here, and one it refused cannot be smuggled past by a hand-made
  // POST. A preset is matched against the offered list rather than parsed:
  // nothing here turns an arbitrary number into a NetSuite query.
  let window;
  // The whole phrase, not just the range's name, because the two kinds read
  // differently in a sentence: "the last 2 hours" wants the article, a pair of
  // dates does not.
  let scope;
  if (value === CUSTOM_SYNC_WINDOW) {
    // The zone the two typed dates are read in — the same one the log page
    // previewed them with (it takes it from the loader's schedule.timeZone), so
    // the range that was shown is the range that runs.
    const timeZone = await getSyncTimeZone(shop);
    const range = parseCustomRange(form.get("from"), form.get("to"), timeZone);
    if (range.error) return { ok: false, error: range.error };
    window = buildCustomSyncWindow(form.get("from"), form.get("to"), timeZone);
    scope = window.label;
  } else {
    const choice = SYNC_WINDOWS.find((w) => w.value === value);
    if (!choice) return { ok: false, error: `Unknown sync range "${value}".` };
    window = buildSyncWindow(choice.hours);
    scope = `the ${choice.label.toLowerCase()}`;
  }

  // Started, NOT awaited. A 50-order run spends over a minute in NetSuite before
  // it writes anything, and holding the browser's request open for it is what
  // made a working sync look broken every time a proxy cut the connection first.
  // startCronJobs comes back once the run is holding the lock, so the page can
  // see it running and watch for it to finish (the loader reports the lock, and
  // the page revalidates until it clears).
  const { started, heldSince } = await startCronJobs(shop, { window });

  if (!started) {
    const since = heldSince ? ` (started ${heldSince.toISOString()})` : "";
    return { ok: false, error: `A sync is already running${since} — wait for it to finish.` };
  }

  // What it WILL do, not what it did: the run has barely begun. Its outcome
  // arrives the way every other run's does, as rows in the table below.
  //
  // NETSUITE_ORDER_IDS is named here because this button is the one place the
  // two can visibly disagree: the range dropdown was just used to ask for a
  // stretch of time, and a targeted run ignores it outright and syncs that list
  // instead. Saying "Sync started for the last 2 hours" in that case is a lie
  // the log rows then contradict.
  const targeted = targetedOrderIds();
  const runScope = targeted.length
    ? `only the NETSUITE_ORDER_IDS orders (${targeted.join(", ")}) — the selected range is ignored`
    : scope;
  // And under SYNC_ORDER_EXPORT nothing reaches Shopify at all. A run that
  // exports and writes green log rows is the hardest of these to spot from the
  // outside — it looks exactly like a successful sync — so the word the toast
  // uses has to be "export", not "sync".
  if (process.env.SYNC_ORDER_EXPORT === "true") {
    return {
      ok: true,
      started: true,
      message: `Dry run started for ${runScope}. SYNC_ORDER_EXPORT is on, so orders go to storage/exports and nothing is written to Shopify.`,
    };
  }
  return { ok: true, started: true, message: `Sync started for ${runScope}. The table updates when it finishes.` };
};
