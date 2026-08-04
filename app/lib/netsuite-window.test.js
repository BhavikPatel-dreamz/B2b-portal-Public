import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { plannedOrdersWindow, scanOrders } from "./netsuite.server.js";

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

  // The card shows this next to from/to precisely because it is WIDER than
  // from/to — NetSuite's q filter has no time of day. If this ever stops being
  // day-granular the card's explanation stops being true.
  it("emits a day-granular query, which is why it is shown", () => {
    delete process.env.NETSUITE_ORDERS_QUERY;
    process.env.NETSUITE_BEFORE_LAST_SYNC_HOURS = "0";
    const w = plannedOrdersWindow(new Date("2026-08-04T03:00:00Z"), at);
    assert.equal(
      w.query,
      'lastModifiedDate ON_OR_AFTER "8/4/2026" AND lastModifiedDate ON_OR_BEFORE "8/4/2026"',
    );
  });

  it("reports the override when NETSUITE_ORDERS_QUERY replaces the window", () => {
    process.env.NETSUITE_ORDERS_QUERY = "custbody_thing IS true";
    const w = plannedOrdersWindow(new Date("2026-08-04T03:00:00Z"), at);
    assert.equal(w.override, true);
    assert.equal(w.query, "custbody_thing IS true");
  });
});
