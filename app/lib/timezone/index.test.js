import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_TIME_ZONE,
  formatInZone,
  isValidTimeZone,
  resolveTimeZone,
  zonedDateString,
  zonedDayEnd,
  zonedDayStart,
} from "./index.js";

// The timezone the sync thinks in. Pure — no database, no NetSuite — so it runs
// anywhere, which matters because this is the arithmetic that decides which DAY an
// order was modified on, and therefore whether a run fetches it at all.

const iso = (d) => d.toISOString();

describe("resolveTimeZone", () => {
  it("prefers the env override", () => {
    assert.equal(resolveTimeZone("Asia/Kolkata", "America/New_York"), "Asia/Kolkata");
  });

  it("falls back to the shop's zone when the env is blank", () => {
    assert.equal(resolveTimeZone("", "America/New_York"), "America/New_York");
    assert.equal(resolveTimeZone(null, "America/New_York"), "America/New_York");
  });

  it("ignores an env value that is not a real zone rather than throwing later", () => {
    // A typo in SYNC_TIMEZONE must not take a cron run down hours after it was
    // made, and must not silently become the string it was mistyped as.
    assert.equal(resolveTimeZone("Asia/Kolkta", "America/New_York"), "America/New_York");
  });

  it("ends at UTC when nothing usable was given", () => {
    assert.equal(resolveTimeZone("", ""), DEFAULT_TIME_ZONE);
    assert.equal(resolveTimeZone(null, null), DEFAULT_TIME_ZONE);
    assert.equal(resolveTimeZone("Not/AZone", "Also/Not"), DEFAULT_TIME_ZONE);
  });
});

describe("isValidTimeZone", () => {
  it("accepts real IANA names", () => {
    assert.equal(isValidTimeZone("UTC"), true);
    assert.equal(isValidTimeZone("Asia/Kolkata"), true);
    assert.equal(isValidTimeZone("America/New_York"), true);
  });

  it("rejects a name the runtime does not know, and non-strings", () => {
    assert.equal(isValidTimeZone("Not/AZone"), false);
    assert.equal(isValidTimeZone("Asia/Kolkta"), false);
    assert.equal(isValidTimeZone(""), false);
    assert.equal(isValidTimeZone(null), false);
    assert.equal(isValidTimeZone(undefined), false);
  });

  it("also accepts a fixed UTC offset, which the runtime treats as a zone", () => {
    // Worth pinning down rather than leaving to chance: SYNC_TIMEZONE="+05:30"
    // works, and works correctly (see the day-boundary assertion below). It is a
    // reasonable thing to set for an account on a fixed offset — but it has no
    // DST rules, so a zone that observes DST must be named, not offset.
    assert.equal(isValidTimeZone("+05:30"), true);
    assert.equal(iso(zonedDayStart("2026-08-05", "+05:30")), "2026-08-04T18:30:00.000Z");
    // A malformed offset is still refused, so a typo doesn't slip through.
    assert.equal(isValidTimeZone("05:30"), false);
    assert.equal(isValidTimeZone("+5:30"), false);
  });
});

