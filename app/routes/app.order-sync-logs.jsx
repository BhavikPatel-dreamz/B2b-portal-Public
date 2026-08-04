import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLoaderData, useNavigate, useRevalidator, useRouteError, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server.js";
import { cronIntervalMinutes, crontabLine, intervalLabel, nextCronRunAt } from "../lib/cron-schedule.js";
import { getLastSyncWindow, getSyncRunningSince } from "../lib/netsuite-oauth.server.js";
import { plannedOrdersWindow, targetedOrderIds } from "../lib/netsuite.server.js";
import { RETRY_STATUSES, retryableRowIds } from "../lib/order-sync-log.server.js";
import { SYNC_WINDOWS } from "../lib/sync-windows.js";
import { isTestStore } from "../lib/test-stores.server.js";
import { authenticate } from "../shopify.server";

// Order-sync run log, one row per order per cron run (see saveSyncLogRows in
// app/lib/order-sync.server.js). Filtering, counting and paging are all done in
// the query — the table only renders the page it was handed.
//
// Rows that didn't land can be re-run from here, one at a time or by selection. The
// re-sync itself is POST /api/orders-resync (app/routes/api.orders-resync.jsx). Which
// rows get a checkbox and a Sync button is decided in the loader, by the same
// retryableRowIds() that route uses — the table just renders the `canSync` flag.

const PER_PAGE = 25;
const STATUSES = ["failed", "success", "skipped"];
const RESYNC_URL = "/api/orders-resync";
const SYNC_NOW_URL = "/api/orders-sync-now";
// How often the page re-asks the loader while a background sync is running.
const POLL_MS = 5000;

