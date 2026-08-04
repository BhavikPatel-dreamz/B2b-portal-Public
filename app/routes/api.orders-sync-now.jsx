import { startCronJobs } from "../lib/cron-jobs.server.js";
import { buildSyncWindow } from "../lib/order-sync.server.js";
import { SYNC_WINDOWS } from "../lib/sync-windows.js";
import { authenticate } from "../shopify.server";

// Sync on demand, triggered from the log page's range dropdown + Sync now button.
//
//   POST /api/orders-sync-now   window=<"" | 1 | 2 | 6 | 12 | 24 | 48>
//
// This is the scheduled run, fired by hand. It walks the same CRON_JOBS list the
// cron endpoint walks (app/lib/cron-jobs.server.js), so a task added there is run
// by this button too, without this route learning its name — the only difference
// between the two is that this one can be handed an explicit time window.
//
// The empty window is the cron's own behaviour — "run now what the next scheduled
// run would have run" — and is the one option here that DOES advance the
// watermark, because it is that run, just early. Every other option syncs a named
// stretch of time and leaves the watermark alone.
//
// (The third way orders get synced is the per-order re-sync from the log table's
// Sync buttons, api.orders-resync.jsx.)
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const value = String(form.get("window") || "").trim();

  // The range comes from a browser, so it is matched against the offered list
  // rather than parsed — nothing here turns an arbitrary number into a NetSuite
  // query.
  const choice = SYNC_WINDOWS.find((w) => w.value === value);
  if (!choice) return { ok: false, error: `Unknown sync range "${value}".` };

  // Started, NOT awaited. A 50-order run spends over a minute in NetSuite before
  // it writes anything, and holding the browser's request open for it is what
  // made a working sync look broken every time a proxy cut the connection first.
  // startCronJobs comes back once the run is holding the lock, so the page can
  // see it running and watch for it to finish (the loader reports the lock, and
  // the page revalidates until it clears).
  const { started, heldSince } = await startCronJobs(shop, {
    window: choice.hours ? buildSyncWindow(choice.hours) : null,
  });

  if (!started) {
    const since = heldSince ? ` (started ${heldSince.toISOString()})` : "";
    return { ok: false, error: `A sync is already running${since} — wait for it to finish.` };
  }

  // What it WILL do, not what it did: the run has barely begun. Its outcome
  // arrives the way every other run's does, as rows in the table below.
  const scope = choice.hours
    ? `the ${choice.label.toLowerCase()}`
    : "everything modified since the last sync";
  return { ok: true, started: true, message: `Sync started for ${scope}. The table updates when it finishes.` };
};
