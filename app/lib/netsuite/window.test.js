import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  buildOrdersQuery,
  isDateLiteralRejected,
  nextOrderDateFormat,
  orderDateFormat,
  plannedOrdersWindow,
  rememberOrderDateFormat,
  scanOrders,
} from "./orders-query.server.js";
import { parseCustomRange } from "../sync/windows.js";

// The window scan: which of a day's listed orders a windowed run keeps, and when
// it stops looking. `expand` is the only thing that would touch NetSuite, so
// these pass their own and the decisions are all that is under test.

const refs = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i + 1) }));

// A record as NetSuite returns it, with only the field the scan reads.
const record = (id, modifiedAt) => ({ id: String(id), lastModifiedDate: modifiedAt });

const WINDOW = {
  from: new Date("2026-08-04T08:00:00Z"),
  to: new Date("2026-08-04T10:00:00Z"),
};

describe("scanOrders without a window", () => {
  it("keeps everything it expands", async () => {
    const scan = await scanOrders(refs(3), { expand: async (id) => record(id, null) });
    assert.equal(scan.items.length, 3);
    assert.equal(scan.outsideWindow, 0);
    assert.equal(scan.scanned, 3);
    assert.equal(scan.scanStoppedAt, null);
  });

  it("skips refs with no id", async () => {
    const scan = await scanOrders([{ id: "1" }, {}, { id: null }, { id: "2" }], {
      expand: async (id) => record(id, null),
    });
    assert.equal(scan.scanned, 2);
    assert.deepEqual(scan.items.map((r) => r.id), ["1", "2"]);
  });
});

describe("scanOrders with a window", () => {
  it("keeps only the records modified inside it", async () => {
    const times = {
      1: "2026-08-04T07:59:59Z", // just before
      2: "2026-08-04T08:00:00Z", // exactly the start — inclusive
      3: "2026-08-04T09:30:00Z", // inside
      4: "2026-08-04T10:00:00Z", // exactly the end — inclusive
      5: "2026-08-04T10:00:01Z", // just after
    };
    const scan = await scanOrders(refs(5), {
      window: WINDOW,
      expand: async (id) => record(id, times[id]),
    });
    assert.deepEqual(scan.items.map((r) => r.id), ["2", "3", "4"]);
    assert.equal(scan.outsideWindow, 2);
    assert.equal(scan.scanned, 5);
  });

  // The demo feed carries no dates. Judging a window by a field that isn't there
  // would make every demo-mode window sync silently do nothing.
  it("keeps a record that has no lastModifiedDate at all", async () => {
    const scan = await scanOrders(refs(2), {
      window: WINDOW,
      expand: async (id) => ({ id }),
    });
    assert.equal(scan.items.length, 2);
    assert.equal(scan.outsideWindow, 0);
  });

  it("keeps a record whose date is unparseable rather than dropping it", async () => {
    const scan = await scanOrders(refs(1), {
      window: WINDOW,
      expand: async (id) => record(id, "not a date"),
    });
    assert.equal(scan.items.length, 1);
  });

  // This is the bug the scan limit exists for. NetSuite can only be asked for
  // whole DAYS, so a 2-hour window lists the whole day and the orders that are
  // really in the window can sit anywhere in that list — here, at the very end.
  // Stopping at the first `keepLimit` LISTED orders would sync none of them.
  it("finds in-window orders that sit behind a wall of out-of-window ones", async () => {
    const scan = await scanOrders(refs(100), {
      window: WINDOW,
      keepLimit: 10,
      expand: async (id) =>
        record(id, Number(id) > 95 ? "2026-08-04T09:00:00Z" : "2026-08-04T02:00:00Z"),
    });
    assert.deepEqual(scan.items.map((r) => r.id), ["96", "97", "98", "99", "100"]);
    assert.equal(scan.outsideWindow, 95);
    assert.equal(scan.scanned, 100);
    // It ran out of ids rather than out of limit, so nothing was left unexamined.
    assert.equal(scan.scanStoppedAt, null);
  });

  it("stops scanning once keepLimit records are inside the window", async () => {
    let expands = 0;
    const scan = await scanOrders(refs(100), {
      window: WINDOW,
      keepLimit: 5,
      expand: async (id) => {
        expands += 1;
        return record(id, "2026-08-04T09:00:00Z");
      },
    });
    assert.equal(scan.items.length, 5);
    // The whole point: it must NOT have paid for the other 95.
    assert.equal(expands, 5);
    assert.equal(scan.scanned, 5);
    // …and it has to say it stopped early, so the caller parks the watermark.
    assert.equal(scan.scanStoppedAt, 5);
  });

  it("reports scanStoppedAt below the list length only when ids were left over", async () => {
    const exactly = await scanOrders(refs(5), {
      window: WINDOW,
      keepLimit: 5,
      expand: async (id) => record(id, "2026-08-04T09:00:00Z"),
    });
    // Five ids, five kept, none left behind — the caller must not report a cap.
    assert.equal(exactly.scanStoppedAt, null);
  });
});