// The date filters are date-only (that's what s-date-field gives), so "to" has to
// cover the whole day or a same-day from/to would match nothing.
function dayStart(value) {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dayEnd(value) {
  if (!value) return null;
  const d = new Date(`${value}T23:59:59.999Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const status = STATUSES.includes(url.searchParams.get("status")) ? url.searchParams.get("status") : "";
  const from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";
  const retryable = url.searchParams.get("retryable") === "1";
  const requestedPage = Math.max(1, Number(url.searchParams.get("page")) || 1);

  const runAt = {};
  if (dayStart(from)) runAt.gte = dayStart(from);
  if (dayEnd(to)) runAt.lte = dayEnd(to);

  const where = {
    shop: session.shop,
    ...(status ? { status } : {}),
    ...(Object.keys(runAt).length ? { runAt } : {}),
    // Free text hits everything an operator would search by: the NetSuite ids,
    // the Shopify order name, the company, and the error text itself.
    ...(q
      ? {
        OR: [
          { reference: { contains: q } },
          { externalId: { contains: q } },
          { orderName: { contains: q } },
          { company: { contains: q } },
          { message: { contains: q } },
          { action: { contains: q } },
        ],
      }
      : {}),
  };

  // "Needs re-sync" (?retryable=1): the one-click list of everything still worth
  // re-running — every order whose NEWEST log row didn't land, and only that newest
  // row, so an order that failed on five runs is one line here, not five. Built by
  // running the whole filtered set of failed/skipped rows through the same
  // retryableRowIds() the Sync buttons use, then paging over what survives, so the
  // list and the buttons can never disagree. The retry itself makes rows leave this
  // list: it writes a newer row for the order, and if that one succeeded the order is
  // gone from the view on the next revalidation.
  let pageWhere = where;
  if (retryable) {
    const candidates = await prisma.orderSyncLog.findMany({
      where: { ...where, status: { in: RETRY_STATUSES } },
      select: { id: true, status: true, externalId: true, reference: true, runAt: true },
    });
    pageWhere = { ...where, id: { in: [...(await retryableRowIds(session.shop, candidates))] } };
  }

  // The page number is clamped to what the filter actually holds: a bookmarked
  // ?page=9, or a filter narrowed while on page 4, would otherwise render an empty
  // table with no way to tell that it isn't simply "no results".
  const total = await prisma.orderSyncLog.count({ where: pageWhere });
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const page = Math.min(requestedPage, totalPages);

  const [rows, byStatus] = await Promise.all([
    prisma.orderSyncLog.findMany({
      where: pageWhere,
      // Newest run first, and within a run the failures first — the same order the
      // file log uses, for the same reason.
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

  // The schedule card: which stretch of NetSuite changes the last scheduled run
  // covered, and which one the next will. The "next" window is not guessed here —
  // plannedOrdersWindow is the same code that builds the real query, asked what it
  // would produce at the next cron tick, so the card cannot drift from the run.
  const [lastWindow, runningSince] = await Promise.all([
    getLastSyncWindow(session.shop),
    getSyncRunningSince(session.shop),
  ]);
  const everyMinutes = cronIntervalMinutes(process.env.CRON_INTERVAL_MINUTES);
  const nextRunAt = nextCronRunAt(everyMinutes);
  const nextWindow = plannedOrdersWindow(lastWindow.to, nextRunAt);

  // The half of the card that describes how the app is wired — the raw NetSuite
  // query, the crontab line carrying this app's URL, the banners naming env vars
  // — is for whoever runs the app, not for a merchant. It is built only for the
  // stores in TEST_STORE_SHOP_NAME.
  //
  // Built, not hidden: a loader's return value is serialised into the page, so a
  // field left in here and skipped in the JSX would still be sitting in the HTML
  // of every store. Not sending it is the only way not to send it.
  const showDiagnostics = isTestStore(session.shop);

  const schedule = {
    everyMinutes,
    // Named here rather than in the markup so the page and the cron endpoint's
    // JSON call the same interval the same thing.
    every: intervalLabel(everyMinutes),
    nextRunAt: nextRunAt.toISOString(),
    // The sync runs in the background, so this is how the page knows one is still
    // going — it polls the loader until this goes null.
    runningSince: runningSince?.toISOString() || null,
    last: {
      from: lastWindow.from?.toISOString() || null,
      to: lastWindow.to?.toISOString() || null,
    },
    next: {
      from: nextWindow.from.toISOString(),
      to: nextWindow.to.toISOString(),
    },
    showDiagnostics,
    ...(showDiagnostics
      ? {
        // Never the real CRON_SECRET: this line is meant to be read off a
        // screen, and often a shared one.
        crontab: crontabLine(everyMinutes, process.env.SHOPIFY_APP_URL),
        // Wider than the from/to above, because NetSuite's q filter has no time
        // of day — shown so that the wider result doesn't look like a bug.
        query: nextWindow.query,
        // NETSUITE_ORDERS_QUERY replaces the window outright, so when it is set
        // the from/to above are not what the run will really read.
        override: nextWindow.override,
        // In demo mode no run advances the watermark, so the windows above would
        // describe a schedule that never actually moves.
        demo: process.env.NETSUITE_USE_DEMO !== "false",
        // Same class of surprise: the schedule runs, the log fills up, and not
        // one order reaches Shopify.
        exportOnly: process.env.SYNC_ORDER_EXPORT === "true",
        // The last two settings from the guide's "before the first real run"
        // checklist that nothing on this page said out loud. Both are worse than
        // the ones above, because a run under either looks completely healthy:
        // every order succeeds, every row is green, and the result is wrong.
        //
        // The value, not just "it is set" — with TEST_EMAIL, WHICH address it is
        // is the whole question.
        testEmail: process.env.TEST_EMAIL || null,
        targetedIds: targetedOrderIds(),
      }
      : {}),
  };

  // Which of these rows the page will offer a re-sync for. Only the "Failed & skipped
  // (latest)" view offers any — the plain log is for reading, and every row in it that
  // could be re-synced is in that view by definition — so the lookup is skipped
  // outright otherwise. It needs the database (the same order appears once per run
  // that touched it, and only its newest row is retryable), which is why it can't be
  // decided in the table.
  const syncable = retryable ? await retryableRowIds(session.shop, rows) : new Set();

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
    schedule,
    filters: { q, status, from, to, retryable },
    page,
    total,
    totalPages,
    hasPrev: page > 1,
    hasNext: page * PER_PAGE < total,
  };
};

// UTC, deliberately, for two reasons. The From/To filters below are UTC days (a
// date-only field can't carry a zone), so a local-time column would disagree with
// its own filter by the viewer's offset — at +05:30, "today" would silently drop
// everything logged after 18:30. And toLocaleString() renders in the server's zone
// during SSR and the browser's after hydration, which React reports as a mismatch.
// NetSuite and the .log file are both UTC too, so a timestamp here can be compared
// with either as-is.
function formatRunAt(iso) {
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

// A window as "<from> → <to>", in the same UTC format as the table's Run time so
// the two can be read against each other. A missing `from` means the run started
// at the initial lookback rather than at a previous watermark — worth naming
// rather than printing an empty side.
function windowText(from, to) {
  return `${from ? formatRunAt(from) : "initial lookback window"} → ${to ? formatRunAt(to) : "now"}`;
}

// One "Label  value" line of the schedule card.
// eslint-disable-next-line react/prop-types -- prop-types isn't a dependency here
function ScheduleRow({ label, children }) {
  return (
    <s-stack direction="inline" gap="base">
      <s-box inlineSize="180px">
        <s-text tone="neutral">{label}</s-text>
      </s-box>
      <s-text>{children}</s-text>
    </s-stack>
  );
}

function statusTone(status) {
  if (status === "failed") return "critical";
  if (status === "success") return "success";
  return "neutral";
}

// What the row's Sync button will do, named after the one order it will touch.
function syncLabel(row) {
  return `Re-sync ${row.reference || row.externalId}`;
}

// Everything in the row's stored result, as label/value lines. The raw JSON is
// shown underneath for the fields this doesn't know about.
function detailPairs(row) {
  let detail = {};
  try {
    detail = row.detail ? JSON.parse(row.detail) : {};
  } catch {
    detail = {};
  }
  const pairs = [
    ["Run time", `${formatRunAt(row.runAt)} (${row.runAt})`],
    ["Finished", row.finishedAt ? formatRunAt(row.finishedAt) : null],
    ["Mode", row.mode === "export" ? "export (dry run — nothing written to Shopify)" : "live"],
    ["NetSuite id", row.externalId],
    ["NetSuite ref", row.reference],
    ["Action", row.action],
    ["Status", row.status],
    ["Shopify order", [row.orderName, row.orderId].filter(Boolean).join(" · ")],
    ["Matched by", detail.matchedBy],
    ["Financial status", detail.financialStatus],
    ["Fulfillment status", detail.fulfillmentStatus],
    ["Total", detail.total],
    ["Company", detail.company || detail.netsuiteCompany],
    ["Company location", detail.companyLocation],
    ["Created in Shopify", detail.companyCreated],
    ["Line items", detail.lines],
    ["Payment", (detail.transactions || []).join(" | ")],
    ["Tracking", detail.tracking],
    ["Deleted id", detail.deletedId],
    // Set on an order that has failed every run for long enough to be let go of
    // by the watermark — see quarantinedOrders. It explains why a run can report
    // failures and still have moved on.
    ["Consecutive failed runs", detail.attempts],
    ["Quarantined", detail.quarantined ? "yes — no longer holding the watermark back" : null],
    ["Reason", detail.reason],
    ["Warning", detail.warning],
    ["Error", detail.error],
  ];
  return pairs.filter(([, v]) => v !== null && v !== undefined && v !== "");
}

// React 18's synthetic onChange only covers native form elements, so it can't be
// relied on to fire for a Polaris web component — the listener is attached to the
// element itself instead. (onClick is fine: React's click delegation reaches any
// element, which is how the rest of this app's s-buttons work.) `change` also
// fires on commit rather than per keystroke, so the search field doesn't navigate
// on every character.
function useFieldChange(handler) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const onChange = (event) => handler(String(event.target?.value ?? ""));
    el.addEventListener("change", onChange);
    return () => el.removeEventListener("change", onChange);
  }, [handler]);
  return ref;
}

// A selection checkbox, for the same reason useFieldChange exists: `change` has to
// be listened for on the element itself. It has to be a component rather than a
// hook because there is one per row and hooks can't be called in a loop.
//
// `checked`/`indeterminate` are spread in only when true — React 18 renders
// `checked={false}` on a custom element as the attribute checked="false", which a
// web component reads as present, i.e. checked.
//
// eslint-disable-next-line react/prop-types -- prop-types isn't a dependency here
function SelectCheckbox({ checked, indeterminate, label, onToggle }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const onChange = () => onToggle();
    el.addEventListener("change", onChange);
    return () => el.removeEventListener("change", onChange);
  }, [onToggle]);
  return (
    <s-checkbox
      ref={ref}
      accessibilityLabel={label}
      {...(checked ? { checked: true } : {})}
      {...(indeterminate ? { indeterminate: true } : {})}
    ></s-checkbox>
  );
}

export default function OrderSyncLogs() {
  const { rows, counts, schedule, filters, page, total, totalPages, hasPrev, hasNext } = useLoaderData();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const [selected, setSelected] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const syncFetcher = useFetcher();
  const runFetcher = useFetcher();
  // The chosen range is state, not a URL param: it says what the next Sync now
  // will pull from NetSuite, which is not something a filtered view of the table
  // should carry around or a bookmark should replay.
  const [syncWindow, setSyncWindow] = useState("");
  const running = runFetcher.state !== "idle";
  // A background run is in progress — either one this page just started, or one
  // the cron started while the page was open. Both look the same to the loader,
  // which is what makes it a reliable signal.
  const syncRunning = Boolean(schedule.runningSince);
  // One sync at a time per shop is enforced by the run lock anyway (the second
  // one is refused, not queued); disabling here is so that refusal isn't the
  // first thing the page teaches anyone.
  const syncing = syncFetcher.state !== "idle" || running || syncRunning;

  // Only the rows on this page that have a Sync button can be selected, so the
  // select-all checkbox and the "n selected" count agree with what's visible.
  const syncableIds = useMemo(() => rows.filter((r) => r.canSync).map((r) => r.id), [rows]);
  const chosen = selectedIds.filter((id) => syncableIds.includes(id));

  // Every filter change is a navigation, so the URL is the state: a filtered view
  // can be linked, and the browser's back button does what it looks like it does.
  const apply = useCallback((changes) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, String(value));
      else next.delete(key);
    }
    // Any filter change invalidates the page number.
    if (!("page" in changes)) next.delete("page");
    navigate(`?${next.toString()}`);
  }, [navigate, searchParams]);

  const searchRef = useFieldChange(useCallback((value) => apply({ q: value }), [apply]));
  const statusRef = useFieldChange(useCallback((value) => apply({ status: value }), [apply]));
  const fromRef = useFieldChange(useCallback((value) => apply({ from: value }), [apply]));
  const toRef = useFieldChange(useCallback((value) => apply({ to: value }), [apply]));
  const windowRef = useFieldChange(useCallback((value) => setSyncWindow(value), []));

  // A filter change or a page turn replaces the rows under the checkboxes, so a
  // selection can't outlive it.
  const searchKey = searchParams.toString();
  useEffect(() => {
    setSelectedIds([]);
  }, [searchKey]);

  const toggleRow = useCallback((id) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));
  }, []);

  const toggleAll = useCallback(() => {
    setSelectedIds((prev) => (syncableIds.every((id) => prev.includes(id)) ? [] : syncableIds));
  }, [syncableIds]);

  // The re-sync runs in /api/orders-resync; submitting through a fetcher revalidates
  // this page's loader when it returns, so the run it wrote shows up in the table.
  const syncRows = useCallback((ids) => {
    const data = new FormData();
    for (const id of ids) data.append("logId", String(id));
    syncFetcher.submit(data, { method: "POST", action: RESYNC_URL });
  }, [syncFetcher]);

  // Pulls whatever NetSuite changed in the chosen stretch of time, rather than
  // waiting for the cron's next tick. Same fetcher-revalidates-the-loader trick as
  // the re-sync above, so the run it wrote is in the table when the toast lands.
  const syncNow = useCallback(() => {
    runFetcher.submit({ window: syncWindow }, { method: "POST", action: SYNC_NOW_URL });
  }, [runFetcher, syncWindow]);

  useEffect(() => {
    const result = syncFetcher.data;
    if (!result) return;
    if (result.ok) {
      shopify.toast.show(result.message, result.failed ? { isError: true } : undefined);
      setSelectedIds([]);
    } else {
      shopify.toast.show(result.error, { isError: true });
    }
  }, [syncFetcher.data, shopify]);

  useEffect(() => {
    const result = runFetcher.data;
    if (!result) return;
    if (result.ok) shopify.toast.show(result.message, result.failed ? { isError: true } : undefined);
    else shopify.toast.show(result.error, { isError: true });
  }, [runFetcher.data, shopify]);

  // While a run is going, re-ask the loader every few seconds: the run writes its
  // rows as it goes, so the table fills in rather than sitting still, and the
  // moment the lock clears the poll stops on its own. POLL_MS is a compromise —
  // often enough to feel live, rare enough that a 10-minute run is ~120 cheap
  // queries and not thousands.
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!syncRunning) return undefined;
    const timer = setInterval(() => {
      // Asking again while the last ask is still out would just queue requests up
      // behind a slow one.
      if (revalidator.state === "idle") revalidator.revalidate();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [syncRunning, revalidator]);

  // "It finished" is the edge from running to not-running, which only this page
  // can see — the run itself ended in a background task with nobody listening.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !syncRunning) {
      shopify.toast.show("Sync finished — the table below is up to date.");
    }
    wasRunning.current = syncRunning;
  }, [syncRunning, shopify]);

  const openDetail = (row) => {
    setSelected(row);
    shopify.modal.show("log-detail");
  };

  return (
    <s-page heading="Order sync logs">
      {/* Sync on demand. The range is a NetSuite lastModifiedDate window, so this
          pulls the orders that CHANGED in that stretch — not the orders placed in
          it — which is the same thing the scheduled run asks for, just with the
          window named by hand instead of taken from the watermark. */}
      <s-section heading="Sync from NetSuite">
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-select
            ref={windowRef}
            label="Sync range"
            labelAccessibilityVisibility="exclusive"
            name="window"
            value={syncWindow}
            {...(running ? { disabled: true } : {})}
          >
            {SYNC_WINDOWS.map((w) => (
              <s-option key={w.value} value={w.value}>
                {w.label}
              </s-option>
            ))}
          </s-select>
          <s-button
            variant="primary"
            onClick={syncNow}
            {...(syncing ? { disabled: true } : {})}
            {...(running || syncRunning ? { loading: true } : {})}
          >
            Sync now
          </s-button>
          {/* The run itself is detached from this page, so what it is doing has to
              be shown rather than implied by a spinner on a request that already
              returned. */}
          {syncRunning ? (
            <s-text>
              Sync running since {formatRunAt(schedule.runningSince)} — this page refreshes itself
              while it works, and rows appear as orders are processed.
            </s-text>
          ) : (
          <s-text tone="neutral">
            {syncWindow
              ? "Syncs the NetSuite orders modified in that window. The scheduled run's watermark is left alone, so nothing older is skipped."
              : "Runs exactly what the next scheduled sync would run — everything modified since the last successful one."}
          </s-text>
          )}
        </s-stack>
      </s-section>

      {/* The schedule, in the terms the sync actually works in: not "it ran at
          09:00" but "it read the NetSuite changes between these two moments".
          Those are different things — a run started at 09:00 reads from the
          previous run's start, not from 09:00 — and the gap between them is
          where "why didn't my order sync" usually lives. */}
      <s-section heading="Schedule">
        <s-stack direction="block" gap="small-200">
          <ScheduleRow label="Runs">
            {schedule.every.replace(/^every/, "Every")} (CRON_INTERVAL_MINUTES)
          </ScheduleRow>
          <ScheduleRow label="Last run covered">
            {schedule.last.to
              ? windowText(schedule.last.from, schedule.last.to)
              : "No successful scheduled run yet — the first will start from the initial lookback window."}
          </ScheduleRow>
          <ScheduleRow label="Next run">{formatRunAt(schedule.nextRunAt)}</ScheduleRow>
          <ScheduleRow label="Next run covers">
            {windowText(schedule.next.from, schedule.next.to)}
          </ScheduleRow>
          {/* Everything below describes how this app is wired, not what the
              merchant's orders did: the raw NetSuite filter, the env-var
              banners, the crontab line carrying this app's URL. It is built by
              the loader only for the stores in TEST_STORE_SHOP_NAME, so on any
              other store these fields are absent rather than merely unrendered
              — the check here is what draws them, not what hides them. */}
          {schedule.showDiagnostics && (
            <>
              {/* The from/to above are the honest boundaries, but NetSuite is
                  asked in whole days — showing the real filter keeps the wider
                  result from looking like a bug. */}
              <ScheduleRow label="NetSuite filter">{schedule.query}</ScheduleRow>
              {/* The two settings that make a run look perfectly healthy while
                  being wrong: every order succeeds, every row is green, and the
                  orders went to the wrong customer or were never the orders you
                  meant. Named with their values, because "TEST_EMAIL is set" is
                  not the useful half — which address is. */}
              {schedule.testEmail && (
                <s-banner tone="warning">
                  TEST_EMAIL is set, so every synced order goes to{" "}
                  <s-text type="strong">{schedule.testEmail}</s-text> instead of the real NetSuite
                  customer — and the B2B company lookup uses that address too. Clear it before a
                  real run.
                </s-banner>
              )}
              {schedule.targetedIds?.length > 0 && (
                <s-banner tone="warning">
                  NETSUITE_ORDER_IDS is set to{" "}
                  <s-text type="strong">{schedule.targetedIds.join(", ")}</s-text>, so every run
                  syncs only those orders, ignores the window above, and never advances the
                  watermark. Clear it to go back to the normal incremental sync.
                </s-banner>
              )}
              {schedule.override && (
                <s-banner tone="warning">
                  NETSUITE_ORDERS_QUERY is set, so it replaces the window above — every run reads
                  exactly that filter and the watermark has no effect on what is fetched.
                </s-banner>
              )}
              {schedule.exportOnly && (
                <s-banner tone="warning">
                  SYNC_ORDER_EXPORT is on, so every run — scheduled or from Sync now — is a dry
                  run: orders are written to storage/exports and nothing reaches Shopify. Unset it
                  to sync for real.
                </s-banner>
              )}
              {schedule.demo && (
                <s-banner tone="info">
                  NETSUITE_USE_DEMO is on: runs read app/data/demo-orders.json and never advance
                  the watermark, so the windows above stay where they are. Set
                  NETSUITE_USE_DEMO=false to sync the real account.
                </s-banner>
              )}
              <s-text tone="neutral">
                Nothing here fires the sync on its own — this is what the app expects. Install the
                matching crontab entry on the host (UTC clock assumed) and it will line up:
              </s-text>
              <s-box padding="base" background="subdued" borderRadius="base">
                <s-text>{schedule.crontab}</s-text>
              </s-box>
              <s-text tone="neutral">
                Replace &lt;CRON_SECRET&gt; with the value from .env — it is left out here on
                purpose.
              </s-text>
            </>
          )}
        </s-stack>
      </s-section>

      <s-section>
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-badge tone="critical">{counts.failed} failed</s-badge>
          <s-badge tone="success">{counts.success} success</s-badge>
          <s-badge tone="neutral">{counts.skipped} skipped</s-badge>
          <s-text tone="neutral">
            {total} entr{total === 1 ? "y" : "ies"} · page {page} of {totalPages}
          </s-text>
          {/* The list to work from: everything still worth re-running, one line per
              order rather than one per failed attempt. Pressed again it goes back to
              the full log. */}
          <s-button
            variant={filters.retryable ? "primary" : "secondary"}
            onClick={() => apply({ retryable: filters.retryable ? "" : "1" })}
          >
            {filters.retryable ? "Showing failed & skipped (latest)" : "Failed & skipped (latest)"}
          </s-button>
          {/* Nothing to select outside that view, so the button isn't there either. */}
          {filters.retryable && (
            <s-button
              onClick={() => syncRows(chosen)}
              {...(chosen.length && !syncing ? {} : { disabled: true })}
              {...(syncing ? { loading: true } : {})}
            >
              {chosen.length ? `Sync selected (${chosen.length})` : "Sync selected"}
            </s-button>
          )}
        </s-stack>
      </s-section>

      <s-section padding="none">
        <s-table
          paginate
          hasPreviousPage={hasPrev}
          hasNextPage={hasNext}
          onPreviousPage={() => apply({ page: String(page - 1) })}
          onNextPage={() => apply({ page: String(page + 1) })}
        >
          <s-grid slot="filters" gap="small-200" gridTemplateColumns="1fr auto auto auto auto">
            <s-search-field
              ref={searchRef}
              label="Search logs"
              labelAccessibilityVisibility="exclusive"
              placeholder="SO number, order name, company, error…"
              value={filters.q}
            ></s-search-field>
            <s-select
              ref={statusRef}
              label="Status"
              labelAccessibilityVisibility="exclusive"
              name="status"
              value={filters.status}
            >
              <s-option value="">All statuses</s-option>
              <s-option value="failed">Failed</s-option>
              <s-option value="success">Success</s-option>
              <s-option value="skipped">Skipped</s-option>
            </s-select>
            <s-date-field
              ref={fromRef}
              label="From (UTC)"
              labelAccessibilityVisibility="exclusive"
              placeholder="From (UTC)"
              value={filters.from}
            ></s-date-field>
            <s-date-field
              ref={toRef}
              label="To (UTC)"
              labelAccessibilityVisibility="exclusive"
              placeholder="To (UTC)"
              value={filters.to}
            ></s-date-field>
            <s-button
              variant="secondary"
              onClick={() => navigate("?")}
              {...(filters.q || filters.status || filters.from || filters.to || filters.retryable
                ? {}
                : { disabled: true })}
            >
              Clear
            </s-button>
          </s-grid>

          <s-table-header-row>
            {/* Selection and the ⟳ column only exist in the "Failed & skipped
                (latest)" view — the plain log is for reading, and anything re-syncable
                is in that view anyway. Both columns are conditional on the same flag,
                so the header and the rows always agree on how many there are. */}
            {filters.retryable && (
              <s-table-header>
                {syncableIds.length > 0 && (
                  <SelectCheckbox
                    checked={chosen.length === syncableIds.length}
                    indeterminate={chosen.length > 0 && chosen.length < syncableIds.length}
                    label="Select every row on this page"
                    onToggle={toggleAll}
                  />
                )}
              </s-table-header>
            )}
            <s-table-header listSlot="primary">Run time</s-table-header>
            <s-table-header>NetSuite order</s-table-header>
            <s-table-header>Action</s-table-header>
            <s-table-header listSlot="secondary">Status</s-table-header>
            <s-table-header>Shopify order</s-table-header>
            <s-table-header>Reason / error</s-table-header>
            <s-table-header>Detail</s-table-header>
            {/* Its own column, not a second button beside Details: the two of them
                in one cell wrap onto separate lines as soon as the reason text is
                long, which is most of the time. */}
            {filters.retryable && <s-table-header>Re-sync</s-table-header>}
          </s-table-header-row>
          <s-table-body>
            {rows.map((row) => (
              <s-table-row key={row.id}>
                {filters.retryable && (
                  // Empty for a row with nothing to retry — a success, a whole run
                  // that named no order, or an older attempt at an order that has a
                  // newer row. The cell stays so the columns still line up.
                  <s-table-cell>
                    {row.canSync && (
                      <SelectCheckbox
                        checked={chosen.includes(row.id)}
                        label={syncLabel(row)}
                        onToggle={() => toggleRow(row.id)}
                      />
                    )}
                  </s-table-cell>
                )}
                <s-table-cell>{formatRunAt(row.runAt)}</s-table-cell>
                <s-table-cell>{row.reference || row.externalId || "—"}</s-table-cell>
                <s-table-cell>{row.action}</s-table-cell>
                <s-table-cell>
                  <s-badge tone={statusTone(row.status)}>{row.status}</s-badge>
                </s-table-cell>
                <s-table-cell>{row.orderName || "—"}</s-table-cell>
                <s-table-cell>
                  <s-text tone={row.status === "failed" ? "critical" : "neutral"}>
                    {row.message || "—"}
                  </s-text>
                </s-table-cell>
                <s-table-cell>
                  <s-button variant="tertiary" onClick={() => openDetail(row)}>
                    Details
                  </s-button>
                </s-table-cell>
                {filters.retryable && (
                  <s-table-cell>
                    {row.canSync ? (
                      <s-button
                        variant="secondary"
                        icon="refresh"
                        accessibilityLabel={syncLabel(row)}
                        onClick={() => syncRows([row.id])}
                        {...(syncing ? { disabled: true } : {})}
                      ></s-button>
                    ) : (
                      // A dash rather than a blank, so "no button here" reads as
                      // deliberate: nothing on this row is left to re-sync.
                      <s-text tone="neutral">—</s-text>
                    )}
                  </s-table-cell>
                )}
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        {rows.length === 0 && (
          <s-box padding="base">
            <s-paragraph tone="neutral">
              No log entries for this filter. Runs are logged by the cron sync
              (/api/cron/orders-sync).
            </s-paragraph>
          </s-box>
        )}
      </s-section>

      <s-modal id="log-detail" heading="Log entry">
        {selected && (
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-badge tone={statusTone(selected.status)}>{selected.status}</s-badge>
              <s-text type="strong">
                {selected.action} · {selected.reference || selected.externalId || "—"}
              </s-text>
            </s-stack>
            {detailPairs(selected).map(([label, value]) => (
              <s-stack key={label} direction="inline" gap="base">
                <s-box inlineSize="180px">
                  <s-text tone="neutral">{label}</s-text>
                </s-box>
                <s-text>{String(value)}</s-text>
              </s-stack>
            ))}
            <s-divider direction="inline"></s-divider>
            <s-text tone="neutral">Raw result</s-text>
            <s-box padding="base" background="subdued" borderRadius="base">
              <s-text>{selected.detail}</s-text>
            </s-box>
          </s-stack>
        )}
        <s-button slot="secondary-actions" commandFor="log-detail" command="--hide">
          Close
        </s-button>
      </s-modal>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
