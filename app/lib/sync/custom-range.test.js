import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CUSTOM_SYNC_WINDOW,
  MAX_CUSTOM_RANGE_DAYS,
  SYNC_WINDOWS,
  parseCustomRange,
  rangeLabel,
} from "./windows.js";

// The custom from/to range offered by the log page's Sync now control. Everything
// here is pure, so it runs without a NetSuite account or a database — which is the
// point: parseCustomRange is the single gate both the page's preview and the
// /api/orders-sync-now route pass through, so what it accepts is exactly what can
// reach a NetSuite query.
//
// What such a range turns INTO — the day-granular q filter — is asserted in
// netsuite-window.test.js instead, next to the rest of the query tests.

describe("parseCustomRange", () => {
  it("reads two dates as whole UTC days", () => {
    const { from, to, error } = parseCustomRange("2026-08-01", "2026-08-05");
    assert.equal(error, undefined);
    assert.equal(from.toISOString(), "2026-08-01T00:00:00.000Z");
    // The last instant of the to-day, not its first — without this a same-day
    // range would be zero-length and match nothing.
    assert.equal(to.toISOString(), "2026-08-05T23:59:59.999Z");
  });

  it("accepts a single day", () => {
    const { from, to, error } = parseCustomRange("2026-08-05", "2026-08-05");
    assert.equal(error, undefined);
    assert.ok(to > from, "a one-day range must still span real time");
    assert.equal(to.getTime() - from.getTime(), 24 * 60 * 60 * 1000 - 1);
  });

  it("refuses a half-typed range rather than treating it as open-ended", () => {
    // Open-ended would mean reading the account's whole history, which is the one
    // outcome a mistyped field must never produce.
    assert.match(parseCustomRange("2026-08-01", "").error, /both a From and a To/);
    assert.match(parseCustomRange("", "2026-08-05").error, /both a From and a To/);
    assert.match(parseCustomRange("", "").error, /both a From and a To/);
  });

  it("refuses a backwards range", () => {
    assert.match(parseCustomRange("2026-08-05", "2026-08-01").error, /on or before/);
  });

  it("refuses an unparseable date", () => {
    assert.ok(parseCustomRange("not-a-date", "2026-08-05").error);
    assert.ok(parseCustomRange("2026-13-45", "2026-08-05").error);
  });

  it("caps how wide one range may be", () => {
    // A range is scanned candidate by candidate, each costing a round trip and a
    // second of rate-limit sleep, so an unbounded one would be accepted and then
    // silently truncated by the scan limit — worse than being refused by name.
    const ok = parseCustomRange("2026-07-06", "2026-08-05");
    assert.equal(ok.error, undefined, `${MAX_CUSTOM_RANGE_DAYS} days must be allowed`);
    const tooWide = parseCustomRange("2026-01-01", "2026-08-05");
    assert.match(tooWide.error, /at most 31 days/);
  });
});

describe("a custom range is read in the sync's timezone", () => {
  it("means whole days in that zone, not UTC days", () => {
    const { from, to, error } = parseCustomRange("2026-08-01", "2026-08-05", "Asia/Kolkata");
    assert.equal(error, undefined);
    // Both ends shifted by the +05:30 offset — this is the whole point: a store
    // in Kolkata asking for "1 Aug" means their 1 Aug, which began the previous
    // evening UTC.
    assert.equal(from.toISOString(), "2026-07-31T18:30:00.000Z");
    assert.equal(to.toISOString(), "2026-08-05T18:29:59.999Z");
  });

  it("still counts a DST-spanning range in whole days", () => {
    // 8 Mar is 23 hours long in New York, so an unrounded day count would come
    // out at 30.96 and a 31-day range would be refused for being 31 days.
    const { error } = parseCustomRange("2026-03-01", "2026-03-31", "America/New_York");
    assert.equal(error, undefined, "a 31-day range spanning a spring-forward must be allowed");
  });

  it("names itself in that zone, so the label matches what was typed", () => {
    const { from, to } = parseCustomRange("2026-08-01", "2026-08-05", "Asia/Kolkata");
    // The instants are UTC and start the previous evening, so a UTC-rendered
    // label would read "2026-07-31 → 2026-08-05" and disagree with the fields.
    assert.equal(rangeLabel(from, to, "Asia/Kolkata"), "2026-08-01 → 2026-08-05 (custom range)");
  });

  it("defaults to UTC, so an unconfigured install is unchanged", () => {
    const withDefault = parseCustomRange("2026-08-01", "2026-08-05");
    const explicitUtc = parseCustomRange("2026-08-01", "2026-08-05", "UTC");
    assert.equal(withDefault.from.getTime(), explicitUtc.from.getTime());
    assert.equal(withDefault.to.getTime(), explicitUtc.to.getTime());
  });
});

describe("the custom option sits alongside the presets", () => {
  it("does not collide with any preset value", () => {
    assert.equal(SYNC_WINDOWS.find((w) => w.value === CUSTOM_SYNC_WINDOW), undefined);
  });

  it("names itself so a log row says which range produced it", () => {
    const { from, to } = parseCustomRange("2026-08-01", "2026-08-05");
    assert.equal(rangeLabel(from, to), "2026-08-01 → 2026-08-05 (custom range)");
  });
});
