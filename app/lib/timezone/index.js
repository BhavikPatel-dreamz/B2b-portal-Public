import dayjs from "dayjs";
import advancedFormat from "dayjs/plugin/advancedFormat.js";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import timezonePlugin from "dayjs/plugin/timezone.js";
import utcPlugin from "dayjs/plugin/utc.js";

// The timezone the sync thinks in, and the date arithmetic that depends on it.
//
// Deliberately NOT a .server module: the log page renders dates in the browser
// while the sync computes NetSuite queries on the server, and both have to agree
// about which day a timestamp falls on. The zone itself is RESOLVED server-side
// (see timezone.server.js) and the resolved IANA name is handed to the page.
//
// dayjs with the utc + timezone plugins does the zone maths. The plugins read the
// same IANA database Intl exposes, so a zone's real offset on a given date —
// including the DST changes that make one day of the year 23 hours long and
// another 25 — comes from the platform rather than from anything written here.
dayjs.extend(utcPlugin);
dayjs.extend(timezonePlugin);
dayjs.extend(advancedFormat);
dayjs.extend(customParseFormat);

// Falls back to UTC, which is what every timestamp in this app was before a zone
// could be configured — so an unset or unusable zone keeps the old behaviour
// rather than inventing a new one.
export const DEFAULT_TIME_ZONE = "UTC";

// The two shapes a date crosses this boundary in. Kept as constants because the
// day-start/day-end pair below and the parser have to agree on them exactly.
const DATE_FMT = "YYYY-MM-DD";
const DATE_TIME_FMT = "YYYY-MM-DD HH:mm:ss.SSS";

// Whether the runtime actually knows this zone. An IANA name the platform's tz
// data doesn't carry throws from dayjs.tz, and a throw deep inside the query
// builder — on a cron run, hours later — is a much worse way to find out that
// SYNC_TIMEZONE has a typo in it than a check at the point it is read.
export function isValidTimeZone(name) {
  if (!name || typeof name !== "string") return false;
  try {
    // dayjs.tz delegates to Intl, which throws on an unknown zone. Formatting a
    // fixed instant is the cheapest way to make it do that.
    dayjs.utc(0).tz(name);
    return true;
  } catch {
    return false;
  }
}

// Which zone a run uses: the env override if it names a real zone, else the
// shop's own (what Shopify reports for the store), else UTC.
//
// The override exists because the zone that matters for the NetSuite query is the
// NETSUITE account's, and that is not necessarily the Shopify store's — see the
// note on nsQueryDate. When the two differ, SYNC_TIMEZONE is how you say so.
export function resolveTimeZone(envZone, shopZone) {
  if (isValidTimeZone(envZone)) return envZone;
  if (isValidTimeZone(shopZone)) return shopZone;
  return DEFAULT_TIME_ZONE;
}

// ---------------------------------------------------------------------------
// The two conversions
// ---------------------------------------------------------------------------
// Everything else in this file is built from these. They are named for the
// direction they go, because getting that backwards is the whole class of bug
// here and a name like "convert" would hide it:
//
//   utcToLocal   an instant  ->  the wall clock a person in `timeZone` reads
//   localToUtc   a wall clock in `timeZone`  ->  the instant it happens at
//
// "local" throughout means the SYNC's configured zone, never the server's and
// never the browser's. Neither of those is ever consulted: the server's zone is
// whatever the host happens to be set to, and the browser's is the viewer's,
// and a date that changed meaning depending on who was looking at it is exactly
// what this module exists to prevent.

// Any date-ish value -> a Date, or null if it isn't one. What fetchSalesOrders
// runs its `from`/`to` through before they become a NetSuite query.
//
// Two things here are deliberate, and both were wrong on the first attempt:
//
//   • A bare "YYYY-MM-DD" is read as UTC, not as the machine's local midnight.
//     Plain dayjs(value) uses local, which would silently shift a date-only
//     bound by the server's offset — on this machine, 5.5 hours. The Date
//     constructor reads that exact shape as UTC, and every caller means UTC, so
//     that behaviour is preserved rather than quietly changed.
//   • It is parsed STRICTLY. dayjs is happy to roll "2026-08-32" over into
//     31 Aug (and "2026-13-01" into 2027), which is a silently wrong date range
//     rather than a refused one.
//
// Anything with a time in it goes through dayjs's ordinary parsing, which
// handles ISO offsets correctly and answers isValid() the same way on every
// engine — the reason this is dayjs and not `new Date()` plus a NaN check.
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function toInstant(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const d = dayjs(value);
    return d.isValid() ? d.toDate() : null;
  }
  const raw = String(value).trim();
  const d = DATE_ONLY_RE.test(raw) ? dayjs.utc(raw, "YYYY-MM-DD", true) : dayjs(raw);
  return d.isValid() ? d.toDate() : null;
}

