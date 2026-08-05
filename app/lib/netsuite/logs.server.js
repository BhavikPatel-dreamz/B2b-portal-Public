import prisma from "../../db.server.js";
import { cronIntervalMinutes, crontabLine, intervalLabel, nextCronRunAt } from "../cron/schedule.js";
import { getLastSyncWindow, getSyncRunState } from "./oauth.server.js";
import { plannedOrdersWindow, targetedOrderIds } from "./client.server.js";
import { RETRY_STATUSES, retryableRowIds } from "../sync/log.server.js";
import { dayEndUtc, dayStartUtc } from "../sync/windows.js";
import { isTestStore } from "../test-stores.server.js";

// Everything the order-sync log page asks the database and the environment for.
// Split out of the route (app/routes/app.netsuite-logs.jsx) so the route is the
// page and this is the query: the three questions below — which rows, what the
// schedule is doing, which rows can be re-run — are each answerable and testable
// on their own, and none of them needs a request.

export const PER_PAGE = 25;
export const STATUSES = ["failed", "success", "skipped"];

// The date filters are date-only (that's what s-date-field gives), so "to" has to
// cover the whole day or a same-day from/to would match nothing. Shared with the
// Sync now range (see parseCustomRange) so a date typed into the table's filter
// and the same date typed into the range mean the same stretch of time — in the
// same zone, which is why both take one.
const dayStart = (value, tz) => (value ? dayStartUtc(value, tz) : null);
const dayEnd = (value, tz) => (value ? dayEndUtc(value, tz) : null);

// The query string, as the filters the page works in. Anything unrecognised is
// dropped rather than passed on — `status` in particular is matched against the
// list rather than trusted, since it goes into a where clause.
export function parseLogFilters(url) {
  const status = url.searchParams.get("status");
  return {
    q: (url.searchParams.get("q") || "").trim(),
    status: STATUSES.includes(status) ? status : "",
    from: url.searchParams.get("from") || "",
    to: url.searchParams.get("to") || "",
    retryable: url.searchParams.get("retryable") === "1",
    page: Math.max(1, Number(url.searchParams.get("page")) || 1),
  };
}

// The Prisma `where` those filters mean, minus the retryable narrowing (which
// needs a query of its own — see below).
function buildWhere(shop, { q, status, from, to }, timeZone) {
  const runAt = {};
  const gte = dayStart(from, timeZone);
  const lte = dayEnd(to, timeZone);
  if (gte) runAt.gte = gte;
  if (lte) runAt.lte = lte;

  return {
    shop,
    ...(status ? { status } : {}),
    ...(Object.keys(runAt).length ? { runAt } : {}),
    // Free text hits everything an operator would search by: the NetSuite ids,
    // the Shopify order name, the company, and the error text itself.
    ...(q
      ? {
        OR: ["reference", "externalId", "orderName", "company", "message", "action"]
          .map((field) => ({ [field]: { contains: q } })),
      }
      : {}),
  };
}