describe("scanOrders when an expand fails", () => {
  it("collects the error and keeps going", async () => {
    const scan = await scanOrders(refs(4), {
      expand: async (id) => {
        if (id === "2") throw new Error("404 not found");
        return record(id, null);
      },
    });
    assert.deepEqual(scan.items.map((r) => r.id), ["1", "3", "4"]);
    assert.deepEqual(scan.errors, [{ id: "2", error: "404 not found" }]);
    assert.equal(scan.scanned, 4);
  });

  it("does not let a failed expand count towards the keep limit", async () => {
    const scan = await scanOrders(refs(10), {
      window: WINDOW,
      keepLimit: 2,
      expand: async (id) => {
        if (Number(id) <= 3) throw new Error("boom");
        return record(id, "2026-08-04T09:00:00Z");
      },
    });
    assert.equal(scan.items.length, 2);
    assert.equal(scan.errors.length, 3);
  });
});

describe("plannedOrdersWindow", () => {
  const ENV = ["NETSUITE_INITIAL_SYNC_DAYS", "NETSUITE_BEFORE_LAST_SYNC_HOURS", "NETSUITE_ORDERS_QUERY"];
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const at = new Date("2026-08-04T06:00:00Z");

  it("runs from the watermark less the overlap buffer", () => {
    process.env.NETSUITE_BEFORE_LAST_SYNC_HOURS = "1";
    delete process.env.NETSUITE_ORDERS_QUERY;
    const w = plannedOrdersWindow(new Date("2026-08-04T03:00:00Z"), at);
    assert.equal(w.from.toISOString(), "2026-08-04T02:00:00.000Z");
    assert.equal(w.to.toISOString(), "2026-08-04T06:00:00.000Z");
    assert.equal(w.override, false);
  });

  it("falls back to the initial lookback when there is no watermark", () => {
    process.env.NETSUITE_INITIAL_SYNC_DAYS = "2";
    delete process.env.NETSUITE_ORDERS_QUERY;
    const w = plannedOrdersWindow(null, at);
    assert.equal(w.from.toISOString(), "2026-08-02T06:00:00.000Z");
  });

  // The filter carries a time of day now, so it names the watermark and "now"
  // exactly rather than the whole days they fall in.
  it("emits a datetime query naming both ends exactly", () => {
    delete process.env.NETSUITE_ORDERS_QUERY;
    process.env.NETSUITE_BEFORE_LAST_SYNC_HOURS = "0";
    const w = plannedOrdersWindow(new Date("2026-08-04T03:00:00Z"), at);
    assert.equal(
      w.query,
      'lastModifiedDate ON_OR_AFTER "8/4/2026 03:00" AND lastModifiedDate ON_OR_BEFORE "8/4/2026 06:00"',
    );
  });

  // The bug the day-granular version had: a run beginning and ending inside one
  // day emitted ON_OR_AFTER "8/4" AND ON_OR_BEFORE "8/4", which NetSuite answers
  // with nothing. With a time on each end the two are distinct by construction —
  // asserted as the rule rather than as one string, because it is the rule that
  // matters.
  it("never names the same instant on both ends", () => {
    delete process.env.NETSUITE_ORDERS_QUERY;
    process.env.NETSUITE_BEFORE_LAST_SYNC_HOURS = "0";
    for (const sinceIso of ["2026-08-04T00:30:00Z", "2026-08-04T03:00:00Z", "2026-08-04T05:59:00Z"]) {
      const [, after, before] = plannedOrdersWindow(new Date(sinceIso), at).query.match(
        /ON_OR_AFTER "([^"]+)".*ON_OR_BEFORE "([^"]+)"/,
      );
      assert.notEqual(after, before, `same-instant watermark ${sinceIso} matches nothing`);
    }
  });

  it("reports the override when NETSUITE_ORDERS_QUERY replaces the window", () => {
    process.env.NETSUITE_ORDERS_QUERY = "custbody_thing IS true";
    const w = plannedOrdersWindow(new Date("2026-08-04T03:00:00Z"), at);
    assert.equal(w.override, true);
    assert.equal(w.query, "custbody_thing IS true");
  });
});

