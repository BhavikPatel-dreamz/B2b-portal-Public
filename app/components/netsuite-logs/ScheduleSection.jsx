/* eslint-disable react/prop-types -- prop-types is not a dependency in this
   app; these components are typed by their one call site. */
import { formatRunAt, progressText, windowText } from "../../lib/netsuite/logs.shared.js";
import { LabelledRow } from "./LabelledRow.jsx";

// The env vars that make a run look healthy while being wrong, each with the one
// sentence that says what it does to a run. Kept as data rather than as a column
// of near-identical JSX blocks: they are all the same shape (a flag, a tone, a
// warning) and the differences between them are the words.
//
// Order matters — worst first. TEST_EMAIL and NETSUITE_ORDER_IDS are above the
// others because a run under either succeeds on every order and writes green
// rows, so nothing in the log below contradicts them.
function diagnosticBanners(schedule) {
  return [
    schedule.testEmail && {
      key: "testEmail",
      tone: "warning",
      body: (
        <>
          TEST_EMAIL is set, so every synced order goes to{" "}
          <s-text type="strong">{schedule.testEmail}</s-text> instead of the real NetSuite customer
          — and the B2B company lookup uses that address too. Clear it before a real run.
        </>
      ),
    },
    schedule.targetedIds?.length > 0 && {
      key: "targetedIds",
      tone: "warning",
      body: (
        <>
          NETSUITE_ORDER_IDS is set to{" "}
          <s-text type="strong">{schedule.targetedIds.join(", ")}</s-text>, so every run —
          scheduled or from Sync now, live account or demo feed — syncs only those orders, ignores
          the window above and the range picked for Sync now, and never advances the watermark.
          Clear it to go back to the normal incremental sync.
        </>
      ),
    },
    schedule.override && {
      key: "override",
      tone: "warning",
      body: `NETSUITE_ORDERS_QUERY is set, so it replaces the window above — every run reads exactly that filter and the watermark has no effect on what is fetched.`,
    },
    schedule.exportOnly && {
      key: "exportOnly",
      tone: "warning",
      body: `SYNC_ORDER_EXPORT is on, so every run — scheduled or from Sync now — is a dry run: orders are written to storage/exports and nothing reaches Shopify. Unset it to sync for real.`,
    },
    schedule.demo && {
      key: "demo",
      tone: "info",
      body: `NETSUITE_USE_DEMO is on: runs read app/data/demo-orders.json and never advance the watermark, so the windows above stay where they are. Set NETSUITE_USE_DEMO=false to sync the real account.`,
    },
  ].filter(Boolean);
}

// The schedule, in the terms the sync actually works in: not "it ran at 09:00"
// but "it read the NetSuite changes between these two moments". Those are
// different things — a run started at 09:00 reads from the previous run's start,
// not from 09:00 — and the gap between them is where "why didn't my order sync"
// usually lives.
export function ScheduleSection({ schedule, syncRunning }) {
  return (
    <s-section heading="Schedule">
      <s-stack direction="block" gap="small-200">
        <LabelledRow label="Runs">
          {schedule.every.replace(/^every/, "Every")} (CRON_INTERVAL_MINUTES)
        </LabelledRow>
        {/* Every date on this page is read and written in this zone — the two
            date filters below, the range picker above, and every timestamp in the
            table. It is stated rather than left implied because the whole class of
            "the sync missed my order by a few hours" question is really a question
            about which midnight the run used. */}
        <LabelledRow label="Dates shown in">
          {schedule.timeZone}
          {schedule.timeZoneSource === "SYNC_TIMEZONE"
            ? " (set by SYNC_TIMEZONE)"
            : " (this store's timezone — set SYNC_TIMEZONE to override)"}
        </LabelledRow>
        {/* The watermark, read as the window it came from. Set by any run that
            finished without failures — the cron's, or a Sync now, which leaves it
            at the end of the window it was given — so this is "where the schedule
            picks up from", not only "what the cron last did". */}
        <LabelledRow label="Last run covered">
          {schedule.last.to
            ? windowText(schedule.last.from, schedule.last.to, schedule.timeZone)
            : "No sync has finished cleanly yet — the next run starts from the initial lookback window."}
        </LabelledRow>
        {/* The same two numbers after the fact. "Covered" above is the stretch of
            time the last run asked about; this is how many orders that turned out
            to be and how many it got through — which are different questions, and
            the second is the one asked after a run that was stopped or ran out of
            its time budget. */}
        {schedule.progress && !syncRunning && (
          <LabelledRow label="Last run">
            {progressText(schedule.progress)}
            {schedule.progress.done < schedule.progress.total
              ? " — the rest were left for the next run"
              : ""}
          </LabelledRow>
        )}
        <LabelledRow label="Next run">{formatRunAt(schedule.nextRunAt, schedule.timeZone)}</LabelledRow>
        <LabelledRow label="Next run covers">
          {windowText(schedule.next.from, schedule.next.to, schedule.timeZone)}
        </LabelledRow>

        {/* Everything below describes how this app is wired, not what the
            merchant's orders did: the raw NetSuite filter, the env-var banners,
            the crontab line carrying this app's URL. It is built by the loader
            only for the stores in TEST_STORE_SHOP_NAME, so on any other store
            these fields are absent rather than merely unrendered — the check here
            is what draws them, not what hides them. */}
        {schedule.showDiagnostics && (
          <>
            {/* The from/to above are the honest boundaries, but NetSuite is asked
                in whole days — showing the real filter keeps the wider result
                from looking like a bug. */}
            <LabelledRow label="NetSuite filter">{schedule.query}</LabelledRow>
            {diagnosticBanners(schedule).map(({ key, tone, body }) => (
              <s-banner key={key} tone={tone}>
                {body}
              </s-banner>
            ))}
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
  );
}
