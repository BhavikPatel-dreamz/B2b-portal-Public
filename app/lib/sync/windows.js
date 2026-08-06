import { DEFAULT_TIME_ZONE, zonedDateString, zonedDayEnd, zonedDayStart } from "../timezone/index.js";
// The ranges the log page's "Sync now" control offers, and the labels that name
// them everywhere afterwards — the toast, the run log, the log row's detail.
//
// Deliberately NOT a .server module: the dropdown that renders these ships to the
// browser, while the sync that runs them does not. Keeping the list in one place
// is what stops the two disagreeing about what "last 2 hours" means.
//
// `value` is what the form field carries; `hours` is how far back the window
// reaches from the moment Sync now is pressed.
//
// Every entry here is a WINDOW: a run started from the page reads exactly the
// stretch named, never "everything since the last sync". A clean windowed run
// does now move the watermark, but only to the END of the window it was given —
// see advanceWatermarkToWindow — which is why there is still no windowless entry
// here. One would be the scheduled run fired by hand, with the whole outstanding
// backlog behind it and no bound on what it reads.
//
// The first entry is what the dropdown starts on.

export const SYNC_WINDOWS = [
  { value: "1", hours: 1, label: "Last 1 hour" },
  { value: "2", hours: 2, label: "Last 2 hours" },
  { value: "6", hours: 6, label: "Last 6 hours" },
  { value: "12", hours: 12, label: "Last 12 hours" },
  { value: "24", hours: 24, label: "Last day" },
  { value: "48", hours: 48, label: "Last 2 days" },
];

// What the dropdown is set to before anyone touches it. Taken from the list
// rather than written out again, so reordering the options cannot leave the
// default pointing at an entry that is no longer first — or, worse, at a value
// the list does not hold at all, which the Sync now route rejects outright.
export const DEFAULT_SYNC_WINDOW = SYNC_WINDOWS[0].value;

// The pair of instants a range means: `to` is the moment it is asked for, `from`
// is exactly that many hours earlier. Epoch arithmetic on absolute instants, so
// the server's (or the browser's) timezone never enters into it — the two can
// compute this independently and cannot disagree.
//
// It lives here, next to the list, because BOTH sides need it: the page shows
// the pair under the dropdown so the range is not just a name, and the run uses
// it as the window it really syncs. The page cannot import order-sync.server.js
// to get it, so without this the two would each do their own arithmetic — and a
// preview that quietly disagreed with the run would be worse than none.
export function windowRange(hours, at = new Date()) {
  return { from: new Date(at.getTime() - hours * 60 * 60 * 1000), to: at };
}

export function windowLabel(hours) {
  const match = SYNC_WINDOWS.find((w) => w.hours === Number(hours));
  return match?.hours ? match.label.toLowerCase() : `last ${hours} hour(s)`;
}

// ---------------------------------------------------------------------------
// Custom from/to range
// ---------------------------------------------------------------------------
// The second way to scope a Sync now, alongside the presets above: two dates
// typed by hand, passed straight through to the NetSuite salesorder query as the
// range it should read.
//
// Deliberately NOT an entry in SYNC_WINDOWS. Every entry there is a fixed number
// of hours back from "now" and callers rely on that (`hours` drives both the
// preview and the resume session); a range with its own two ends is a different
// shape, so it gets its own sentinel value and its own constructor. The dropdown
// renders it as one extra option after the presets.
export const CUSTOM_SYNC_WINDOW = "custom";

// The date fields are date-only (that is what s-date-field gives), so a range is
// read as whole days: the from-day from its first instant, the to-day to its
// last. Without this a same-day from/to would be a zero-length window and match
// nothing — the same reason the log table's own date filters do this.
//
// WHICH days those are is a timezone question — "2026-08-05" in Asia/Kolkata
// begins at 2026-08-04T18:30Z, not at midnight UTC — so both take the zone the
// sync is configured to think in. It defaults to UTC, which is what these meant
// before a zone could be configured.
export function dayStartUtc(value, timeZone = DEFAULT_TIME_ZONE) {
  return zonedDayStart(value, timeZone);
}

export function dayEndUtc(value, timeZone = DEFAULT_TIME_ZONE) {
  return zonedDayEnd(value, timeZone);
}

// A ceiling on how much one custom range may ask for. A range is scanned the
// same way a preset window is — every candidate id in it costs an expand call
// and a second of rate-limit sleep — so "1 Jan to today" is not a request this
// can serve in one run, and refusing it by name is better than accepting it and
// capping silently at the page limit.
export const MAX_CUSTOM_RANGE_DAYS = 31;

// Turns two date-only strings into the pair of instants a run will use, or an
// error naming what is wrong with them. One function, shared by the page (which
// previews the range) and the Sync now route (which validates and runs it), so
// the preview and the run can never disagree about what was asked for.
//
// Returns { from, to } on success, { error } otherwise — never throws, because
// both callers have somewhere better to put the message than a stack trace.
//
// `timeZone` decides which real stretch the two typed dates mean. The page and
// the Sync now route must pass the SAME one — both take it from the loader's
// schedule.timeZone, which is what getSyncTimeZone resolved — or the range
// previewed would not be the range run.
export function parseCustomRange(fromValue, toValue, timeZone = DEFAULT_TIME_ZONE) {
  const from = fromValue ? dayStartUtc(String(fromValue).trim(), timeZone) : null;
  const to = toValue ? dayEndUtc(String(toValue).trim(), timeZone) : null;
  if (!from || !to) return { error: "Pick both a From and a To date for a custom range." };
  if (from > to) return { error: "The From date has to be on or before the To date." };
  // Rounded, because a range spanning a DST change is 23 or 25 hours on one of
  // its days and would otherwise come out a fraction over or under a whole
  // number of days.
  const days = Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
  if (days > MAX_CUSTOM_RANGE_DAYS) {
    return {
      error: `A custom range covers at most ${MAX_CUSTOM_RANGE_DAYS} days — this one is ${days}. Narrow it, or run it in a few passes.`,
    };
  }
  return { from, to };
}

// How a custom range names itself everywhere afterwards — the toast, the run
// log, the log row's mode. Named in the sync's own zone, so a row in the table
// can be read against the range that produced it — the instants are UTC, and
// rendering them as UTC days would print a different pair of dates than the ones
// that were typed.
export function rangeLabel(from, to, timeZone = DEFAULT_TIME_ZONE) {
  return `${zonedDateString(from, timeZone)} → ${zonedDateString(to, timeZone)} (custom range)`;
}
