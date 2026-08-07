/* eslint-env node */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { shipmentSummary } from "./fulfill.server.js";
import { syncTracking } from "./tracking.server.js";

const ORDER_ID = "gid://shopify/Order/1";

// A fake Shopify admin that answers by operation name and records every call,
// so a test can assert on what was NOT sent as easily as on what was — which is
// most of what matters here: the writes this sync skips are the point.
function fakeAdmin(handlers) {
  const calls = [];
  return {
    calls,
    graphql: async (query, options) => {
      const [, name] = query.match(/(?:query|mutation)\s+(\w+)/) || [];
      calls.push({ name, variables: options?.variables });
      const handler = handlers[name];
      assert.ok(handler, `unexpected ${name} call`);
      return { json: async () => handler(options?.variables, calls) };
    },
  };
}

function names(admin) {
  return admin.calls.map((c) => c.name);
}

function fulfillmentOrder(id, lines) {
  return {
    id,
    status: "OPEN",
    lineItems: {
      nodes: lines.map(([lineId, sku, remaining]) => ({
        id: lineId, remainingQuantity: remaining, lineItem: { id: `${lineId}-li`, sku, name: sku },
      })),
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}

function orderContext({ customAttributes = [], fulfillments = [], fulfillmentOrders = [] }) {
  return () => ({
    data: {
      order: {
        id: ORDER_ID,
        name: "#1001",
        customAttributes,
        fulfillments,
        fulfillmentOrders: { nodes: fulfillmentOrders, pageInfo: { hasNextPage: false, endCursor: null } },
      },
    },
  });
}

function fulfillmentCreated(id) {
  return (variables) => ({
    data: {
      fulfillmentCreate: {
        fulfillment: {
          id,
          trackingInfo: [variables.fulfillment.trackingInfo || {}].flat(),
        },
        userErrors: [],
      },
    },
  });
}

// SO 300777, shipped in two parts a few days apart — the shape this whole path
// exists for, and the one the sync used to get wrong on its second run.
const SHIP_1 = {
  netsuiteId: "305457", trackingNumbers: ["875373500692"], shipDate: "2026-08-01",
  shipMethod: "FedEx Ground®", carrier: null, items: [{ sku: "TSK4A", quantity: 3 }],
};
const SHIP_2 = {
  netsuiteId: "305460", trackingNumbers: ["875374098216"], shipDate: "2026-08-04",
  shipMethod: "FedEx Ground®", carrier: null, items: [{ sku: "721520LEC", quantity: 1 }],
};

function partlyShippedOrder() {
  return {
    externalId: "300777",
    reference: "SO300777",
    fulfillmentStatus: "FULFILLED",
    tracking: "875373500692, 875374098216",
    trackingFulfillments: 2,
    shipments: [SHIP_1, SHIP_2],
  };
}

describe("syncTracking on an order that shipped in parts", () => {
  it("fulfils the second shipment instead of piling its number onto the first", async () => {
    const entry = partlyShippedOrder();
    const admin = fakeAdmin({
      OrderTrackingContext: orderContext({
        // What the previous run left: shipment 1 fulfilled with its own number,
        // shipment 2's line still open.
        customAttributes: [{ key: "netsuite_shipments", value: shipmentSummary(entry) }],
        fulfillments: [{
          id: "gid://shopify/Fulfillment/1",
          status: "SUCCESS",
          trackingInfo: [{
            company: "FedEx Ground®",
            number: "875373500692",
            url: "https://www.fedex.com/fedextrack/?trknbr=875373500692",
          }],
        }],
        fulfillmentOrders: [fulfillmentOrder("gid://FO/1", [
          ["gid://FOLI/1", "TSK4A", 0],
          ["gid://FOLI/2", "721520LEC", 1],
        ])],
      }),
      FulfillmentCreate: fulfillmentCreated("gid://shopify/Fulfillment/2"),
    });

    const result = await syncTracking(admin, entry, ORDER_ID, "tag");

    assert.equal(result.ok, true);
    // The second shipment became its own fulfillment, carrying only its own line
    // and its own number.
    assert.deepEqual(names(admin), ["OrderTrackingContext", "FulfillmentCreate"]);
    const [, create] = admin.calls;
    assert.deepEqual(create.variables.fulfillment.lineItemsByFulfillmentOrder, [{
      fulfillmentOrderId: "gid://FO/1",
      fulfillmentOrderLineItems: [{ id: "gid://FOLI/2", quantity: 1 }],
    }]);
    assert.equal(create.variables.fulfillment.trackingInfo.number, "875374098216");
    // And the fulfillment that already existed was left alone: no
    // fulfillmentTrackingInfoUpdate spraying both numbers onto shipment 1.
    assert.equal(names(admin).includes("FulfillmentTrackingUpdate"), false);
  });

  it("still reconciles tracking onto a fulfillment that is missing it", async () => {
    // Same order, but the earlier run wrote shipment 1 without a link — the
    // account filled its tracking-URL template in afterwards.
    const entry = partlyShippedOrder();
    entry.shipments = [
      { ...SHIP_1, trackingUrlTemplate: "https://track.example.test/{number}" },
      { ...SHIP_2, trackingUrlTemplate: "https://track.example.test/{number}" },
    ];
    const admin = fakeAdmin({
      OrderTrackingContext: orderContext({
        customAttributes: [{ key: "netsuite_shipments", value: shipmentSummary(entry) }],
        fulfillments: [{
          id: "gid://shopify/Fulfillment/1",
          status: "SUCCESS",
          trackingInfo: [{ company: null, number: "875373500692", url: null }],
        }],
        fulfillmentOrders: [fulfillmentOrder("gid://FO/1", [
          ["gid://FOLI/1", "TSK4A", 0],
          ["gid://FOLI/2", "721520LEC", 1],
        ])],
      }),
      FulfillmentCreate: fulfillmentCreated("gid://shopify/Fulfillment/2"),
      FulfillmentTrackingUpdate: (variables) => ({
        data: {
          fulfillmentTrackingInfoUpdate: {
            fulfillment: { id: variables.fulfillmentId, trackingInfo: [variables.trackingInfoInput] },
            userErrors: [],
          },
        },
      }),
    });

    const result = await syncTracking(admin, entry, ORDER_ID, "tag");

    assert.equal(result.ok, true);
    const update = admin.calls.find((c) => c.name === "FulfillmentTrackingUpdate");
    assert.ok(update, "the fulfillment missing its link should be corrected");
    // Shipment 1's own number and link, not both numbers flattened together.
    assert.deepEqual(update.variables.trackingInfoInput, {
      company: "FedEx Ground®",
      number: "875373500692",
      url: "https://track.example.test/875373500692",
    });
    assert.equal(result.via, "fulfillmentCreate (one per NetSuite shipment) + fulfillmentTrackingInfoUpdate");
  });

  it("writes nothing at all once both shipments are in Shopify", async () => {
    const entry = partlyShippedOrder();
    const admin = fakeAdmin({
      OrderTrackingContext: orderContext({
        customAttributes: [{ key: "netsuite_shipments", value: shipmentSummary(entry) }],
        fulfillments: [
          { id: "gid://F/1", status: "SUCCESS", trackingInfo: [{ company: "FedEx Ground®", number: "875373500692", url: "https://www.fedex.com/fedextrack/?trknbr=875373500692" }] },
          { id: "gid://F/2", status: "SUCCESS", trackingInfo: [{ company: "FedEx Ground®", number: "875374098216", url: "https://www.fedex.com/fedextrack/?trknbr=875374098216" }] },
        ],
        fulfillmentOrders: [fulfillmentOrder("gid://FO/1", [
          ["gid://FOLI/1", "TSK4A", 0],
          ["gid://FOLI/2", "721520LEC", 0],
        ])],
      }),
    });

    const result = await syncTracking(admin, entry, ORDER_ID, "tag");

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "tracking already up to date");
    assert.deepEqual(names(admin), ["OrderTrackingContext"]);
  });

  it("flags tracking numbers NetSuite deleted but Shopify still carries", async () => {
    // The order shipped and stays fulfilled in Shopify, but every tracking
    // number was removed from NetSuite after an earlier run wrote them — a
    // merchant correction. Shopify still shows both; NetSuite now reports none.
    const entry = {
      externalId: "300777",
      reference: "SO300777",
      fulfillmentStatus: "FULFILLED",
      tracking: "",
      trackingFulfillments: 2,
      shipments: [],
    };
    const admin = fakeAdmin({
      OrderTrackingContext: orderContext({
        fulfillments: [
          { id: "gid://F/1", status: "SUCCESS", trackingInfo: [{ company: "FedEx Ground®", number: "875373500692", url: "https://www.fedex.com/fedextrack/?trknbr=875373500692" }] },
          { id: "gid://F/2", status: "SUCCESS", trackingInfo: [{ company: "FedEx Ground®", number: "875374098216", url: "https://www.fedex.com/fedextrack/?trknbr=875374098216" }] },
        ],
        fulfillmentOrders: [fulfillmentOrder("gid://FO/1", [
          ["gid://FOLI/1", "TSK4A", 0],
          ["gid://FOLI/2", "721520LEC", 0],
        ])],
      }),
    });

    const prev = process.env.SYNC_TRACKING_CLEAR;
    delete process.env.SYNC_TRACKING_CLEAR; // default: warn, do not clear
    let result;
    try {
      result = await syncTracking(admin, entry, ORDER_ID, "tag");
    } finally {
      if (prev === undefined) delete process.env.SYNC_TRACKING_CLEAR;
      else process.env.SYNC_TRACKING_CLEAR = prev;
    }

    assert.equal(result.ok, true);
    // The orphaned numbers are reported as a warning, not silently dropped or
    // auto-cleared from the customer's order.
    assert.ok(result.warning, "expected warning about orphaned tracking");
    assert.ok(result.warning.includes("875373500692"), "warning should name the orphaned numbers");
    assert.ok(result.warning.includes("875374098216"), "warning should name the orphaned numbers");
    assert.ok(result.warning.includes("NetSuite no longer reports"), "warning should explain the mismatch");
    // Nothing written: no fulfillmentTrackingInfoUpdate, no orderUpdate clearing
    // the numbers off the order.
    assert.deepEqual(names(admin), ["OrderTrackingContext"]);
  });

  it("clears orphaned tracking off Shopify when SYNC_TRACKING_CLEAR is on", async () => {
    // Same merchant correction, but the destructive opt-in is enabled: the
    // numbers NetSuite dropped are removed from Shopify to match.
    const entry = {
      externalId: "300777",
      reference: "SO300777",
      fulfillmentStatus: "FULFILLED",
      tracking: "875373500692", // shipment 1 kept, shipment 2's number deleted
      trackingFulfillments: 2,
      shipments: [SHIP_1],
    };
    const admin = fakeAdmin({
      OrderTrackingContext: orderContext({
        fulfillments: [
          { id: "gid://F/1", status: "SUCCESS", trackingInfo: [{ company: "FedEx Ground®", number: "875373500692", url: "https://www.fedex.com/fedextrack/?trknbr=875373500692" }] },
          { id: "gid://F/2", status: "SUCCESS", trackingInfo: [{ company: "FedEx Ground®", number: "875374098216", url: "https://www.fedex.com/fedextrack/?trknbr=875374098216" }] },
        ],
        fulfillmentOrders: [fulfillmentOrder("gid://FO/1", [
          ["gid://FOLI/1", "TSK4A", 0],
          ["gid://FOLI/2", "721520LEC", 0],
        ])],
      }),
      FulfillmentTrackingUpdate: (variables) => ({
        data: {
          fulfillmentTrackingInfoUpdate: {
            fulfillment: { id: variables.fulfillmentId, trackingInfo: [] },
            userErrors: [],
          },
        },
      }),
    });

    const prev = process.env.SYNC_TRACKING_CLEAR;
    process.env.SYNC_TRACKING_CLEAR = "true";
    let result;
    try {
      result = await syncTracking(admin, entry, ORDER_ID, "tag");
    } finally {
      if (prev === undefined) delete process.env.SYNC_TRACKING_CLEAR;
      else process.env.SYNC_TRACKING_CLEAR = prev;
    }

    assert.equal(result.ok, true);
    // Fulfillment 2 (875374098216) is the only orphan — NetSuite still reports
    // 875373500692, so fulfillment 1 is left alone.
    const clears = admin.calls.filter((c) => c.name === "FulfillmentTrackingUpdate");
    assert.equal(clears.length, 1, "only the orphaned fulfillment is cleared");
    assert.equal(clears[0].variables.fulfillmentId, "gid://F/2");
    // The stale number was removed, not the live one.
    assert.ok(result.note, "expected a note recording what was cleared");
    assert.ok(result.note.includes("875374098216"), "note should name the cleared number");
    assert.equal(result.warning, undefined, "no warning once the clear succeeds");
  });

  it("drops a deleted number from a fulfillment that also carries a live one, via the update path (no clear flag needed)", async () => {
    // The edge case: ONE fulfillment carries two numbers, and NetSuite deletes
    // only one of them. This is NOT the clear path — sameTracking sees the count
    // no longer matches and rewrites the fulfillment to exactly what NetSuite
    // reports, so the deleted number falls off without ever touching the live
    // one. It happens on every run, with or without SYNC_TRACKING_CLEAR.
    const entry = {
      externalId: "300777",
      reference: "SO300777",
      fulfillmentStatus: "FULFILLED",
      tracking: "875373500692", // 875374098216 was deleted in NetSuite
      trackingFulfillments: 1,
      shipments: [{
        netsuiteId: "305457", trackingNumbers: ["875373500692"], shipDate: "2026-08-01",
        shipMethod: "FedEx Ground®", carrier: null, items: [{ sku: "TSK4A", quantity: 3 }],
      }],
    };
    const admin = fakeAdmin({
      OrderTrackingContext: orderContext({
        fulfillments: [{
          id: "gid://F/1",
          status: "SUCCESS",
          trackingInfo: [
            { company: "FedEx Ground®", number: "875373500692", url: "https://www.fedex.com/fedextrack/?trknbr=875373500692" },
            { company: "FedEx Ground®", number: "875374098216", url: "https://www.fedex.com/fedextrack/?trknbr=875374098216" },
          ],
        }],
        fulfillmentOrders: [fulfillmentOrder("gid://FO/1", [["gid://FOLI/1", "TSK4A", 0]])],
      }),
      FulfillmentTrackingUpdate: (variables) => ({
        data: {
          fulfillmentTrackingInfoUpdate: {
            fulfillment: { id: variables.fulfillmentId, trackingInfo: [variables.trackingInfoInput].flat() },
            userErrors: [],
          },
        },
      }),
    });

    // Explicitly OFF: proves this does not depend on the clear flag.
    const prev = process.env.SYNC_TRACKING_CLEAR;
    delete process.env.SYNC_TRACKING_CLEAR;
    let result;
    try {
      result = await syncTracking(admin, entry, ORDER_ID, "tag");
    } finally {
      if (prev === undefined) delete process.env.SYNC_TRACKING_CLEAR;
      else process.env.SYNC_TRACKING_CLEAR = prev;
    }

    assert.equal(result.ok, true);
    const updates = admin.calls.filter((c) => c.name === "FulfillmentTrackingUpdate");
    assert.equal(updates.length, 1, "the fulfillment is rewritten once");
    // Rewritten to only the live number — the deleted one is not resent.
    assert.equal(updates[0].variables.trackingInfoInput.number, "875373500692");
    assert.equal(JSON.stringify(updates[0].variables.trackingInfoInput).includes("875374098216"), false,
      "the deleted number must not be written back");
    // No warning and no clear note: it went out on the ordinary update path.
    assert.equal(result.warning, undefined);
    assert.equal(result.note, undefined);
  });
});

describe("the netsuite_tracking fallback", () => {
  const entry = {
    externalId: "1234",
    fulfillmentStatus: "FULFILLED",
    tracking: "1Z999AA10123456784",
    trackingFulfillments: 1,
    shipments: [],
  };

  it("is not rewritten when the order already carries the same number", async () => {
    // The steady state for most of this account: nothing to fulfil, the number
    // recorded, and nothing changed since the last run. It used to cost an
    // orderUpdate per order per run anyway.
    const admin = fakeAdmin({
      OrderTrackingContext: orderContext({
        customAttributes: [{ key: "netsuite_tracking", value: "1Z999AA10123456784" }],
      }),
    });

    const result = await syncTracking(admin, entry, ORDER_ID, "tag");

    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.deepEqual(names(admin), ["OrderTrackingContext"]);
  });

  it("is written when the number changed", async () => {
    const admin = fakeAdmin({
      OrderTrackingContext: orderContext({
        customAttributes: [{ key: "netsuite_tracking", value: "1Z999AA10000000000" }],
      }),
      OrderUpdate: () => ({ data: { orderUpdate: { order: { id: ORDER_ID, name: "#1001" }, userErrors: [] } } }),
    });

    const result = await syncTracking(admin, entry, ORDER_ID, "tag");

    assert.equal(result.ok, true);
    assert.equal(result.skipped, undefined);
    assert.deepEqual(names(admin), ["OrderTrackingContext", "OrderUpdate"]);
    assert.deepEqual(admin.calls[1].variables.input.customAttributes, [
      { key: "netsuite_tracking", value: "1Z999AA10123456784" },
    ]);
    // The merged attribute set is working state, not something the sync log
    // needs a copy of on every order that takes this path.
    assert.equal(result.customAttributes, undefined);
  });
});

describe("a flat split across one fulfillment order", () => {
  it("keeps NetSuite's tracking link when every shipment names the same template", async () => {
    // Numbers that could not be tied to lines (NetSuite recorded no shipment
    // items), so they are split flat — which used to mean the account's own URL
    // template was dropped and the link fell back to guessing the carrier.
    const entry = {
      externalId: "77",
      fulfillmentStatus: "FULFILLED",
      tracking: "875373500692, 875374098216",
      trackingShipMethod: "FedEx Ground®",
      trackingFulfillments: 2,
      shipments: [
        { ...SHIP_1, items: [], trackingUrlTemplate: "https://track.example.test/{number}" },
        { ...SHIP_2, items: [], trackingUrlTemplate: "https://track.example.test/{number}" },
      ],
    };
    const admin = fakeAdmin({
      OrderTrackingContext: orderContext({
        customAttributes: [
          { key: "netsuite_shipped_via", value: "FedEx Ground®" },
          { key: "netsuite_shipments", value: shipmentSummary(entry) },
        ],
        fulfillmentOrders: [fulfillmentOrder("gid://FO/1", [["gid://FOLI/1", "TSK4A", 3]])],
      }),
      FulfillmentCreate: fulfillmentCreated("gid://shopify/Fulfillment/9"),
    });

    const result = await syncTracking(admin, entry, ORDER_ID, "tag");

    assert.equal(result.ok, true);
    const create = admin.calls.find((c) => c.name === "FulfillmentCreate");
    assert.deepEqual(create.variables.fulfillment.trackingInfo, {
      company: "FedEx Ground®",
      numbers: ["875373500692", "875374098216"],
      urls: [
        "https://track.example.test/875373500692",
        "https://track.example.test/875374098216",
      ],
    });
  });

  it("uses no template at all when the order's shipments disagree about it", async () => {
    // Two carriers on one order: hanging the first one's template off the
    // other's number would link to the wrong carrier's site, which is worse than
    // the carrier-guessed link below.
    const entry = {
      externalId: "78",
      fulfillmentStatus: "FULFILLED",
      tracking: "1Z999AA10123456784",
      trackingShipMethod: "UPS® Ground",
      trackingFulfillments: 2,
      shipments: [
        { ...SHIP_1, items: [], trackingUrlTemplate: "https://track.example.test/{number}" },
        { ...SHIP_2, items: [], trackingUrlTemplate: null },
      ],
    };
    const admin = fakeAdmin({
      OrderTrackingContext: orderContext({
        customAttributes: [
          { key: "netsuite_shipped_via", value: "UPS® Ground" },
          { key: "netsuite_shipments", value: shipmentSummary(entry) },
        ],
        fulfillmentOrders: [fulfillmentOrder("gid://FO/1", [["gid://FOLI/1", "TSK4A", 3]])],
      }),
      FulfillmentCreate: fulfillmentCreated("gid://shopify/Fulfillment/10"),
    });

    await syncTracking(admin, entry, ORDER_ID, "tag");

    const create = admin.calls.find((c) => c.name === "FulfillmentCreate");
    assert.deepEqual(create.variables.fulfillment.trackingInfo, {
      company: "UPS® Ground",
      number: "1Z999AA10123456784",
      url: "https://www.ups.com/track?loc=en_US&tracknum=1Z999AA10123456784",
    });
  });
});

describe("a part-shipped order with no shipment detail", () => {
  // NetSuite says half the order went and does not say which half. The flat
  // path fulfils EVERY open line, so running it here would close lines that are
  // still in the warehouse.
  const entry = {
    externalId: "555",
    fulfillmentStatus: "PARTIALLY_FULFILLED",
    tracking: "1Z999AA10123456784",
    trackingFulfillments: 1,
    shipments: [],
  };

  it("records the number instead of fulfilling lines that have not shipped", async () => {
    const admin = fakeAdmin({
      OrderTrackingContext: orderContext({
        fulfillmentOrders: [fulfillmentOrder("gid://FO/1", [
          ["gid://FOLI/1", "TSK4A", 3],
          ["gid://FOLI/2", "721520LEC", 1],
        ])],
      }),
      OrderUpdate: () => ({ data: { orderUpdate: { order: { id: ORDER_ID, name: "#1001" }, userErrors: [] } } }),
    });

    const result = await syncTracking(admin, entry, ORDER_ID, "tag");

    assert.equal(result.ok, true);
    assert.equal(result.via, "customAttribute");
    assert.equal(names(admin).includes("FulfillmentCreate"), false);
    assert.match(result.reason, /only part of the order shipped/);
  });

  it("still fulfils flat once NetSuite reports the whole order shipped", async () => {
    const admin = fakeAdmin({
      OrderTrackingContext: orderContext({
        fulfillmentOrders: [fulfillmentOrder("gid://FO/1", [["gid://FOLI/1", "TSK4A", 3]])],
      }),
      FulfillmentCreate: fulfillmentCreated("gid://shopify/Fulfillment/12"),
    });

    const result = await syncTracking(admin, { ...entry, fulfillmentStatus: "FULFILLED" }, ORDER_ID, "tag");

    assert.equal(result.via, "fulfillmentCreate");
    assert.deepEqual(admin.calls[1].variables.fulfillment.lineItemsByFulfillmentOrder, [{
      fulfillmentOrderId: "gid://FO/1",
      fulfillmentOrderLineItems: [{ id: "gid://FOLI/1", quantity: 3 }],
    }]);
  });
});

describe("fulfillment order paging", () => {
  it("follows the line items past the first page before matching them", async () => {
    // A line that did not come back is a line the pool never held, so the
    // shipment that carried it matched nothing and its number was dropped.
    // PARTIALLY_FULFILLED so the TSK4A line on the first page stays open: it has
    // genuinely not shipped, and the point here is only that the line on the
    // SECOND page was there to be matched.
    const entry = {
      externalId: "99",
      fulfillmentStatus: "PARTIALLY_FULFILLED",
      tracking: "875374098216",
      trackingFulfillments: 1,
      shipments: [SHIP_2],
    };
    const admin = fakeAdmin({
      OrderTrackingContext: () => ({
        data: {
          order: {
            id: ORDER_ID,
            name: "#1001",
            customAttributes: [{ key: "netsuite_shipments", value: shipmentSummary(entry) }],
            fulfillments: [],
            fulfillmentOrders: {
              nodes: [{
                id: "gid://FO/1",
                status: "OPEN",
                lineItems: {
                  nodes: [{ id: "gid://FOLI/1", remainingQuantity: 3, lineItem: { id: "li-1", sku: "TSK4A", name: "TSK4A" } }],
                  pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
                },
              }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
      FulfillmentOrderLines: () => ({
        data: {
          fulfillmentOrder: {
            lineItems: {
              nodes: [{ id: "gid://FOLI/2", remainingQuantity: 1, lineItem: { id: "li-2", sku: "721520LEC", name: "721520LEC" } }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
      FulfillmentCreate: fulfillmentCreated("gid://shopify/Fulfillment/11"),
    });

    const result = await syncTracking(admin, entry, ORDER_ID, "tag");

    assert.equal(result.ok, true);
    assert.deepEqual(names(admin), ["OrderTrackingContext", "FulfillmentOrderLines", "FulfillmentCreate"]);
    const create = admin.calls.find((c) => c.name === "FulfillmentCreate");
    // The shipment matched the line from the SECOND page.
    assert.deepEqual(create.variables.fulfillment.lineItemsByFulfillmentOrder[0].fulfillmentOrderLineItems, [
      { id: "gid://FOLI/2", quantity: 1 },
    ]);
  });
});
