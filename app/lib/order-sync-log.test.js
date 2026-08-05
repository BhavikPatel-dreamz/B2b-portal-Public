import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { consecutiveFailures, orderAttemptLimit } from "./order-sync-log.server.js";
import { DEFAULT_SYNC_WINDOW, SYNC_WINDOWS, windowLabel } from "./sync-windows.js";

// The quarantine rule: how many runs in a row an order has failed, which is what
// decides whether it still gets to hold the watermark back.

describe("consecutiveFailures", () => {
  it("counts a run of failures from the newest row", () => {
    assert.equal(consecutiveFailures(["failed", "failed", "failed"]), 3);
    assert.equal(consecutiveFailures(["failed"]), 1);
  });

  it("is zero when the newest row is not a failure", () => {
    assert.equal(consecutiveFailures([]), 0);
    assert.equal(consecutiveFailures(["success", "failed", "failed"]), 0);
    assert.equal(consecutiveFailures(["skipped", "failed"]), 0);
  });

  // An order that failed, was fixed, and broke again is not stuck — it broke
  // once. Counting every failure ever would quarantine it on its first new
  // problem and let the watermark walk past a real, current failure.
  it("stops at the first success rather than counting every failure ever", () => {
    assert.equal(consecutiveFailures(["failed", "failed", "success", "failed", "failed"]), 2);
  });

  // "skipped" is not a failure — a Celigo order with no match is skipped on
  // every single run by design, and treating that as a failing streak would
  // quarantine orders that are behaving exactly as intended.
  it("treats skipped as a break in the streak, not part of it", () => {
    assert.equal(consecutiveFailures(["failed", "skipped", "failed"]), 1);
  });
});

describe("orderAttemptLimit", () => {
  const saved = process.env.SYNC_MAX_ORDER_ATTEMPTS;
  afterEach(() => {
    if (saved === undefined) delete process.env.SYNC_MAX_ORDER_ATTEMPTS;
    else process.env.SYNC_MAX_ORDER_ATTEMPTS = saved;
  });

  it("defaults to 5", () => {
    delete process.env.SYNC_MAX_ORDER_ATTEMPTS;
    assert.equal(orderAttemptLimit(), 5);
  });

  it("takes a whole number from the environment", () => {
    process.env.SYNC_MAX_ORDER_ATTEMPTS = "3";
    assert.equal(orderAttemptLimit(), 3);
  });

  // 0 has to mean "never quarantine", not "quarantine immediately" — it is the
  // switch back to the old behaviour where every failure holds the watermark.
  it("keeps 0 as a real value, meaning quarantine is off", () => {
    process.env.SYNC_MAX_ORDER_ATTEMPTS = "0";
    assert.equal(orderAttemptLimit(), 0);
  });

  it("falls back to the default for nonsense", () => {
    for (const bad of ["", "abc", "-2", "2.5"]) {
      process.env.SYNC_MAX_ORDER_ATTEMPTS = bad;
      assert.equal(orderAttemptLimit(), 5, `expected fallback for ${JSON.stringify(bad)}`);
    }
  });
});

// The sync ranges are shared between the dropdown in the browser and the server
// that runs them, so what breaks here is the two disagreeing.
describe("SYNC_WINDOWS", () => {
  it("has unique form values", () => {
    const values = SYNC_WINDOWS.map((w) => w.value);
    assert.equal(new Set(values).size, values.length);
  });

  // Every entry is a real window, so nothing started from the page can advance
  // the watermark. The windowless "Current (since last sync)" entry used to sit
  // here and was the one exception; putting it back would quietly hand the page
  // the cron's job again.
  it("offers no windowless option", () => {
    assert.equal(SYNC_WINDOWS.find((w) => w.value === ""), undefined);
    assert.ok(SYNC_WINDOWS.every((w) => w.hours > 0), "every range must span real time");
  });

  it("states every value in hours, matching its own value", () => {
    for (const w of SYNC_WINDOWS) {
      assert.equal(w.hours, Number(w.value), `${w.label} disagrees with its value`);
    }
  });

  it("covers the ranges the page offers", () => {
    assert.deepEqual(SYNC_WINDOWS.map((w) => w.hours), [1, 2, 6, 12, 24, 48]);
  });

  // The dropdown starts here, and the Sync now route rejects any value not on
  // the list — so a default that drifted off it would break the button outright.
  it("has a default that is on the list", () => {
    assert.equal(DEFAULT_SYNC_WINDOW, "1");
    assert.ok(SYNC_WINDOWS.some((w) => w.value === DEFAULT_SYNC_WINDOW));
  });
});

describe("windowLabel", () => {
  it("names a known range the way the dropdown does", () => {
    assert.equal(windowLabel(2), "last 2 hours");
    assert.equal(windowLabel(24), "last day");
  });

  it("still says something usable for a range that is not on the list", () => {
    assert.equal(windowLabel(7), "last 7 hour(s)");
    // 0 is no longer on the list at all, so it falls through like any other
    // unknown range rather than naming a scheduled run.
    assert.equal(windowLabel(0), "last 0 hour(s)");
  });
});
