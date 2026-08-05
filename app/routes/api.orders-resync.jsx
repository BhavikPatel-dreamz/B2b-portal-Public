import prisma from "../db.server.js";
import { retryableRowIds } from "../lib/order-sync-log.server.js";
import { startResync } from "../lib/order-sync.server.js";
import { authenticate } from "../shopify.server";

// Re-sync, triggered from the log page's Sync buttons.
//
//   POST /api/orders-resync   logId=<log row id>[&logId=…]
//
// It's a route of its own rather than an action on the log page for the same reason
// the connect/disconnect calls are: the re-sync is an app-level operation, not part
// of rendering that table, and this way anything in the app can trigger it. The
// cron endpoint (api.cron.orders-sync.jsx) is the other caller of the same sync
// lib; the difference is only which orders each one asks for.
//
// The scope is exactly the rows that were ticked and nothing else. Only the NetSuite
// orders named by those rows are fetched (targeted mode — no date window, no limit),
// so no other order is touched, and the watermark is left alone. See startResync.
//
// It takes log-row ids, not NetSuite ids, because that's what the table has to hand
// — and resolving them here is what keeps the request honest: the ids come from a
// browser, so the rows are re-read scoped to this shop and re-checked with the same
// retryableRowIds() the page used, rather than trusting the ids that arrived.
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const ids = form.getAll("logId").map((v) => String(v).trim()).filter(Boolean);

  if (!ids.length) return { ok: false, error: "Nothing selected to sync." };

  const rows = await prisma.orderSyncLog.findMany({
    where: { id: { in: ids }, shop },
    select: { id: true, status: true, externalId: true, reference: true, runAt: true },
  });
  const retryable = await retryableRowIds(shop, rows);
  const retryableRows = rows.filter((r) => retryable.has(r.id));

  // The NetSuite internal id is what the sync resolves without a search; the SO
  // number is the fallback for a row that failed before an id was known. The Set is
  // belt and braces: two rows for the same order can't ask for it twice.
  const orderIds = [...new Set(retryableRows.map((r) => r.externalId || r.reference))];
  // Which of those are internal ids WE already recorded, rather than an SO number
  // being asked about for the first time — see startResync/resolveKnownInternalId.
  // A retry is asking about the exact order the log row named before, not a guess
  // typed by hand, so it should skip straight to the id NetSuite already gave us.
  const knownInternalIds = new Set(retryableRows.filter((r) => r.externalId).map((r) => r.externalId));
  // Anything retryableRowIds() rejected — a whole-run row, or an older attempt at an
  // order that has a newer row. Reported rather than silently dropped, so a selection
  // that was only partly acted on doesn't look like it all went through.
  const dropped = ids.length - retryableRows.length;

  if (!orderIds.length) {
    return {
      ok: false,
      error: "Nothing there to re-sync: those rows name no order, or a later run has already looked at the same orders.",
    };
  }

  // Started, NOT awaited — see startResync. Holding this request open for the
  // whole re-sync (NetSuite fetch plus a second of rate-limit sleep per order)
  // was what left the log page with no way to show progress or offer Stop while
  // Sync selected or a single row's Sync button was working: syncRunning is read
  // from the loader, and the loader only finds out once this request returns.
  const { started, heldSince } = await startResync(shop, orderIds, { knownInternalIds });
  if (!started) {
    const since = heldSince ? ` (started ${heldSince.toISOString()})` : "";
    return { ok: false, error: `A sync is already running${since} — wait for it to finish.` };
  }

  // What it WILL do, not what it did — same as Sync now. The outcome arrives the
  // way every other run's does, as rows in the table below.
  const orders = `${orderIds.length} order${orderIds.length === 1 ? "" : "s"}`;
  const parts = [`Re-sync started for ${orders}. The table updates when it finishes.`];
  if (dropped > 0) parts.push(`${dropped} selected row(s) named no order and were skipped`);

  return { ok: true, started: true, message: parts.join(" · ") };
};
