import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLoaderData, useNavigate, useRevalidator, useRouteError, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  LogDetailModal,
  LogTable,
  ScheduleSection,
  SyncNowSection,
} from "../components/netsuite-logs/index.js";
import { progressText } from "../lib/netsuite/logs.shared.js";
import { loadLogPage, loadSchedule, parseLogFilters } from "../lib/netsuite/logs.server.js";
import { getSyncTimeZone } from "../lib/timezone/index.server.js";
import {
  CUSTOM_SYNC_WINDOW,
  DEFAULT_SYNC_WINDOW,
  SYNC_WINDOWS,
  parseCustomRange,
  windowRange,
} from "../lib/sync/windows.js";
import { authenticate } from "../shopify.server";

// The order-sync run log: one row per order per run, and the controls for firing a
// run by hand. The queries behind it are in app/lib/netsuite/logs.server.js, the
// formatting in netsuite/logs.shared.js, and the markup in
// app/components/netsuite-logs — what is left here is the page's own job: read the
// URL, hold the state that isn't in it, and drive the three fetchers.

const RESYNC_URL = "/api/orders-resync";
const SYNC_NOW_URL = "/api/orders-sync-now";
const SYNC_STOP_URL = "/api/orders-sync-stop";
// How often the page re-asks the loader while a background sync is running.
const POLL_MS = 5000;
// The same question, asked faster, in the seconds after Stop sync is pressed.
// The run now abandons whatever it was doing almost at once, so on the normal
// interval the page would sit on "Stopping…" for several seconds after the sync
// had already ended — the wait would be the polling, not the sync. This window is
// short and only opens on a press, so it costs nothing the rest of the time.
const STOPPING_POLL_MS = 700;
// How often the "will cover" preview under the dropdown is recomputed. A preset
// range is relative to now, so on a page left open it would otherwise describe a
// window that ended half an hour ago. (A custom range has fixed ends and needs no
// tick — see the preview effect.)
const PREVIEW_TICK_MS = 30000;

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const filters = parseLogFilters(new URL(request.url));
  // Resolved first, because both halves below read dates in it: the table's
  // From/To filters and the schedule card's NetSuite filter have to agree with
  // each other and with the run.
  const timeZone = await getSyncTimeZone(session.shop);
  // Independent queries, so they go together: the table's page of rows, and the
  // schedule card beside it.
  const [table, schedule] = await Promise.all([
    loadLogPage(session.shop, filters, timeZone),
    loadSchedule(session.shop, timeZone),
  ]);
  return { ...table, schedule, filters };
};

