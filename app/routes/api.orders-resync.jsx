import prisma from "../db.server.js";
import { retryableRowIds } from "../lib/order-sync-log.server.js";
import { logSyncCrash, resyncOrders } from "../lib/order-sync.server.js";
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
// so no other order is touched, and the watermark is left alone. See resyncOrders.
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

  // The NetSuite internal id is what the sync resolves without a lookup; the SO
  // number is the fallback for a row that failed before an id was known. The Set is
  // belt and braces: two rows for the same order can't ask for it twice.
  const orderIds = [
    ...new Set(
      rows.filter((r) => retryable.has(r.id)).map((r) => r.externalId || r.reference),
    ),
  ];
  // Anything retryableRowIds() rejected — a whole-run row, or an older attempt at an
  // order that has a newer row. Reported rather than silently dropped, so a selection
  // that was only partly acted on doesn't look like it all went through.
  const dropped = ids.length - rows.filter((r) => retryable.has(r.id)).length;

  if (!orderIds.length) {
    return {
      ok: false,
      error: "Nothing there to re-sync: those rows name no order, or a later run has already looked at the same orders.",
    };
  }

  const startedAt = new Date();
  let run;
  try {
    run = await resyncOrders(shop, orderIds);
  } catch (err) {
    // The re-sync died before it produced a summary — a NetSuite auth failure, a
    // Shopify connection error. Log it the way the cron route does, so the attempt
    // leaves a trace instead of only a toast.
    await logSyncCrash(shop, startedAt, err);
    return { ok: false, error: `Re-sync failed: ${err?.message || String(err)}` };
  }

  if (run.skipped) return { ok: false, error: `Not re-synced — ${run.reason}.` };

  const { total, ok, failed } = run.summary;
  const orders = `${total} order${total === 1 ? "" : "s"}`;
  const parts = [failed ? `Re-synced ${orders}: ${ok} ok, ${failed} failed` : `Re-synced ${orders} successfully`];
  // A big selection can run into SYNC_MAX_RUN_MS, and the orders it never reached
  // would otherwise look untouched for no visible reason.
  if (run.stoppedEarly) parts.push(`stopped early: ${run.stoppedEarly}`);
  if (dropped > 0) parts.push(`${dropped} selected row(s) named no order and were skipped`);

  return { ok: true, message: `${parts.join(" · ")}.`, failed };
};
