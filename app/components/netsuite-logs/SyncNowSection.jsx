/* eslint-disable react/prop-types -- prop-types is not a dependency in this
   app; these components are typed by their one call site. */
import { useCallback } from "react";

import { formatRunAt, progressText, windowText } from "../../lib/netsuite/logs.shared.js";
import { CUSTOM_SYNC_WINDOW, MAX_CUSTOM_RANGE_DAYS, SYNC_WINDOWS } from "../../lib/sync/windows.js";
import { SyncProgressBar } from "./SyncProgressBar.jsx";
import { useFieldChange } from "./useFieldChange.js";

// Sync on demand. The range is a NetSuite lastModifiedDate window, so this pulls
// the orders that CHANGED in that stretch — not the orders placed in it — which is
// the same thing the scheduled run asks for, just with the window named by hand
// instead of taken from the watermark.
//
// Two ways to name it: one of the presets ("Last 2 hours", measured back from the
// press) or "Custom range", which reveals two date fields and hands those two
// dates to the NetSuite salesorder query as its bounds. Both arrive at the server
// as the same window object — see buildSyncWindow / buildCustomSyncWindow — so
// nothing past the route knows which was used.
export function SyncNowSection({
  schedule,
  syncWindow,
  isCustomRange,
  onWindowChange,
  customFrom,
  customTo,
  onCustomFromChange,
  onCustomToChange,
  preview,
  rangeError,
  rangeReady,
  syncing,
  running,
  syncRunning,
  stopping,
  onSyncNow,
  onStopSync,
}) {
  // Memoised because useFieldChange keys its listener on the handler's identity —
  // a fresh closure each render would detach and re-attach the `change` listener
  // on every one of them.
  const windowRef = useFieldChange(useCallback((v) => onWindowChange(v), [onWindowChange]));
  const rangeFromRef = useFieldChange(useCallback((v) => onCustomFromChange(v), [onCustomFromChange]));
  const rangeToRef = useFieldChange(useCallback((v) => onCustomToChange(v), [onCustomToChange]));

  return (
    <s-section heading="Sync from NetSuite">
      {/* Export mode changes what the button DOES, not just what it reads, so it
          is called out at the control rather than only in the Schedule card below
          the fold. */}
      {schedule.dryRun && (
        <s-banner tone="warning">
          Export mode is on, so Sync now is a <s-text type="strong">dry run</s-text>: orders are
          written to storage/exports and <s-text type="strong">nothing reaches Shopify</s-text>.
          The run still appears in the log below, which is why it can look like a sync that did
          nothing.
        </s-banner>
      )}
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
          {/* Last, after the presets, because it is the one that asks for more
              typing — and it is a different shape of answer: two fixed dates
              rather than a stretch back from now. */}
          {/* <s-option value={CUSTOM_SYNC_WINDOW}>Custom range…</s-option> */}
        </s-select>

        {/* The two ends of a custom range, read as whole days in the sync's own
            zone — the same days the table's From/To filters below use, so a range
            typed here and a filter typed there mean the same stretch of time. The
            zone is named on the field because a date-only input cannot carry one,
            and "which midnight" is exactly the ambiguity that makes a range come
            back with the wrong orders. */}
        {isCustomRange && (
          <>
            <s-date-field
              ref={rangeFromRef}
              label={`Sync from (${schedule.timeZone})`}
              labelAccessibilityVisibility="exclusive"
              placeholder={`From (${schedule.timeZone})`}
              value={customFrom}
              {...(running ? { disabled: true } : {})}
            ></s-date-field>
            <s-date-field
              ref={rangeToRef}
              label={`Sync to (${schedule.timeZone})`}
              labelAccessibilityVisibility="exclusive"
              placeholder={`To (${schedule.timeZone})`}
              value={customTo}
              {...(running ? { disabled: true } : {})}
            ></s-date-field>
          </>
        )}

        <s-button
          variant="primary"
          onClick={onSyncNow}
          {...(syncing || !rangeReady ? { disabled: true } : {})}
          {...(running || syncRunning ? { loading: true } : {})}
        >
          Sync now
        </s-button>

        {/* Offered only while something is actually running — there is nothing to
            stop otherwise, and the route refuses it anyway rather than arming a
            flag the next run would pick up. It stops whichever run holds the lock,
            including one the cron started while this page was open. */}
        {syncRunning && (
          <s-button
            variant="secondary"
            tone="critical"
            onClick={onStopSync}
            {...(stopping ? { disabled: true, loading: true } : {})}
          >
            {stopping ? "Stopping…" : "Stop sync"}
          </s-button>
        )}

        {/* The run itself is detached from this page, so what it is doing has to be
            shown rather than implied by a spinner on a request that already
            returned. */}
        {syncRunning ? (
          <s-stack direction="block" gap="small-500">
            {/* The count, first and on its own line: it is the only thing that
                moves while a run works. The log rows below are written in one batch
                when the run ENDS, so without this the page can say nothing between
                "started" and "finished" — which on a 50-order run is several
                minutes of a spinner that cannot tell you whether it is nearly
                done. */}
            {schedule.progress && (
              <s-stack direction="block" gap="small-100">
                <s-text type="strong">{progressText(schedule.progress)}</s-text>
                <SyncProgressBar done={schedule.progress.done} total={schedule.progress.total} />
              </s-stack>
            )}
            <s-text>
              Sync running since {formatRunAt(schedule.runningSince, schedule.timeZone)} — this page refreshes itself
              while it works. The rows below arrive together when it finishes.
              {stopping
                ? " Stop requested: it finishes the order it is on, then stops and leaves the rest for the next run."
                : ""}
            </s-text>
          </s-stack>
        ) : (
          <s-stack direction="block" gap="small-500">
            {/* The gap between the press and the first loader response that says
                `runningSince`: the button is spinning, the run is being started on
                the server, and without this the only thing the page says about it
                is a spinner — which is exactly when it gets pressed again. Held by
                the fetcher's own state, so it ends when the page has the real
                progress line above to show instead. */}
            {running && (
              <s-text type="strong">
                Starting the sync… it runs in the background, so this section will switch to its
                live progress in a moment. You can leave this page open.
              </s-text>
            )}
            {/* Why the button is refusing, at the button. A range that is
                backwards, half-typed or wider than the scan can serve is the one
                thing here that stops a press from doing anything, so saying so is
                what keeps a disabled button from reading as a broken one. */}
            {rangeError && <s-text tone="critical">{rangeError}</s-text>}
            {/* The range as the two moments it really means, in the same UTC format
                as the table's Run time — so what the button will ask for can be
                read against what past runs covered, without translating "last 6
                hours" in your head. Absent while a targeted list overrides the
                range, because then it is not what will run. */}
            {preview && !schedule.targeted && (
              <s-text>Will cover {windowText(preview.from, preview.to, schedule.timeZone)}</s-text>
            )}
            {/* What the press costs beyond the orders it syncs: a clean run moves
                the schedule on to the end of this window, so anything the
                schedule still owed from BEFORE it is stepped over rather than
                queued. Said here, at the button, because it is the one effect of
                Sync now that outlives the run itself. */}
            <s-text tone="neutral">
              Syncs the NetSuite orders modified in that window. A run that finishes without
              failures also moves the schedule on to the end of that window — so the next
              scheduled run picks up from there, and anything modified before the window that
              had not been synced yet is skipped.
              {isCustomRange ? ` A custom range covers at most ${MAX_CUSTOM_RANGE_DAYS} days.` : ""}
            </s-text>
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}
