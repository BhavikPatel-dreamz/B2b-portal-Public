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
// The account will say how, if it is asked: GET /preference/userPreference
// answers with the three settings its parser uses.
//
//   { "timeZone": { "id": "America/New_York", "refName": "(GMT-05:00) …" },
//     "dateFormat": "M/d/YYYY",
//     "timeFormat": "h:mm a" }
//
// So the spelling is not hard-coded. These are the shapes, in the order they are
// tried, for the preference above:
//
//   iso      '2026-08-05T23:53:00Z'   ISO 8601, in UTC
//   account  "8/5/2026 7:53 pm"       dateFormat + timeFormat, in the account's zone
//   date     "8/5/2026"               dateFormat alone — day-granular, always parses
//
// ISO leads because it is the only one that does not depend on the preference at
// all: it carries its own zone in the trailing Z, so the instant it names is the
// instant that was asked for whatever the account is set to, and it still works
// on the run where the preference could not be read.
//
// `account` is the fallback with the real answer behind it — the same instant
// written the way that account writes dates, in the zone it compares them in.
// Before the preference endpoint it was a guess between a 24- and a 12-hour
// clock, which is what the 400 that started all this was:
//
//   Parse of date/time "8/5/2026 23:53" failed with date format "M/d/yy"
//   in time zone America/Los_Angeles
//
// fetchNetsuiteOrders walks this list when NetSuite rejects a literal (see
// isDateLiteralRejected) and remembers what worked, so an account pays for the
// probe once per process. NETSUITE_QUERY_DATE_FORMAT pins the starting point and
// skips it entirely.
export const ORDER_DATE_FORMATS = ["iso", "account", "date"];

// What NetSuite's parser is configured to accept, once something has asked it.
// Held here rather than passed down through every caller because it is one fact
// about one account: the sync fetches it (fetchAccountPreference), and the
// schedule card and the CLI script get the same answer without knowing that a
// fetch ever happened.
const DEFAULT_PREFERENCE = { dateFormat: "M/d/YYYY", timeFormat: "HH:mm", timeZone: null };
let preference = null;

// The preference as it is known right now. Null until something reads it, which
// is not a failure — it means the account-formatted spellings fall back to
// DEFAULT_PREFERENCE, i.e. what this code assumed before the endpoint existed.
export function accountPreference() {
  return preference;
}

// Takes the useful three fields out of the /preference/userPreference body, or
// null if it carries none of them. Pure, so the parsing is testable without an
// account, and defensive: the fields are read one at a time and a body missing
// any of them still yields the others.
export function readAccountPreference(body) {
  const dateFormat = typeof body?.dateFormat === "string" ? body.dateFormat.trim() : "";
  const timeFormat = typeof body?.timeFormat === "string" ? body.timeFormat.trim() : "";
  const timeZone = typeof body?.timeZone?.id === "string" ? body.timeZone.id.trim() : "";
  if (!dateFormat && !timeFormat && !timeZone) return null;
  return {
    dateFormat: dateFormat || DEFAULT_PREFERENCE.dateFormat,
    timeFormat: timeFormat || DEFAULT_PREFERENCE.timeFormat,
    timeZone: timeZone || null,
  };
}

// Remembers the account's preference for the rest of the process. `null` forgets
// it, which is what the tests use to get back to the defaults.
export function rememberAccountPreference(next) {
  preference = next;
}

let activeFormat = null;

function envDateFormat() {
  const raw = String(process.env.NETSUITE_QUERY_DATE_FORMAT || "").trim();
  return ORDER_DATE_FORMATS.includes(raw) ? raw : null;
}

// The spelling this process is currently using: whatever a probe last settled
// on, else whatever the env pins, else the zone-independent one.
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

// Renders zoned calendar parts through one of NetSuite's format-preference
// patterns. They are Java date patterns, and the account can be set to any of a
// short list of them — "M/d/YYYY", "d/M/YYYY", "d.M.YYYY", "d-MMM-YYYY",
// "YYYY-M-d" for dates; "h:mm a" or "HH:mm" for times — so this reads the
// pattern rather than hard-coding the handful of shapes it produces.
//
// One pass over the string, so a token can never match inside what an earlier
// token already produced (the "d" of a rendered "Wed", say). Anything that is
// not a recognised token — the slashes, dots and dashes that separate them —
// falls through untouched, which is what carries the separators over.
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PATTERN_TOKEN = /y+|Y+|M+|d+|H+|h+|m+|s+|a/g;