// An instant -> the wall clock in `timeZone`, as a dayjs object. Accepts a Date,
// an ISO string, or anything dayjs parses; returns null for something that isn't
// a date at all, so a caller can say so rather than printing "Invalid Date".
export function utcToLocal(instant, timeZone = DEFAULT_TIME_ZONE) {
  if (instant === null || instant === undefined || instant === "") return null;
  const d = dayjs(instant);
  return d.isValid() ? d.tz(timeZone) : null;
}

// A wall clock in `timeZone` -> the instant it happens at, as a Date.
//
// `value` is a plain date or date-time string with no zone in it ("2026-08-05",
// "2026-08-05 23:59:59.999") — the shape a date-only form field gives, which is
// exactly the input that has no zone of its own and therefore needs one supplied.
// Parsed strictly against the two formats above so a half-typed or nonsense value
// is rejected rather than guessed at: dayjs in loose mode will happily read
// "2026-13-45" as some day in 2027, and syncing that is worse than refusing it.
export function localToUtc(value, timeZone = DEFAULT_TIME_ZONE) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const fmt = raw.length > DATE_FMT.length ? DATE_TIME_FMT : DATE_FMT;
  // Validated BEFORE the zone is applied, and with no zone involved. Two reasons,
  // both learned the hard way: dayjs.tz THROWS a RangeError on an unparseable
  // date rather than returning an invalid object, so an isValid() check placed
  // after it never runs; and dayjs.tz does not honour the strict flag, so
  // "2026-13-45" would be rolled over into 2027 and quietly synced.
  if (!dayjs(raw, fmt, true).isValid()) return null;
  try {
    return dayjs.tz(raw, fmt, timeZone).toDate();
  } catch {
    // An unknown zone. Callers are handed a validated zone (see resolveTimeZone),
    // so this is the belt to that braces — a null bound is refused upstream,
    // while a throw here would take down a whole run.
    return null;
  }
}

// ---------------------------------------------------------------------------
// What the rest of the app calls
// ---------------------------------------------------------------------------

// "2026-08-05" -> the instant that day BEGINS in `timeZone`, and the last instant
// it holds. A date-only field can't carry a zone, so this is what decides which
// stretch of real time a typed date means.
//
// Returns null for anything that isn't a YYYY-MM-DD date, so a half-typed field
// reads as "no bound" rather than as the epoch.
export function zonedDayStart(value, timeZone = DEFAULT_TIME_ZONE) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  return localToUtc(`${raw} 00:00:00.000`, timeZone);
}

export function zonedDayEnd(value, timeZone = DEFAULT_TIME_ZONE) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  return localToUtc(`${raw} 23:59:59.999`, timeZone);
}

// The calendar date an instant falls on in `timeZone`, as YYYY-MM-DD. What a log
// row's date filter is compared against, and what names a custom range.
export function zonedDateString(instant, timeZone = DEFAULT_TIME_ZONE) {
  return utcToLocal(instant, timeZone)?.format(DATE_FMT) ?? "";
}

// The calendar parts of an instant in `timeZone`. Used by the NetSuite query
// builder, which needs M/D/YYYY with no leading zeros — a different shape from
// everything else here, so it gets the numbers rather than a formatted string.
export function zonedParts(instant, timeZone = DEFAULT_TIME_ZONE) {
  const d = utcToLocal(instant, timeZone);
  if (!d) return null;
  return {
    year: d.year(),
    // dayjs months are 0-based; every caller here wants the human month.
    month: d.month() + 1,
    day: d.date(),
    hour: d.hour(),
    minute: d.minute(),
    second: d.second(),
  };
}

// A timestamp as a person in `timeZone` would read it, with the zone named so it
// can be compared against NetSuite's own screens without translating it in your
// head. `z` is the abbreviation (IST, GMT, EDT…) that advancedFormat adds.
export function formatInZone(instant, timeZone = DEFAULT_TIME_ZONE) {
  return utcToLocal(instant, timeZone)?.format("YYYY-MM-DD HH:mm:ss z") ?? "";
}

export function zoneAbbreviation(instant, timeZone = DEFAULT_TIME_ZONE) {
  return utcToLocal(instant, timeZone)?.format("z") ?? timeZone;
}