// One row per order per cron run (see saveSyncLogRows in order-sync.server.js).
// Filtering, counting and paging are all done in the query — the table only
// renders the page it was handed.
//
// Rows that didn't land can be re-run from the page, one at a time or by
// selection. Which rows get a checkbox and a Sync button is decided here, by the
// same retryableRowIds() that /api/orders-resync uses, so the table and the
// buttons can never disagree.
export async function loadLogPage(shop, filters, timeZone) {
  const where = buildWhere(shop, filters, timeZone);

  // "Needs re-sync" (?retryable=1): the one-click list of everything still worth
  // re-running — every order whose NEWEST log row didn't land, and only that
  // newest row, so an order that failed on five runs is one line here, not five.
  // Built by running the whole filtered set of failed/skipped rows through
  // retryableRowIds() and then paging over what survives. The retry itself makes
  // rows leave this list: it writes a newer row for the order, and if that one
  // succeeded the order is gone from the view on the next revalidation.
  let pageWhere = where;
  if (filters.retryable) {
    const candidates = await prisma.orderSyncLog.findMany({
      where: { ...where, status: { in: RETRY_STATUSES } },
      select: { id: true, status: true, externalId: true, reference: true, runAt: true },
    });
    pageWhere = { ...where, id: { in: [...(await retryableRowIds(shop, candidates))] } };
  }

  // The page number is clamped to what the filter actually holds: a bookmarked
  // ?page=9, or a filter narrowed while on page 4, would otherwise render an
  // empty table with no way to tell that it isn't simply "no results".
  const total = await prisma.orderSyncLog.count({ where: pageWhere });
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const page = Math.min(filters.page, totalPages);

  const [rows, byStatus] = await Promise.all([
    prisma.orderSyncLog.findMany({
      where: pageWhere,
      // Newest run first, and within a run the failures first — the same order
      // the file log uses, for the same reason.
      orderBy: [{ runAt: "desc" }, { status: "asc" }, { id: "asc" }],
      skip: (page - 1) * PER_PAGE,
      take: PER_PAGE,
    }),
    // Counts for the current filter, minus the status filter itself — so the
    // "12 failed" badge stays readable while looking at only the successes.
    prisma.orderSyncLog.groupBy({
      by: ["status"],
      where: { ...where, status: undefined },
      _count: { _all: true },
    }),
  ]);

  const counts = { failed: 0, success: 0, skipped: 0 };
  for (const g of byStatus) counts[g.status] = g._count._all;

  // Which of these rows the page will offer a re-sync for. Only the "Failed &
  // skipped (latest)" view offers any — the plain log is for reading, and every
  // row in it that could be re-synced is in that view by definition — so the
  // lookup is skipped outright otherwise. It needs the database (the same order
  // appears once per run that touched it, and only its newest row is retryable),
  // which is why it can't be decided in the table.
  const syncable = filters.retryable ? await retryableRowIds(shop, rows) : new Set();

  return {
    rows: rows.map((r) => ({
      id: r.id,
      canSync: syncable.has(r.id),
      runAt: r.runAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() || null,
      mode: r.mode,
      externalId: r.externalId,
      reference: r.reference,
      action: r.action,
      status: r.status,
      orderName: r.orderName,
      orderId: r.orderId,
      company: r.company,
      message: r.message,
      detail: r.detail,
    })),
    counts,
    page,
    total,
    totalPages,
    hasPrev: page > 1,
    hasNext: page * PER_PAGE < total,
  };
}

