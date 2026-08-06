import { DEFAULT_TIME_ZONE, zonedParts } from "../timezone/index.js";

// ---------------------------------------------------------------------------
// Building the sales-order query, and deciding what the answer really contains
// ---------------------------------------------------------------------------
// The pure half of the NetSuite order fetch: turning a scope (a date range, or
// the sync watermark) into the `q` filter NetSuite is sent, and deciding which
// of the records that come back actually belong to it.
//
// Split out of client.server.js so it can be reached without a database. That
// file opens sockets and reads tokens through oauth.server.js; this one touches
// nothing but its arguments and a few env vars, which is what lets the tests and
// scripts/netsuite-orders.mjs use the SAME query builder the sync uses instead of
// reimplementing it and drifting from it.

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function shiftDays(d, days) {
  return new Date(d.getTime() + days * DAY_MS);
}

// ---------------------------------------------------------------------------
// How a date literal has to be SPELLED for this account
// ---------------------------------------------------------------------------
// There is no one answer. NetSuite parses the literals in a q filter with the
// account's own date/time format preference, so the same query is accepted by
// one account and rejected by the next:
//
//   NetSuite GET /salesorder?...&q=lastModifiedDate+ON_OR_AFTER+"8/5/2026 23:53"…
//     400 Search error occurred: Parse of date/time "8/5/2026 23:53" failed with
//     date format "M/d/yy" in time zone America/Los_Angeles
//
// That is this account answering that its filter takes a DATE, not a datetime —
// the trailing time is what it could not consume. Another account, with a
// 12-hour time preference, would take a datetime but not the 24-hour clock.
//
// So the spelling is not hard-coded. These are the shapes worth trying, in the
// order they are tried — narrowest (and cheapest to scan) first:
//
//   datetime     8/5/2026 23:53      the window's own instants, 24-hour clock
//   datetime12   8/5/2026 11:53 pm   the same, for a 12-hour account
//   date         8/5/2026            day-granular, which every account takes
//
// fetchNetsuiteOrders walks this list when NetSuite rejects a literal (see
// isDateLiteralRejected) and remembers what worked, so an account pays for the
// probe once per process. NETSUITE_QUERY_DATE_FORMAT pins the starting point and
// skips it entirely.
export const ORDER_DATE_FORMATS = ["datetime", "datetime12", "date"];

let activeFormat = null;

function envDateFormat() {
  const raw = String(process.env.NETSUITE_QUERY_DATE_FORMAT || "").trim();
  return ORDER_DATE_FORMATS.includes(raw) ? raw : null;
}

// The spelling this process is currently using: whatever a probe last settled
// on, else whatever the env pins, else the narrowest one.
export function orderDateFormat() {
  return activeFormat ?? envDateFormat() ?? ORDER_DATE_FORMATS[0];
}

// The next shape to try after `format` was rejected, or null when the list is
// exhausted and the failure is really NetSuite's answer rather than our spelling.
export function nextOrderDateFormat(format = orderDateFormat()) {
  return ORDER_DATE_FORMATS[ORDER_DATE_FORMATS.indexOf(format) + 1] ?? null;
}

// Remembers a spelling for the rest of the process. `null` forgets it again,
// which is what the tests use to get back to the default.
export function rememberOrderDateFormat(format) {
  if (format !== null && !ORDER_DATE_FORMATS.includes(format)) return false;
  activeFormat = format;
  return true;
}

// Whether a failed request is NetSuite objecting to how a date was WRITTEN, as
// opposed to anything else a 400 can mean. Matched on the parser's own words,
// which are the only part of the body that says so — the status code and
// o:errorCode (INVALID_PARAMETER) are shared with every other bad q.
//
// Deliberately narrow: a false positive here re-sends the whole list call with a
// wider filter for no reason, and a false negative just surfaces the error the
// way it always did.
export function isDateLiteralRejected(err) {
  return /Parse of date\/time|Unparseable date/i.test(err?.message || String(err || ""));
}

