import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_TIME_ZONE, localToUtc, toInstant, utcToLocal } from "./index.js";

// The two conversions everything else in timezone.js is built from. "local" here
// always means the SYNC's configured zone — never the server's, never the
// browser's.

const iso = (d) => d.toISOString();

describe("utcToLocal", () => {
  it("moves an instant onto the wall clock of the zone", () => {
    const at = new Date("2026-08-05T20:30:00Z");
    assert.equal(utcToLocal(at, "UTC").format("YYYY-MM-DD HH:mm:ss"), "2026-08-05 20:30:00");
    // Already tomorrow in Kolkata, still today in New York — the clearest single
    // case for why a UTC-rendered log page misleads.
    assert.equal(utcToLocal(at, "Asia/Kolkata").format("YYYY-MM-DD HH:mm:ss"), "2026-08-06 02:00:00");
    assert.equal(utcToLocal(at, "America/New_York").format("YYYY-MM-DD HH:mm:ss"), "2026-08-05 16:30:00");
  });

  it("takes a Date, an ISO string, or a millisecond count", () => {
    const want = "2026-08-05 20:30:00";
    const at = new Date("2026-08-05T20:30:00Z");
    for (const input of [at, at.toISOString(), at.getTime()]) {
      assert.equal(utcToLocal(input, "UTC").format("YYYY-MM-DD HH:mm:ss"), want);
    }
  });

  it("does not change the instant, only how it is read", () => {
    const at = new Date("2026-08-05T20:30:00Z");
    for (const zone of ["UTC", "Asia/Kolkata", "America/New_York", "Pacific/Auckland"]) {
      assert.equal(utcToLocal(at, zone).valueOf(), at.getTime(), `${zone} moved the instant`);
    }
  });

  it("returns null for nothing, rather than the epoch or Invalid Date", () => {
    for (const bad of [null, undefined, "", "nonsense"]) {
      assert.equal(utcToLocal(bad, "UTC"), null, `${JSON.stringify(bad)} should be null`);
    }
  });

  it("defaults to UTC", () => {
    const at = new Date("2026-08-05T20:30:00Z");
    assert.equal(
      utcToLocal(at).format("YYYY-MM-DD HH:mm:ss"),
      utcToLocal(at, DEFAULT_TIME_ZONE).format("YYYY-MM-DD HH:mm:ss"),
    );
  });
});

describe("localToUtc", () => {
  it("reads a bare date as midnight in the zone", () => {
    assert.equal(iso(localToUtc("2026-08-05", "UTC")), "2026-08-05T00:00:00.000Z");
    assert.equal(iso(localToUtc("2026-08-05", "Asia/Kolkata")), "2026-08-04T18:30:00.000Z");
    assert.equal(iso(localToUtc("2026-08-05", "America/New_York")), "2026-08-05T04:00:00.000Z");
  });

  it("reads a date-time in the zone", () => {
    assert.equal(iso(localToUtc("2026-08-05 23:59:59.999", "UTC")), "2026-08-05T23:59:59.999Z");
    assert.equal(iso(localToUtc("2026-08-05 23:59:59.999", "Asia/Kolkata")), "2026-08-05T18:29:59.999Z");
  });

  it("applies the offset in force on that date, not today's", () => {
    // New York is UTC-5 in January and UTC-4 in August. A fixed offset would get
    // one of these wrong by an hour.
    assert.equal(iso(localToUtc("2026-01-15", "America/New_York")), "2026-01-15T05:00:00.000Z");
    assert.equal(iso(localToUtc("2026-08-15", "America/New_York")), "2026-08-15T04:00:00.000Z");
  });

  it("refuses a date that isn't one instead of rolling it over", () => {
    // The failure that matters: loose parsing turns 2026-13-45 into a real day in
    // 2027 and syncs it without complaint.
    for (const bad of ["2026-13-45", "2026-02-30", "2026-00-10", "2026-2-3", "not-a-date", "", null, undefined]) {
      assert.equal(localToUtc(bad, "UTC"), null, `${JSON.stringify(bad)} should be null`);
    }
  });

  it("accepts a real leap day and refuses a fake one", () => {
    assert.equal(iso(localToUtc("2028-02-29", "UTC")), "2028-02-29T00:00:00.000Z");
    assert.equal(localToUtc("2026-02-29", "UTC"), null);
  });

  it("returns null for an unknown zone rather than throwing mid-run", () => {
    assert.equal(localToUtc("2026-08-05", "Not/AZone"), null);
  });

  it("defaults to UTC", () => {
    assert.equal(iso(localToUtc("2026-08-05")), "2026-08-05T00:00:00.000Z");
  });
});

describe("the two together", () => {
  it("round-trip a wall clock through an instant and back", () => {
    for (const zone of ["UTC", "Asia/Kolkata", "America/New_York", "Pacific/Auckland"]) {
      for (const wall of ["2026-08-05 14:30:00.000", "2026-01-01 00:00:00.000", "2026-12-31 23:59:59.999"]) {
        const instant = localToUtc(wall, zone);
        assert.ok(instant, `${wall} in ${zone} did not parse`);
        assert.equal(
          utcToLocal(instant, zone).format("YYYY-MM-DD HH:mm:ss.SSS"),
          wall,
          `${wall} in ${zone} did not survive the round trip`,
        );
      }
    }
  });

  it("round-trips across both DST boundaries", () => {
    const zone = "America/New_York";
    // 01:30 exists twice on the fall-back day and once on either side of it; the
    // instant it resolves to must still read back as 01:30 whichever it picked.
    for (const wall of ["2026-03-08 03:30:00.000", "2026-11-01 01:30:00.000", "2026-11-01 03:30:00.000"]) {
      const instant = localToUtc(wall, zone);
      assert.equal(utcToLocal(instant, zone).format("YYYY-MM-DD HH:mm:ss.SSS"), wall);
    }
  });
});

describe("toInstant", () => {
  it("reads a bare calendar date as UTC, not as the machine's local midnight", () => {
    // The whole reason this exists rather than a plain dayjs(value): dayjs would
    // use the server's zone here and shift a date-only bound by its offset.
    assert.equal(iso(toInstant("2026-08-05")), "2026-08-05T00:00:00.000Z");
  });

  it("honours an explicit time and offset", () => {
    assert.equal(iso(toInstant("2026-08-05T12:30:00Z")), "2026-08-05T12:30:00.000Z");
    assert.equal(iso(toInstant("2026-08-05T12:30:00+05:30")), "2026-08-05T07:00:00.000Z");
  });

  it("passes a Date and epoch milliseconds straight through", () => {
    const d = new Date("2026-08-05T12:30:00Z");
    assert.equal(toInstant(d), d);
    assert.equal(iso(toInstant(d.getTime())), "2026-08-05T12:30:00.000Z");
  });

  it("refuses a date that does not exist instead of rolling it over", () => {
    // dayjs's ordinary parsing turns these into 31 Aug and Jan 2027; a silently
    // wrong date range is worse than a refused one.
    assert.equal(toInstant("2026-08-32"), null);
    assert.equal(toInstant("2026-13-01"), null);
    assert.equal(toInstant("2026-02-30"), null);
  });

  it("returns null for nothing at all", () => {
    for (const bad of [null, undefined, "", "nonsense", new Date("x")]) {
      assert.equal(toInstant(bad), null, `${JSON.stringify(bad)} should be null`);
    }
  });
});