function renderPattern(pattern, p) {
  const pad = (n) => String(n).padStart(2, "0");
  return pattern.replace(PATTERN_TOKEN, (token) => {
    const wide = token.length >= 2;
    switch (token[0]) {
      // "yy" is the two-digit year and anything longer is the full one. NetSuite
      // writes the four-digit case as either "yyyy" or "YYYY".
      case "y": case "Y": return token.length === 2 ? pad(p.year % 100) : String(p.year);
      case "M": return token.length >= 3 ? MONTHS_SHORT[p.month - 1] : wide ? pad(p.month) : String(p.month);
      case "d": return wide ? pad(p.day) : String(p.day);
      case "H": return wide ? pad(p.hour) : String(p.hour);
      // Midnight and noon are 12 on a 12-hour clock, never 0 — "0:30 am" is as
      // unparseable to such an account as "23:53" is to this one.
      case "h": return wide ? pad(p.hour % 12 || 12) : String(p.hour % 12 || 12);
      case "m": return wide ? pad(p.minute) : String(p.minute);
      case "s": return wide ? pad(p.second) : String(p.second);
      case "a": return p.hour < 12 ? "am" : "pm";
      default: return token;
    }
  });
}

// The zone the account-formatted literals are written in: the account's own,
// when the preference has been read, because that is the zone NetSuite compares
// them in. `timeZone` — SYNC_TIMEZONE, or the Shopify store's — is the fallback
// for a run that could not read it, which is the guess this replaced.
function literalZone(timeZone) {
  return preference?.timeZone || timeZone;
}

// The same instant with its time of day, as a NetSuite datetime literal. This is
// what makes the filter mean the window that was asked for instead of the whole
// day (or three) it falls in.
//
// None of these literals carry sub-minute precision, so the instant is snapped to
// a whole minute FIRST — and which way it snaps depends on which end of the range
// it is. `round` is "floor" for the lower bound and "ceil" for the upper, so the
// emitted range is always a superset of the real one, never a subset. Snapping
// both down would shave up to 59 seconds off the top of the window, and an order
// modified in that sliver would simply never be returned — inWindow cannot
// recover a record NetSuite did not send.
function nsQueryDateTime(d, timeZone = DEFAULT_TIME_ZONE, round = "floor", format = "iso") {
  const ms = d.getTime();
  const snapped = new Date(
    round === "ceil" ? Math.ceil(ms / MINUTE_MS) * MINUTE_MS : Math.floor(ms / MINUTE_MS) * MINUTE_MS,
  );
  // ISO names the instant itself, so it is written in UTC and neither the zone
  // nor the preference enters into it — that is the whole reason it is the first
  // shape tried. The milliseconds are dropped because the value is already
  // snapped to a minute and ".000" only makes the query harder to read against
  // NetSuite's own screens.
  if (format === "iso") return snapped.toISOString().replace(/\.\d{3}Z$/, "Z");

  const pref = preference ?? DEFAULT_PREFERENCE;
  const p = zonedParts(snapped, literalZone(timeZone));
  return `${renderPattern(pref.dateFormat, p)} ${renderPattern(pref.timeFormat, p)}`;
}

// The same instant as a bare date, in the account's date format. What an account
// that will not take a time of day gets instead — see ORDER_DATE_FORMATS, and
// dateRangeQuery for the day of slack this shape needs at each end to stay a
// superset of the window.
function nsQueryDate(d, timeZone = DEFAULT_TIME_ZONE) {
  return renderPattern((preference ?? DEFAULT_PREFERENCE).dateFormat, zonedParts(d, literalZone(timeZone)));
}

// Whether a fetched record really falls inside an explicit window.
//
// The q filter names the window's own instants now (see nsQueryDateTime), so
// NetSuite should already be returning only what was asked for. This stays as
// the safety net, because how much of the window the filter really covers
// depends on which spelling the account accepted (see ORDER_DATE_FORMATS):
//
//   • on `iso` there is nothing to correct for — the literal carries its own
//     zone — beyond the upward rounding of the upper bound to a whole minute;
//   • on the account-formatted shapes the query is evaluated in the NETSUITE
//     ACCOUNT's timezone while the literals are written in SYNC_TIMEZONE, and
//     nothing here can verify those are the same. If they differ, the returned
//     set is shifted by the offset between them;
//   • on `date` the filter can only name whole days, so it is wider than the
//     window by a day at each end by construction.
//
// This is what trims all three back to exactly what was asked for.
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
// by a full day. With any of the other spellings every value moves the lower bound.
function beforeLastSyncMs() {
  const n = Number(process.env.NETSUITE_BEFORE_LAST_SYNC_HOURS);
  return Number.isFinite(n) && n > 0 ? n * 60 * 60 * 1000 : 0;
}



// The two ends of the filter. With `iso` or either datetime spelling they are the
// window's own instants and there is nothing more to say; everything below is
// about `date`, which has to name whole days and therefore has to widen.
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
  // An ISO literal is single-quoted, the account-formatted ones double-quoted —
  // each as NetSuite's own examples write that shape.
  const qt = format === "iso" ? "'" : '"';
  return `lastModifiedDate ON_OR_AFTER ${qt}${after}${qt} AND lastModifiedDate ON_OR_BEFORE ${qt}${before}${qt}`;
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
// `timeZone` names the days in the emitted filter, and is ignored entirely by the
// `iso` spelling, which writes the instants in UTC. It defaults to UTC so the
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
  // inWindow then trims the surplus back off. Every other spelling names the
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