// The same instant with its time of day, as a NetSuite datetime literal. This is
// what makes the filter mean the window that was asked for instead of the whole
// day (or three) it falls in.
//
// The literal carries no seconds, so the instant is snapped to a whole minute
// FIRST — and which way it snaps depends on which end of the range it is. `round`
// is "floor" for the lower bound and "ceil" for the upper, so the emitted range
// is always a superset of the real one, never a subset. Snapping both down would
// shave up to 59 seconds off the top of the window, and an order modified in
// that sliver would simply never be returned — inWindow cannot recover a record
// NetSuite did not send.
function nsQueryDateTime(d, timeZone = DEFAULT_TIME_ZONE, round = "floor", format = "datetime") {
  const ms = d.getTime();
  const snapped = new Date(
    round === "ceil" ? Math.ceil(ms / MINUTE_MS) * MINUTE_MS : Math.floor(ms / MINUTE_MS) * MINUTE_MS,
  );
  const p = zonedParts(snapped, timeZone);
  const pad = (n) => String(n).padStart(2, "0");
  // 12-hour accounts write midnight and noon as 12, not 0 — "0:30 am" is as
  // unparseable to them as "23:53" is.
  const clock = format === "datetime12"
    ? `${p.hour % 12 === 0 ? 12 : p.hour % 12}:${pad(p.minute)} ${p.hour < 12 ? "am" : "pm"}`
    : `${pad(p.hour)}:${pad(p.minute)}`;
  return `${p.month}/${p.day}/${p.year} ${clock}`;
}

// The same instant as a bare date: M/D/YYYY, no leading zeros. What an account
// that will not take a time of day gets instead — see ORDER_DATE_FORMATS, and
// dateRangeQuery for the day of slack this shape needs at each end to stay a
// superset of the window.
function nsQueryDate(d, timeZone = DEFAULT_TIME_ZONE) {
  const p = zonedParts(d, timeZone);
  return `${p.month}/${p.day}/${p.year}`;
}

// Whether a fetched record really falls inside an explicit window.
//
// The q filter names the window's own instants now (see nsQueryDateTime), so
// NetSuite should already be returning only what was asked for. This stays as the
// safety net, because the query is evaluated in the NETSUITE ACCOUNT's timezone
// while the literals are written in SYNC_TIMEZONE — and nothing here can verify
// those are the same. If they differ, the returned set is shifted by the offset
// between them, and this is what trims the surplus back off. It also absorbs the
// upward rounding of the upper bound to a whole minute.
//
// A record with no readable lastModifiedDate is KEPT rather than dropped: the
// demo feed carries no dates at all, and judging a window by a field that isn't
// there would turn every demo-mode window sync into a silent no-op.
//
// A record that HAS the field but fails to parse is a different situation and
// worth a warning: silently keeping it too (the same fallback, on purpose — an
// account whose date format Date.parse chokes on should fail open, not start
// dropping orders) would otherwise look identical to "no window field at all"
// and hide a real problem — every record in the window would report false and
// every windowed run would look the same size regardless of which range was
// picked, with nothing in the logs pointing at why.
function inWindow(rec, window) {
  const raw = rec?.lastModifiedDate;
  if (raw == null) return true;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) {
    console.warn(`[netsuite] order ${rec?.id}: lastModifiedDate "${JSON.stringify(raw)}" did not parse as a date — keeping it rather than guessing whether it belongs in the window.`);
    return true;
  }
  return t >= window.from.getTime() && t <= window.to.getTime();
}

// Walks listed order ids, expands each one, and keeps the ones that belong to the
// run. Split out of fetchNetsuiteOrders so this — the part with the decisions in
// it — can be tested without a NetSuite account: `expand` is the only thing that
// touches the network, and a test passes its own.
//
// Two things it decides:
//
//   • which records to keep. With a window, the expanded record's real
//     lastModifiedDate is the first place the true timestamp is available (the
//     list call could only be asked for whole days), so the window is applied
//     here and nowhere else.
//
//   • when to stop. Once `keepLimit` records are IN the window there is no
//     reason to keep paying an expand call and a second of sleep for the rest of
//     the day's ids. `scanStoppedAt` says how far it got, which is what tells the
//     caller whether anything was left unexamined.
//
// An expand that throws is collected, not raised: one unreadable order must not
// cost the run the others. The exception is a throw that means "the run was
// stopped" — that is not this order failing, and recording it as one would put a
// row in the log blaming an order for a button someone pressed.
//
// `stopped` is asked before each expand: an optional async predicate, so the real
// caller can hand it the sync's stop flag while a test needs no notion of one.
//
// `onProgress`, if given, is awaited after each ref that was actually scanned —
// kept, outside the window, or errored alike, since "done" here means "looked
// at", the same meaning bumpSyncDone gives it in the write phase. Not called for
// a ref skipped by keepLimit or a stop, which were never looked at.
export async function scanOrders(refs, { window, keepLimit = Infinity, expand, stopped, onProgress }) {
  const items = [];
  const errors = [];
  let outsideWindow = 0;
  let scanned = 0;
  let scanStoppedAt = null;
  let stoppedByHand = false;

  for (const ref of refs) {
    if (!ref?.id) continue;
    if (items.length >= keepLimit) {
      scanStoppedAt = scanned;
      break;
    }
    if (stopped && (await stopped())) {
      stoppedByHand = true;
      scanStoppedAt = scanned;
      break;
    }
    scanned += 1;
    try {
      const full = await expand(ref.id);
      if (window && !inWindow(full, window)) outsideWindow += 1;
      else items.push(full);
    } catch (err) {
      if (err?.syncStopped) {
        stoppedByHand = true;
        scanStoppedAt = scanned;
        break;
      }
      errors.push({ id: ref.id, error: err?.message || String(err) });
    }
    await onProgress?.();
  }
  return { items, errors, outsideWindow, scanned, scanStoppedAt, stopped: stoppedByHand };
}

