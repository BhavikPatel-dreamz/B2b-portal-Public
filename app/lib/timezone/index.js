// The timezone the sync thinks in, and the date arithmetic that depends on it.
//
// Deliberately NOT a .server module: the log page renders dates in the browser
// while the sync computes NetSuite queries on the server, and both have to agree
// about which day a timestamp falls on. The zone itself is RESOLVED server-side
// (see timezone.server.js) and the resolved IANA name is handed to the page.
//
// The runtime already exposes timezone rules through Intl, so this module uses the
// platform's built-in support instead of depending on an external package.

// Falls back to UTC, which is what every timestamp in this app was before a zone
// could be configured — so an unset or unusable zone keeps the old behaviour
// rather than inventing a new one.
export const DEFAULT_TIME_ZONE = "UTC";

// The two shapes a date crosses this boundary in. Kept as constants because the
// day-start/day-end pair below and the parser have to agree on them exactly.
const DATE_FMT = "YYYY-MM-DD";
const DATE_TIME_FMT = "YYYY-MM-DD HH:mm:ss.SSS";
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;
const FIXED_OFFSET_RE = /^[+-](?:[01]\d|2[0-3]):[0-5]\d$/;

function pad(value) {
  return String(value).padStart(2, "0");
}

function validateDateParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validateTimeParts(hour, minute, second, millisecond) {
  return (
    Number.isInteger(hour) && hour >= 0 && hour < 24 &&
    Number.isInteger(minute) && minute >= 0 && minute < 60 &&
    Number.isInteger(second) && second >= 0 && second < 60 &&
    Number.isInteger(millisecond) && millisecond >= 0 && millisecond < 1000
  );
}

function getPartsInZone(instant, timeZone) {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return null;

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    millisecond: Number(values.fractionalSecond ?? 0),
  };
}

function getZoneName(instant, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "short",
  });
  const parts = formatter.formatToParts(instant instanceof Date ? instant : new Date(instant));
  const timeZoneNamePart = parts.find((part) => part.type === "timeZoneName");
  return timeZoneNamePart?.value ?? timeZone;
}

function getOffsetMilliseconds(instant, timeZone) {
  const parts = getPartsInZone(instant, timeZone);
  if (!parts) return null;
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond);
  return localAsUtc - (instant instanceof Date ? instant.getTime() : new Date(instant).getTime());
}

function localPartsToEpoch(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond);
}