// A windowed run — the log page's range dropdown — is the case that broke in
// production: "last 1 hour" is always inside one UTC day.
describe("buildOrdersQuery for an explicit window", () => {
  const window = (fromIso, toIso) => ({ from: new Date(fromIso), to: new Date(toIso) });

  // The filter carries a time of day, so a one-hour window is asked for as that
  // hour — not as the whole day (or three) it falls in, which is what the
  // day-granular version had to do.
  it("names the window's own two instants", () => {
    assert.equal(
      buildOrdersQuery(null, window("2026-08-05T03:39:00Z", "2026-08-05T04:39:00Z")),
      'lastModifiedDate ON_OR_AFTER "8/5/2026 03:39" AND lastModifiedDate ON_OR_BEFORE "8/5/2026 04:39"',
    );
  });

  it("reads those instants in the configured zone", () => {
    assert.equal(
      buildOrdersQuery(null, window("2026-08-05T03:39:00Z", "2026-08-05T04:39:00Z"), "America/New_York"),
      'lastModifiedDate ON_OR_AFTER "8/4/2026 23:39" AND lastModifiedDate ON_OR_BEFORE "8/5/2026 00:39"',
    );
  });

  it("still covers a window that spans days", () => {
    assert.equal(
      buildOrdersQuery(null, window("2026-08-03T04:00:00Z", "2026-08-05T04:00:00Z")),
      'lastModifiedDate ON_OR_AFTER "8/3/2026 04:00" AND lastModifiedDate ON_OR_BEFORE "8/5/2026 04:00"',
    );
  });

  // The literal has no seconds, so each end is snapped to a whole minute — the
  // lower down and the upper UP, so the emitted range is always a superset of the
  // real one. Snapping the top down would shave off up to 59 seconds, and an
  // order modified in that sliver would never be returned at all.
  it("rounds the upper bound outward so no instant is excluded", () => {
    const q = buildOrdersQuery(null, window("2026-08-05T03:39:12Z", "2026-08-05T04:39:12Z"));
    assert.match(q, /ON_OR_AFTER "8\/5\/2026 03:39"/, "lower bound floors");
    assert.match(q, /ON_OR_BEFORE "8\/5\/2026 04:40"/, "upper bound ceils");
  });

  it("covers the last instant of a whole-day custom range", () => {
    // 23:59:59.999 must not become 23:59 — that would drop the final second.
    const q = buildOrdersQuery(null, window("2026-08-01T00:00:00.000Z", "2026-08-05T23:59:59.999Z"));
    assert.equal(
      q,
      'lastModifiedDate ON_OR_AFTER "8/1/2026 00:00" AND lastModifiedDate ON_OR_BEFORE "8/6/2026 00:00"',
    );
  });
});