// Builds the `q` filter expression for the sales-order list call.
// NETSUITE_ORDERS_QUERY, when set, is a raw q expression that overrides the
// automatic incremental window (manual/backfill mode). Otherwise we filter on
// lastModifiedDate between the watermark and now — or the days they fall on, on
// an account that will not take a time of day (see ORDER_DATE_FORMATS) — or an
// initial window on first run (NETSUITE_INITIAL_SYNC_DAYS, default 2) when
// there's no watermark yet.
const DEFAULT_INITIAL_SYNC_DAYS = 2;

function initialSyncDays() {
  const n = Number(process.env.NETSUITE_INITIAL_SYNC_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INITIAL_SYNC_DAYS;
}

// Overlap buffer, in hours, subtracted from the watermark to get the window's
// from date (from = lastSyncedAt - N hours). Only applies when there IS a
// watermark; the first-run window is NETSUITE_INITIAL_SYNC_DAYS' job. Fractional
// values are allowed, so minutes are expressible: 0.5 = 30 min, 0.25 = 15 min.
// Unset/0/invalid = no buffer, i.e. today's behaviour.
//
// Worth knowing before tuning this on an account stuck on the `date` spelling
// (see ORDER_DATE_FORMATS): there the q filter is day-granular, so the buffer
// only changes the query when it pushes the watermark back across a midnight.
// With lastSyncedAt = 10:00, 2 hours still lands on the same day and the emitted
// q is identical; 11 hours crosses into the previous day and widens the window
// by a full day. With a datetime spelling every value moves the lower bound.
function beforeLastSyncMs() {
  const n = Number(process.env.NETSUITE_BEFORE_LAST_SYNC_HOURS);
  return Number.isFinite(n) && n > 0 ? n * 60 * 60 * 1000 : 0;
}



// The two ends of the filter. With a datetime spelling they are the window's own
// instants and there is nothing more to say; everything below is about the
// `date` spelling, which has to name whole days and therefore has to widen.
//
// NetSuite compares a bare date literal against that date at MIDNIGHT, so
// ON_OR_BEFORE "8/4/2026" means "at or before 8/4 00:00" — the named day's own
// records are EXCLUDED. Measured on this account:
//
//   ON_OR_AFTER 8/4 AND ON_OR_BEFORE 8/4  ->   0 orders
//   ON_OR_AFTER 8/4 AND ON_OR_BEFORE 8/5  ->  96
//   ON_OR_AFTER 8/3 AND ON_OR_BEFORE 8/4  ->  49
//   ON_OR_AFTER 8/3 AND ON_OR_BEFORE 8/5  -> 145   (= 96 + 49, so the buckets
//                                                   partition cleanly)
//
// The top line is the bug this fixes. A window that begins and ends on the same
// UTC day — which is EVERY "last 1/2/6 hours" run, and most 12/24 hour ones —
// emitted exactly that query and NetSuite answered with nothing. The sync looked
// like it worked (no error, an empty run, green log rows) and the range dropdown
// looked like it did nothing at all. The watermark path has the same shape and
// was only spared because the watermark here has never advanced: once it does,
// every run inside the same UTC day would read zero orders.
//
// So the upper bound is the day AFTER `to`. Reading up to a day wider is safe by
// construction: a windowed run re-checks every expanded record against the real
// timestamp (inWindow), and the watermark path is idempotent and already
// re-pulls its own day by truncation.
//
// `lowerMarginDays` pushes the lower bound back, and windowed runs pass 1. That
// is for a different timezone question: NetSuite evaluates these literals in the
// ACCOUNT's timezone, while nsQueryDate names days in `timeZone`. If the two
// differ and the account sits behind, its "8/5" starts some hours after this
// "8/5" does, and a window opening inside that gap would be asked for but never
// returned. A day of slack makes the query a superset of the window whatever the
// account's offset is, and inWindow then cuts it back to exactly what was asked
// for. The watermark path does not take the margin — it has no inWindow to trim
// the surplus, and NETSUITE_BEFORE_LAST_SYNC_HOURS is the knob that exists for
// widening it.
//
// The margin is kept even with SYNC_TIMEZONE set, deliberately. Configuring the
// zone makes the two agree in the normal case, but nothing here can VERIFY that
// the configured zone is the NetSuite account's — a wrong guess with no margin
// silently drops orders at the edges of a window, and the margin costs only scan
// time that inWindow reclaims.
function dateRangeQuery({ from, to }, timeZone = DEFAULT_TIME_ZONE, format = orderDateFormat(), lowerMarginDays = 0) {
  const [after, before] = format === "date"
    ? [
      nsQueryDate(lowerMarginDays ? shiftDays(from, -lowerMarginDays) : from, timeZone),
      nsQueryDate(shiftDays(to, 1), timeZone),
    ]
    : [
      nsQueryDateTime(from, timeZone, "floor", format),
      nsQueryDateTime(to, timeZone, "ceil", format),
    ];
  return `lastModifiedDate ON_OR_AFTER "${after}" AND lastModifiedDate ON_OR_BEFORE "${before}"`;
}

// The stretch of modification time a scheduled run covers: from the watermark
// (less the overlap buffer) to the moment it runs. No watermark yet — a first
// run for this shop, or one that was reset — falls back to a fixed lookback
// instead of pulling the account's entire history.
function watermarkWindow(since, now) {
  return {
    from: since
      ? new Date(since.getTime() - beforeLastSyncMs())
      : new Date(now.getTime() - initialSyncDays() * 24 * 60 * 60 * 1000),
    to: now,
  };
}

// Exported for its tests: this is where the same-day window bug lived, and the
// only way to see it without an account is to read the string it emits.
//
// `timeZone` names the days in the emitted filter. It defaults to UTC so the
// tests — and any caller from before zones were configurable — get exactly the
// string they got before.
//
// `format` is how the literals are spelled (see ORDER_DATE_FORMATS). Defaulted
// to whatever this process has settled on, so a caller that does not care about
// the probe — the schedule card, the CLI script — needs to know nothing about it.
export function buildOrdersQuery(since, window, timeZone = DEFAULT_TIME_ZONE, format = orderDateFormat()) {
  // An explicit window is what an operator just asked for by name ("last 2
  // hours"), so the manual/backfill override does not get to silently replace
  // it — nor does the overlap buffer, which exists to protect the watermark and
  // has no watermark to protect here.
  //
  // The day of lower margin is the `date` spelling's alone: a day-granular
  // filter is only a superset of the window if it is widened at both ends, and
  // inWindow then trims the surplus back off. A datetime spelling names the
  // window exactly and has nothing to widen. The watermark path takes no margin
  // either way — it has no inWindow to reclaim the surplus, and
  // NETSUITE_BEFORE_LAST_SYNC_HOURS is the knob that exists for widening it.
  if (window) return dateRangeQuery(window, timeZone, format, format === "date" ? 1 : 0);
  if (process.env.NETSUITE_ORDERS_QUERY) return process.env.NETSUITE_ORDERS_QUERY;
  return dateRangeQuery(watermarkWindow(since, new Date()), timeZone, format);
}

// What a scheduled run starting at `at` would ask NetSuite for, given the
// watermark. Exported for the log page's schedule card, which has to answer
// "which dates will the next run cover" — and answers it by asking the code that
// will really build that query, so the two cannot drift apart.
//
// `query` is what NetSuite is actually sent, and it is worth showing next to
// from/to: how the literals are spelled is the account's decision, not this
// app's (see ORDER_DATE_FORMATS), and on an account that has fallen back to the
// `date` spelling both ends round out to whole days — so a run reads a good deal
// wider than its window and the query is the only place that shows it.
export function plannedOrdersWindow(since, at = new Date(), timeZone = DEFAULT_TIME_ZONE, format = orderDateFormat()) {
  const window = watermarkWindow(since, at);
  const override = process.env.NETSUITE_ORDERS_QUERY || null;
  return {
    from: window.from,
    to: window.to,
    query: override || dateRangeQuery(window, timeZone, format),
    // NETSUITE_ORDERS_QUERY replaces the window outright, so when it is set the
    // from/to above are not what the run will really read.
    override: Boolean(override),
  };
}