describe("day boundaries", () => {
  it("UTC is unchanged from what these meant before zones existed", () => {
    // The regression guard for every unconfigured install.
    assert.equal(iso(zonedDayStart("2026-08-05", "UTC")), "2026-08-05T00:00:00.000Z");
    assert.equal(iso(zonedDayEnd("2026-08-05", "UTC")), "2026-08-05T23:59:59.999Z");
  });

  it("defaults to UTC when no zone is given", () => {
    assert.equal(iso(zonedDayStart("2026-08-05")), "2026-08-05T00:00:00.000Z");
    assert.equal(iso(zonedDayEnd("2026-08-05")), "2026-08-05T23:59:59.999Z");
  });

  it("shifts a whole-offset zone", () => {
    // Asia/Kolkata is +05:30 all year, so its day begins 5½ hours before UTC's.
    assert.equal(iso(zonedDayStart("2026-08-05", "Asia/Kolkata")), "2026-08-04T18:30:00.000Z");
    assert.equal(iso(zonedDayEnd("2026-08-05", "Asia/Kolkata")), "2026-08-05T18:29:59.999Z");
  });

  it("a day is 24 hours long outside a DST change", () => {
    const start = zonedDayStart("2026-08-05", "America/New_York");
    const end = zonedDayEnd("2026-08-05", "America/New_York");
    assert.equal(end.getTime() - start.getTime(), 24 * 60 * 60 * 1000 - 1);
  });

  // The two days a year that break naive date arithmetic. Getting these wrong
  // shifts a whole day's window by an hour, which on a "last 1 hour" run is the
  // difference between fetching the right orders and fetching none.
  it("a spring-forward day is 23 hours long", () => {
    const start = zonedDayStart("2026-03-08", "America/New_York");
    const end = zonedDayEnd("2026-03-08", "America/New_York");
    assert.equal(iso(start), "2026-03-08T05:00:00.000Z", "starts at midnight EST");
    assert.equal(iso(end), "2026-03-09T03:59:59.999Z", "ends at 23:59:59.999 EDT");
    assert.equal(end.getTime() - start.getTime(), 23 * 60 * 60 * 1000 - 1);
  });

  it("a fall-back day is 25 hours long", () => {
    const start = zonedDayStart("2026-11-01", "America/New_York");
    const end = zonedDayEnd("2026-11-01", "America/New_York");
    assert.equal(iso(start), "2026-11-01T04:00:00.000Z", "starts at midnight EDT");
    assert.equal(iso(end), "2026-11-02T04:59:59.999Z", "ends at 23:59:59.999 EST");
    assert.equal(end.getTime() - start.getTime(), 25 * 60 * 60 * 1000 - 1);
  });

  it("refuses a date that isn't one rather than rolling it over", () => {
    // Date.UTC would turn 2026-13-45 into some day in 2027 and sync it.
    assert.equal(zonedDayStart("2026-13-45", "UTC"), null);
    assert.equal(zonedDayStart("2026-02-30", "UTC"), null);
    assert.equal(zonedDayStart("2026-00-10", "UTC"), null);
    assert.equal(zonedDayStart("not-a-date", "UTC"), null);
    assert.equal(zonedDayStart("", "UTC"), null);
    assert.equal(zonedDayStart(null, "UTC"), null);
    assert.equal(zonedDayEnd("2026-02-30", "UTC"), null);
  });

  it("accepts a real leap day", () => {
    assert.equal(iso(zonedDayStart("2028-02-29", "UTC")), "2028-02-29T00:00:00.000Z");
    assert.equal(zonedDayStart("2026-02-29", "UTC"), null, "2026 is not a leap year");
  });

  it("round-trips: an instant's day, re-expanded, contains it", () => {
    for (const zone of ["UTC", "Asia/Kolkata", "America/New_York", "Pacific/Auckland"]) {
      for (const at of ["2026-08-05T20:30:00Z", "2026-01-01T00:00:00Z", "2026-11-01T05:30:00Z"]) {
        const instant = new Date(at);
        const day = zonedDateString(instant, zone);
        const start = zonedDayStart(day, zone);
        const end = zonedDayEnd(day, zone);
        assert.ok(
          start <= instant && instant <= end,
          `${at} in ${zone}: ${day} spans ${iso(start)}..${iso(end)}, which does not contain it`,
        );
      }
    }
  });
});

describe("zonedDateString", () => {
  it("names the day the instant falls on in that zone, not in UTC", () => {
    // 20:30Z is already tomorrow in Kolkata and still today in New York — the
    // single clearest case for why the log page cannot just slice an ISO string.
    const instant = new Date("2026-08-05T20:30:00Z");
    assert.equal(zonedDateString(instant, "UTC"), "2026-08-05");
    assert.equal(zonedDateString(instant, "Asia/Kolkata"), "2026-08-06");
    assert.equal(zonedDateString(instant, "America/New_York"), "2026-08-05");
  });
});

describe("formatInZone", () => {
  it("renders the wall clock in that zone and names the zone", () => {
    const instant = new Date("2026-08-05T20:30:00Z");
    assert.equal(formatInZone(instant, "UTC"), "2026-08-05 20:30:00 UTC");
    assert.match(formatInZone(instant, "America/New_York"), /^2026-08-05 16:30:00 EDT$/);
    assert.match(formatInZone(instant, "Asia/Kolkata"), /^2026-08-06 02:00:00 /);
  });

  it("takes an ISO string as well as a Date, since that is what the loader sends", () => {
    assert.equal(formatInZone("2026-08-05T20:30:00.000Z", "UTC"), "2026-08-05 20:30:00 UTC");
  });

  it("renders midnight as 00, not 24", () => {
    // hourCycle h23 rather than hour12:false — the latter renders midnight as
    // "24" on some engines, which would print the wrong day.
    assert.equal(formatInZone("2026-08-05T00:00:00.000Z", "UTC"), "2026-08-05 00:00:00 UTC");
  });

  it("returns empty for an unreadable date rather than 'Invalid Date'", () => {
    assert.equal(formatInZone("nonsense", "UTC"), "");
  });
});