function getComparableParts(parts) {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}.${String(parts.millisecond).padStart(3, "0")}`;
}

function createDateView(instant, timeZone) {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return null;
  const parts = getPartsInZone(date, timeZone);
  if (!parts) return null;

  return {
    instant: date,
    format(pattern) {
      switch (pattern) {
        case DATE_FMT:
          return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
        case DATE_TIME_FMT:
          return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}.${String(parts.millisecond).padStart(3, "0")}`;
        case "YYYY-MM-DD HH:mm:ss z":
          return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)} ${getZoneName(date, timeZone)}`;
        // How a timestamp is READ on the log page — no leading zeros on the date,
        // a 12-hour clock, no seconds. Built from the same parts as the sortable
        // spelling above rather than from toLocaleString, so it renders the same
        // during SSR and after hydration.
        case "M/D/YYYY h:mm A z": {
          const hour12 = parts.hour % 12 === 0 ? 12 : parts.hour % 12;
          const meridiem = parts.hour < 12 ? "AM" : "PM";
          return `${parts.month}/${parts.day}/${parts.year} ${hour12}:${pad(parts.minute)} ${meridiem} ${getZoneName(date, timeZone)}`;
        }
        case "z":
          return getZoneName(date, timeZone);
        default:
          return "";
      }
    },
    year() {
      return parts.year;
    },
    month() {
      return parts.month - 1;
    },
    date() {
      return parts.day;
    },
    hour() {
      return parts.hour;
    },
    minute() {
      return parts.minute;
    },
    second() {
      return parts.second;
    },
    toDate() {
      return date;
    },
    isValid() {
      return true;
    },
  };
}

// Whether the runtime actually knows this zone. An IANA name the platform's tz
// data doesn't carry throws from Intl, and a throw deep inside the query builder
// on a cron run is a much worse way to find out that SYNC_TIMEZONE has a typo in
// it than a check at the point it is read.
export function isValidTimeZone(name) {
  if (!name || typeof name !== "string") return false;
  if (FIXED_OFFSET_RE.test(name)) return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

// Which zone a run uses: the env override if it names a real zone, else the
// shop's own (what Shopify reports for the store), else UTC.
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
// never the browser's.
export function toInstant(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const raw = String(value).trim();
  if (DATE_ONLY_RE.test(raw)) {
    const [year, month, day] = raw.split("-").map(Number);
    if (!validateDateParts(year, month, day)) return null;
    const d = new Date(Date.UTC(year, month - 1, day));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

// An instant -> the wall clock in `timeZone`, as a date-like object. Accepts a
// Date, an ISO string, or anything the runtime parses.
export function utcToLocal(instant, timeZone = DEFAULT_TIME_ZONE) {
  if (instant === null || instant === undefined || instant === "") return null;
  return createDateView(instant, timeZone);
}

// A wall clock in `timeZone` -> the instant it happens at, as a Date.
export function localToUtc(value, timeZone = DEFAULT_TIME_ZONE) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const dateOnly = DATE_ONLY_RE.test(raw);
  const timeMatch = DATE_TIME_RE.exec(raw);
  if (!dateOnly && !timeMatch) return null;

  let year;
  let month;
  let day;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let millisecond = 0;

  if (dateOnly) {
    [year, month, day] = raw.split("-").map(Number);
  } else {
    year = Number(timeMatch[1]);
    month = Number(timeMatch[2]);
    day = Number(timeMatch[3]);
    hour = Number(timeMatch[4]);
    minute = Number(timeMatch[5]);
    second = Number(timeMatch[6]);
    millisecond = Number(timeMatch[7] ?? 0);
  }

  if (!validateDateParts(year, month, day) || !validateTimeParts(hour, minute, second, millisecond)) return null;

  const targetParts = { year, month, day, hour, minute, second, millisecond };
  const targetEpoch = localPartsToEpoch(targetParts);
  let candidateEpoch = targetEpoch;

  for (let i = 0; i < 20; i += 1) {
    const offsetMs = getOffsetMilliseconds(new Date(candidateEpoch), timeZone);
    if (offsetMs === null) return null;
    const nextEpoch = targetEpoch - offsetMs;
    if (Math.abs(nextEpoch - candidateEpoch) < 1) {
      const actualParts = getPartsInZone(new Date(nextEpoch), timeZone);
      if (!actualParts) return null;
      if (getComparableParts(actualParts) === getComparableParts(targetParts)) {
        return new Date(nextEpoch);
      }
      return null;
    }
    candidateEpoch = nextEpoch;
  }

  return null;
}

// ---------------------------------------------------------------------------
// What the rest of the app calls
// ---------------------------------------------------------------------------

// "2026-08-05" -> the instant that day BEGINS in `timeZone`, and the last instant
// it holds. A date-only field can't carry a zone, so this is what decides which
// stretch of real time a typed date means.
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

// The same instant in the shape the log page shows it: M/D/YYYY h:mm AM/PM, with
// the zone still named. Separate from formatInZone rather than replacing it —
// that one is sortable and keeps its seconds, which is what the raw values in the
// detail modal and any machine-read line want.
export function formatDisplayInZone(instant, timeZone = DEFAULT_TIME_ZONE) {
  return utcToLocal(instant, timeZone)?.format("M/D/YYYY h:mm A z") ?? "";
}

export function zoneAbbreviation(instant, timeZone = DEFAULT_TIME_ZONE) {
  return utcToLocal(instant, timeZone)?.format("z") ?? timeZone;
}