// The account decides how a date literal may be spelled, and it says so by
// refusing the query. This is the walk from the narrowest spelling to the one it
// will actually parse — the failure that started it was:
//
//   Parse of date/time "8/5/2026 23:53" failed with date format "M/d/yy"
describe("the date literal spelling", () => {
  afterEach(() => {
    rememberOrderDateFormat(null);
    delete process.env.NETSUITE_QUERY_DATE_FORMAT;
  });

  const window = { from: new Date("2026-08-05T03:39:00Z"), to: new Date("2026-08-05T04:39:00Z") };

  it("recognises NetSuite refusing the spelling, and nothing else", () => {
    assert.equal(
      isDateLiteralRejected(new Error('NetSuite GET /salesorder failed: 400 {"o:errorDetails":[{"detail":"Invalid search query. Search error occurred: Parse of date/time \\"8/5/2026 23:53\\" failed with date format \\"M/d/yy\\" in time zone America/Los_Angeles"}]}')),
      true,
    );
    // A different 400 must not send the run round the fallback loop.
    assert.equal(
      isDateLiteralRejected(new Error('NetSuite GET /salesorder failed: 400 {"detail":"Unknown field name \'createdFrom\' in the search query."}')),
      false,
    );
    assert.equal(isDateLiteralRejected(new Error("NetSuite GET /salesorder failed: TimeoutError")), false);
  });

  it("walks from the narrowest spelling to the one every account takes", () => {
    assert.equal(orderDateFormat(), "datetime");
    assert.equal(nextOrderDateFormat("datetime"), "datetime12");
    assert.equal(nextOrderDateFormat("datetime12"), "date");
    // Nothing left to try: the failure is then really NetSuite's answer.
    assert.equal(nextOrderDateFormat("date"), null);
  });

  it("writes the time on a 12-hour clock when that is what the account reads", () => {
    assert.equal(
      buildOrdersQuery(null, window, "UTC", "datetime12"),
      'lastModifiedDate ON_OR_AFTER "8/5/2026 3:39 am" AND lastModifiedDate ON_OR_BEFORE "8/5/2026 4:39 am"',
    );
  });

  // Midnight and noon are 12 on a 12-hour clock, never 0 — "0:30 am" is as
  // unparseable to such an account as "23:53" is.
  it("writes midnight and noon as 12", () => {
    const q = buildOrdersQuery(
      null,
      { from: new Date("2026-08-05T00:30:00Z"), to: new Date("2026-08-05T12:30:00Z") },
      "UTC",
      "datetime12",
    );
    assert.equal(
      q,
      'lastModifiedDate ON_OR_AFTER "8/5/2026 12:30 am" AND lastModifiedDate ON_OR_BEFORE "8/5/2026 12:30 pm"',
    );
  });

  // The last resort, and the shape this account was measured on: whole days, with
  // a day of slack at each end so the filter stays a superset of the window that
  // inWindow then trims back. Without the upper day the named day's own records
  // are excluded — NetSuite reads a bare date as that date at midnight.
  it("falls back to whole days, widened at both ends", () => {
    assert.equal(
      buildOrdersQuery(null, window, "UTC", "date"),
      'lastModifiedDate ON_OR_AFTER "8/4/2026" AND lastModifiedDate ON_OR_BEFORE "8/6/2026"',
    );
  });

  // The watermark path has no inWindow to reclaim a surplus, so it takes the
  // upper day it needs to match anything at all and no lower margin beyond it.
  it("takes no lower margin on the watermark path", () => {
    delete process.env.NETSUITE_ORDERS_QUERY;
    process.env.NETSUITE_BEFORE_LAST_SYNC_HOURS = "0";
    const w = plannedOrdersWindow(new Date("2026-08-04T03:00:00Z"), new Date("2026-08-04T06:00:00Z"), "UTC", "date");
    assert.equal(
      w.query,
      'lastModifiedDate ON_OR_AFTER "8/4/2026" AND lastModifiedDate ON_OR_BEFORE "8/5/2026"',
    );
    delete process.env.NETSUITE_BEFORE_LAST_SYNC_HOURS;
  });

  it("remembers a spelling for the rest of the process, and NETSUITE_QUERY_DATE_FORMAT pins one", () => {
    process.env.NETSUITE_QUERY_DATE_FORMAT = "date";
    assert.equal(orderDateFormat(), "date");
    assert.match(buildOrdersQuery(null, window), /ON_OR_AFTER "8\/4\/2026" AND/);

    // A probe that has settled on something outranks the env default.
    assert.equal(rememberOrderDateFormat("datetime12"), true);
    assert.equal(orderDateFormat(), "datetime12");

    // A name that is not a spelling is refused rather than silently adopted.
    assert.equal(rememberOrderDateFormat("iso8601"), false);
    assert.equal(orderDateFormat(), "datetime12");
  });

  it("ignores an unusable NETSUITE_QUERY_DATE_FORMAT", () => {
    process.env.NETSUITE_QUERY_DATE_FORMAT = "M/d/yy";
    assert.equal(orderDateFormat(), "datetime");
  });
});

describe("buildOrdersQuery for a custom from/to range", () => {
  it("spans both ends of the range the operator typed", () => {
    const { from, to } = parseCustomRange("2026-08-01", "2026-08-05");
    assert.equal(
      buildOrdersQuery(null, { from, to }),
      'lastModifiedDate ON_OR_AFTER "8/1/2026 00:00" AND lastModifiedDate ON_OR_BEFORE "8/6/2026 00:00"',
    );
  });

  it("keeps a same-day range as a real span rather than a point", () => {
    const { from, to } = parseCustomRange("2026-08-05", "2026-08-05");
    assert.equal(
      buildOrdersQuery(null, { from, to }),
      'lastModifiedDate ON_OR_AFTER "8/5/2026 00:00" AND lastModifiedDate ON_OR_BEFORE "8/6/2026 00:00"',
    );
  });
});