// The schedule card: which stretch of NetSuite changes the last scheduled run
// covered, and which one the next will. The "next" window is not guessed here —
// plannedOrdersWindow is the same code that builds the real query, asked what it
// would produce at the next cron tick, so the card cannot drift from the run.
export async function loadSchedule(shop, timeZone) {
  const [lastWindow, runState] = await Promise.all([
    getLastSyncWindow(shop),
    getSyncRunState(shop),
  ]);
  const { runningSince, stopRequestedAt, totalOrders, doneOrders } = runState;
  const everyMinutes = cronIntervalMinutes(process.env.CRON_INTERVAL_MINUTES);
  const nextRunAt = nextCronRunAt(everyMinutes);
  // Same zone the real run will name its days in, so the "NetSuite filter" line
  // on the card is the filter that will actually be sent.
  const nextWindow = plannedOrdersWindow(lastWindow.to, nextRunAt, timeZone);

  // The half of the card that describes how the app is wired — the raw NetSuite
  // query, the crontab line carrying this app's URL, the banners naming env vars
  // — is for whoever runs the app, not for a merchant. It is built only for the
  // stores in TEST_STORE_SHOP_NAME.
  //
  // Built, not hidden: a loader's return value is serialised into the page, so a
  // field left in here and skipped in the JSX would still be sitting in the HTML
  // of every store. Not sending it is the only way not to send it.
  const showDiagnostics = isTestStore(shop);

  return {
    everyMinutes,
    // The zone every date on this page is rendered in and every date typed into
    // it is read in. Sent to the browser because the page has to agree with the
    // server about which day "2026-08-05" is — the preview under the range
    // dropdown is computed client-side, and a page that assumed UTC while the run
    // used Asia/Kolkata would preview a window 5½ hours off the one it ran.
    timeZone,
    // Whether that zone was chosen or merely defaulted to, so the card can say
    // which. SYNC_TIMEZONE set is a deliberate answer; the shop's own zone is
    // Shopify's answer; UTC is what is left when neither said anything.
    timeZoneSource: process.env.SYNC_TIMEZONE?.trim() ? "SYNC_TIMEZONE" : "shop",
    // Named here rather than in the markup so the page and the cron endpoint's
    // JSON call the same interval the same thing.
    every: intervalLabel(everyMinutes),
    nextRunAt: nextRunAt.toISOString(),
    // The sync runs in the background, so this is how the page knows one is
    // still going — it polls the loader until this goes null.
    runningSince: runningSince?.toISOString() || null,
    // Set once Stop sync has been pressed and the run has not noticed yet. The
    // gap is real — the run only checks between orders — and the button has to
    // say so, or the press looks like it did nothing and gets pressed again.
    stopRequestedAt: stopRequestedAt?.toISOString() || null,
    // How many orders the run has to do and how many it has finished. While a
    // run is going this is the only thing on the page that moves — its log rows
    // are all written at the end — and afterwards it is what the last run got
    // through. Null before any run has reported a total.
    //
    // One meaning only: orders this run has to sync, and orders it has finished.
    // (A `phase` was reported here once, to colour the bar differently while
    // NetSuite was being read; the bar is one count now — see SyncProgressBar.)
    progress: totalOrders === null
      ? null
      : { total: totalOrders, done: doneOrders ?? 0 },
    last: {
      from: lastWindow.from?.toISOString() || null,
      to: lastWindow.to?.toISOString() || null,
    },
    next: {
      from: nextWindow.from.toISOString(),
      to: nextWindow.to.toISOString(),
    },
    // The two settings that make the range dropdown a lie, as plain booleans —
    // NOT behind showDiagnostics, unlike the banners further down that name the
    // env vars. Which setting did it is app-internals; that the range you just
    // picked is being ignored is what the person pressing the button needs, on
    // any store. Without this the page looks broken in exactly the way it was
    // reported: pick "Last 1 hour", press Sync now, and nothing that has to do
    // with the last hour happens.
    targeted: targetedOrderIds().length > 0,
    dryRun: process.env.SYNC_ORDER_EXPORT === "true",
    showDiagnostics,
    ...(showDiagnostics ? diagnostics(everyMinutes, nextWindow) : {}),
  };
}

// The operator-only half of the schedule card. Split out so loadSchedule reads
// as the shape the page consumes rather than as one long conditional.
function diagnostics(everyMinutes, nextWindow) {
  return {
    // Never the real CRON_SECRET: this line is meant to be read off a screen,
    // and often a shared one.
    crontab: crontabLine(everyMinutes, process.env.SHOPIFY_APP_URL),
    // Wider than the from/to above, because NetSuite's q filter has no time of
    // day — shown so that the wider result doesn't look like a bug.
    query: nextWindow.query,
    // NETSUITE_ORDERS_QUERY replaces the window outright, so when it is set the
    // from/to above are not what the run will really read.
    override: nextWindow.override,
    // In demo mode no run advances the watermark, so the windows above would
    // describe a schedule that never actually moves.
    demo: process.env.NETSUITE_USE_DEMO !== "false",
    // Same class of surprise: the schedule runs, the log fills up, and not one
    // order reaches Shopify.
    exportOnly: process.env.SYNC_ORDER_EXPORT === "true",
    // The last two settings from the guide's "before the first real run"
    // checklist that nothing on this page said out loud. Both are worse than the
    // ones above, because a run under either looks completely healthy: every
    // order succeeds, every row is green, and the result is wrong.
    //
    // The value, not just "it is set" — with TEST_EMAIL, WHICH address it is is
    // the whole question.
    testEmail: process.env.TEST_EMAIL || null,
    targetedIds: targetedOrderIds(),
  };
}
