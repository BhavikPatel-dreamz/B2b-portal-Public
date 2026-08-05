import prisma from "../../db.server.js";
// Which order-sync log rows can be re-synced. Used by the log page's loader (to
// decide which rows get a checkbox and a Sync button) and by the re-sync route (to
// decide which submitted rows it will act on), so the two can't drift apart — see
// app/routes/app.order-sync-logs.jsx and app/routes/api.orders-resync.jsx.

// A success has nothing to retry — re-running it would just redo work that already
// landed. Everything else didn't land.
export const RETRY_STATUSES = ["failed", "skipped"];

// ---------------------------------------------------------------------------
// Quarantine — an order that always fails must not freeze the whole sync
// ---------------------------------------------------------------------------
// The watermark only advances on a run where nothing failed, so that a failure is
// retried by the next run instead of being skipped for good. That is right for a
// transient failure and a trap for a permanent one: an order with data Shopify
// will never accept (a duplicate company, an address it rejects) fails on every
// run forever, so the watermark never moves again. The window then grows by a day
// a day, until it matches more orders than the run's limit and NEW orders start
// being dropped instead. One bad order takes the whole sync down with it, quietly.
//
// So after SYNC_MAX_ORDER_ATTEMPTS consecutive failed runs, an order stops
// holding the watermark. It is NOT abandoned: it stays a failed row, it stays in
// the "Failed & skipped (latest)" view, and its Sync button still works. What
// changes is only that the rest of the sync is allowed to move on past it.
//
// 0 turns this off — every failure holds the watermark, forever, which is the
// behaviour this replaced.
const DEFAULT_MAX_ORDER_ATTEMPTS = 5;

export function orderAttemptLimit() {
  // The empty string has to be handled before Number() gets it. 0 is a REAL
  // value here — it turns quarantine off — and Number("") is 0, so an unset-but-
  // present `SYNC_MAX_ORDER_ATTEMPTS=` in a .env would silently disable the
  // protection instead of falling back to the default.
  const raw = process.env.SYNC_MAX_ORDER_ATTEMPTS;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_MAX_ORDER_ATTEMPTS;
  }
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_MAX_ORDER_ATTEMPTS;
}

// How many runs in a row failed, given this order's statuses newest-first.
// Counting stops at the first non-failure: an order that failed, succeeded, then
// failed again has one consecutive failure, not two — it is not stuck, it broke
// again.
export function consecutiveFailures(statusesNewestFirst) {
  let n = 0;
  for (const status of statusesNewestFirst) {
    if (status !== "failed") break;
    n += 1;
  }
  return n;
}

// Of the orders that just failed, the ones that have now failed `limit` runs in a
// row — counting this run, whose rows are not written yet.
//
// Returns a Map of externalId-or-reference → attempts. One query per failed
// order, which is fine because failures are the exception; a run where everything
// fails is a run with a broken connection, and that is a single "run" row, not
// hundreds of order rows.
export async function quarantinedOrders(shop, failures, limit = orderAttemptLimit()) {
  const quarantined = new Map();
  if (!limit) return quarantined;

  for (const failure of failures) {
    const externalId = failure.externalId ? String(failure.externalId) : null;
    const reference = failure.reference || null;
    if (!externalId && !reference) continue;

    const rows = await prisma.orderSyncLog.findMany({
      where: externalId ? { shop, externalId } : { shop, reference },
      orderBy: { runAt: "desc" },
      // Only as many as the limit could possibly need — an order that has failed
      // for months holds thousands of rows and none of them past this change the
      // answer.
      take: Math.max(0, limit - 1),
      select: { status: true },
    });
    const attempts = consecutiveFailures(rows.map((r) => r.status)) + 1;
    if (attempts >= limit) quarantined.set(externalId || reference, attempts);
  }
  return quarantined;
}

// The order a row is about: the NetSuite internal id when there is one (that's what
// the sync resolves without a lookup), otherwise the SO number, which is all a row
// that failed before an id was known has.
function orderKey(row) {
  if (row.externalId) return `id:${row.externalId}`;
  if (row.reference) return `ref:${row.reference}`;
  return null;
}

// Of the rows given, the ids of the ones worth re-syncing. Three rules:
//
//  1. The status has to be failed or skipped.
//
//  2. The row has to NAME an order. A re-sync only ever touches the orders that were
//     ticked, so a whole-run row (`action = "run"` — the run died before it reached
//     any order) is out: it carries no order, and "retrying" it could only mean
//     re-running the entire window. Nothing is lost, because a failed run doesn't
//     advance the watermark and the next cron run re-pulls that window anyway.
//
//  3. It has to be the NEWEST row for its order. Every run that touches an order
//     writes a row, so an order that keeps failing collects one per run — the same
//     SO number appearing three times in the table is three attempts at one order,
//     not three things to fix. Only the last attempt is offered a retry. This is also
//     what stops an order that has since succeeded from being offered one at all: its
//     newest row is the success, and rule 1 rejects that.
//
// "Newest" is decided shop-wide, not within the page: a newer row that a filter or
// the page size has hidden still wins.
export async function retryableRowIds(shop, rows) {
  const candidates = rows.filter((r) => RETRY_STATUSES.includes(r.status) && orderKey(r));
  if (!candidates.length) return new Set();

  const externalIds = [...new Set(candidates.map((r) => r.externalId).filter(Boolean))];
  const references = [
    ...new Set(candidates.filter((r) => !r.externalId).map((r) => r.reference).filter(Boolean)),
  ];

  // Two grouped queries rather than reading every row of every order: a single order
  // that fails on every run can hold thousands of rows over the retention window.
  const [byExternalId, byReference] = await Promise.all([
    externalIds.length
      ? prisma.orderSyncLog.groupBy({
        by: ["externalId"],
        where: { shop, externalId: { in: externalIds } },
        _max: { runAt: true },
      })
      : [],
    references.length
      ? prisma.orderSyncLog.groupBy({
        by: ["reference"],
        where: { shop, reference: { in: references } },
        _max: { runAt: true },
      })
      : [],
  ]);

  const newest = new Map();
  for (const g of byExternalId) newest.set(`id:${g.externalId}`, g._max.runAt?.getTime());
  for (const g of byReference) newest.set(`ref:${g.reference}`, g._max.runAt?.getTime());

  const ids = new Set();
  for (const row of candidates) {
    if (newest.get(orderKey(row)) === new Date(row.runAt).getTime()) ids.add(row.id);
  }
  return ids;
}