// Which stretch the chosen range means, as the two instants the run will really
// use, plus the reason it can't be run yet if there is one. Both branches call the
// same function the run does — windowRange for a preset, parseCustomRange for a
// custom range — so the preview and the run cannot describe different windows, and
// a range this refuses cannot be got past by pressing harder.
//
// A preset is computed after mount and on a tick: it is relative to "now", so a
// server-rendered value would disagree with the browser's clock (React reports
// that as a hydration mismatch) and would go stale on a page left open. A custom
// range's ends are fixed dates, so it needs neither.
function useRangePreview(syncWindow, customFrom, customTo, timeZone) {
  const isCustomRange = syncWindow === CUSTOM_SYNC_WINDOW;

  const [presetPreview, setPresetPreview] = useState(null);
  useEffect(() => {
    if (isCustomRange) return undefined;
    const choice = SYNC_WINDOWS.find((w) => w.value === syncWindow);
    if (!choice) return undefined;
    const compute = () => {
      const { from, to } = windowRange(choice.hours);
      setPresetPreview({ from: from.toISOString(), to: to.toISOString() });
    };
    compute();
    const timer = setInterval(compute, PREVIEW_TICK_MS);
    return () => clearInterval(timer);
  }, [syncWindow, isCustomRange]);

  const customRange = useMemo(
    () => (isCustomRange ? parseCustomRange(customFrom, customTo, timeZone) : null),
    [isCustomRange, customFrom, customTo, timeZone],
  );

  if (!isCustomRange) {
    return { isCustomRange, preview: presetPreview, rangeError: null, rangeReady: true };
  }
  return {
    isCustomRange,
    preview: customRange.error
      ? null
      : { from: customRange.from.toISOString(), to: customRange.to.toISOString() },
    // Only complained about once there is something to complain about — an
    // untouched pair of empty date fields is not an error yet, though it is still
    // not something the button can run.
    rangeError: customRange.error && (customFrom || customTo) ? customRange.error : null,
    rangeReady: !customRange.error,
  };
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
  const stopFetcher = useFetcher();

  // The chosen range is state, not a URL param: it says what the next Sync now
  // will pull from NetSuite, which is not something a filtered view of the table
  // should carry around or a bookmark should replay.
  const [syncWindow, setSyncWindow] = useState(DEFAULT_SYNC_WINDOW);
  // The two ends of a hand-typed range, used only while the dropdown is on
  // "Custom range". Kept when the dropdown moves away and back, so glancing at a
  // preset doesn't cost the dates you just typed.
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const { isCustomRange, preview, rangeError, rangeReady } = useRangePreview(
    syncWindow,
    customFrom,
    customTo,
    schedule.timeZone,
  );

  const running = runFetcher.state !== "idle";
  // A background run is in progress — either one this page just started, or one
  // the cron started while the page was open. Both look the same to the loader,
  // which is what makes it a reliable signal.
  const syncRunning = Boolean(schedule.runningSince);
  // A stop has been asked for and the run hasn't reached its next order boundary
  // yet. The fetcher's own state covers only the request that carries the ask;
  // the wait that follows is the loader's to report, and it is the longer half.
  const stopping = stopFetcher.state !== "idle" || Boolean(schedule.stopRequestedAt);
  // One sync at a time per shop is enforced by the run lock anyway (the second
  // one is refused, not queued); disabling here is so that refusal isn't the
  // first thing the page teaches anyone.
  const syncing = syncFetcher.state !== "idle" || running || syncRunning;

  // Only the rows on this page that have a Sync button can be selected, so the
  // select-all checkbox and the "n selected" count agree with what's visible.
  const syncableIds = useMemo(() => rows.filter((r) => r.canSync).map((r) => r.id), [rows]);
  const chosen = useMemo(
    () => selectedIds.filter((id) => syncableIds.includes(id)),
    [selectedIds, syncableIds],
  );

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

  const clearFilters = useCallback(() => navigate("?"), [navigate]);

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
  //
  // A custom range sends its two dates and lets the route resolve them, rather
  // than sending the resolved instants: the route has to validate them anyway
  // (nothing a browser sends can be trusted into a NetSuite query), and two ways
  // of saying the same range is how the two ends of it drift apart.
  const syncNow = useCallback(() => {
    runFetcher.submit(
      isCustomRange
        ? { window: CUSTOM_SYNC_WINDOW, from: customFrom, to: customTo }
        : { window: syncWindow },
      { method: "POST", action: SYNC_NOW_URL },
    );
  }, [runFetcher, syncWindow, isCustomRange, customFrom, customTo]);

  // Asks the run in progress to stop — whichever process is holding it, this
  // page's Sync now or the cron's own tick. It is a request, not a kill (see
  // /api/orders-sync-stop), so the page goes on polling the lock and the run
  // disappears from the card when it really ends.
  const stopSync = useCallback(() => {
    stopFetcher.submit({}, { method: "POST", action: SYNC_STOP_URL });
  }, [stopFetcher]);

  // All three fetchers report the same way — a message on success, an error
  // otherwise — so they share one reader. `onOk` is the only part that differs.
  const toastResult = useCallback((result, onOk) => {
    if (!result) return;
    if (result.ok) {
      shopify.toast.show(result.message, result.failed ? { isError: true } : undefined);
      onOk?.();
    } else {
      shopify.toast.show(result.error, { isError: true });
    }
  }, [shopify]);

  useEffect(() => {
    toastResult(syncFetcher.data, () => setSelectedIds([]));
  }, [syncFetcher.data, toastResult]);

  useEffect(() => {
    toastResult(runFetcher.data);
  }, [runFetcher.data, toastResult]);

  useEffect(() => {
    toastResult(stopFetcher.data);
  }, [stopFetcher.data, toastResult]);

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
    }, stopping ? STOPPING_POLL_MS : POLL_MS);
    return () => clearInterval(timer);
  }, [syncRunning, stopping, revalidator]);

  // And ask once immediately when the stop is acknowledged, rather than waiting
  // out even the first short tick: by the time this response comes back the run
  // has usually already let go.
  useEffect(() => {
    if (stopFetcher.data?.ok && revalidator.state === "idle") revalidator.revalidate();
    // Deliberately keyed on the response alone — re-running this as the
    // revalidator's own state changes would make it revalidate in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopFetcher.data]);

  // "It finished" is the edge from running to not-running, which only this page
  // can see — the run itself ended in a background task with nobody listening.
  //
  // schedule.progress at this exact render is the run's FINAL count: the same
  // loader response that reports syncRunning: false also carries the last
  // totalOrders/doneOrders the run wrote before releasing the lock (release
  // clears the lock, not the counters — see releaseSyncLock), so this is not a
  // stale read. Named with real numbers rather than "up to date" for the same
  // reason the toast started with a count: "Sync finished" alone doesn't say
  // whether all of it made it, and a run stopped by hand or cut off by the time
  // budget finishes with done < total.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !syncRunning) {
      const p = schedule.progress;
      const short = p && p.done < p.total;
      const message = p
        ? `Sync finished — ${progressText(p)}${short ? " (the rest were left for the next run)" : ""}.`
        : "Sync finished — the table below is up to date.";
      shopify.toast.show(message, short ? { isError: true } : undefined);
    }
    wasRunning.current = syncRunning;
  }, [syncRunning, schedule.progress, shopify]);

  const openDetail = useCallback((row) => {
    setSelected(row);
    shopify.modal.show("log-detail");
  }, [shopify]);

  return (
    <s-page heading="Order sync logs">
      <SyncNowSection
        schedule={schedule}
        syncWindow={syncWindow}
        isCustomRange={isCustomRange}
        onWindowChange={setSyncWindow}
        customFrom={customFrom}
        customTo={customTo}
        onCustomFromChange={setCustomFrom}
        onCustomToChange={setCustomTo}
        preview={preview}
        rangeError={rangeError}
        rangeReady={rangeReady}
        syncing={syncing}
        running={running}
        syncRunning={syncRunning}
        stopping={stopping}
        onSyncNow={syncNow}
        onStopSync={stopSync}
      />

      <ScheduleSection schedule={schedule} syncRunning={syncRunning} />

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

      <LogTable
        rows={rows}
        filters={filters}
        timeZone={schedule.timeZone}
        page={page}
        hasPrev={hasPrev}
        hasNext={hasNext}
        syncableIds={syncableIds}
        chosen={chosen}
        syncing={syncing}
        onApply={apply}
        onClear={clearFilters}
        onToggleRow={toggleRow}
        onToggleAll={toggleAll}
        onSyncRows={syncRows}
        onOpenDetail={openDetail}
      />

      <LogDetailModal row={selected} timeZone={schedule.timeZone} />
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
