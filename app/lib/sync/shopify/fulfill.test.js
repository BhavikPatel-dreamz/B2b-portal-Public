/* eslint-env node */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { carrierName, trackingInfoFor, trackingUrlFor } from "./carriers.js";
import { planShipmentFulfillments, shipmentSummary } from "./fulfill.server.js";

// SO 300777 as NetSuite really returned it: four item fulfillments, each with
// its own tracking number and its own items. This is the shape the whole
// item-wise path exists to reproduce in Shopify.
const SHIPMENTS = [
  { netsuiteId: "305457", trackingNumbers: ["875373500692"], shipDate: "2026-08-05", shipMethod: "FedEx Ground®", carrier: "FedEx/USPS/More", items: [{ sku: "TSK4A", quantity: 3 }] },
  { netsuiteId: "305460", trackingNumbers: ["875374098216"], shipDate: "2026-08-05", shipMethod: "FedEx Ground®", carrier: "FedEx/USPS/More", items: [{ sku: "721520LEC", quantity: 1 }] },
];

function fulfillmentOrder(id, lines) {
  return {
    id,
    status: "OPEN",
    lineItems: {
      nodes: lines.map(([lineId, sku, remaining]) => ({
        id: lineId, remainingQuantity: remaining, lineItem: { id: `${lineId}-li`, sku, name: sku },
      })),
    },
  };
}

const ORDER = [fulfillmentOrder("gid://FO/1", [
  ["gid://FOLI/1", "TSK4A", 3],
  ["gid://FOLI/2", "721520LEC", 1],
  ["gid://FOLI/3", "8123BQCXS", 1],
])];

describe("carrierName", () => {
  it("shows what NetSuite recorded, verbatim", () => {
    // The company is NetSuite's own service text, service level and all — not
    // normalised down to "FedEx", which would throw away the difference between
    // this and a FedEx 2Day shipment.
    assert.equal(carrierName("FedEx Ground®", "FedEx/USPS/More"), "FedEx Ground®");
    assert.equal(carrierName("UPS® Ground Customer Account", "UPS"), "UPS® Ground Customer Account");
  });

  it("falls back to the carrier field when the shipping record names no service", () => {
    assert.equal(carrierName(null, "UPS"), "UPS");
  });

  it("is null when NetSuite recorded no carrier, rather than inferring one", () => {
    // Real on this account: 20921 of 25978 item fulfillments name no carrier at
    // all. They are the untracked ones — where a tracking number exists, so does
    // the carrier (1452 of 1452). The carrier could be guessed from the number's
    // shape ("1Z…" is UPS and nothing else); deliberately not done, so the order
    // shows what a record says or shows nothing.
    assert.equal(carrierName(null, null), null);
    assert.equal(carrierName("  ", ""), null);
  });

  it("falls back to the carrier's own tracking page when NetSuite holds no URL", () => {
    // NetSuite has no tracking URL to give, and this account has not filled a
    // template in either — the number still has to be clickable, so the carrier
    // is recognised from the service NetSuite recorded. The company stays
    // NetSuite's text; only the link is worked out here.
    assert.deepEqual(trackingInfoFor(["875373500692"], SHIPMENTS[0]), {
      company: "FedEx Ground®",
      number: "875373500692",
      url: "https://www.fedex.com/fedextrack/?trknbr=875373500692",
    });
    const many = trackingInfoFor(["875373500692", "875374098216"], SHIPMENTS[0]);
    assert.deepEqual(many.urls, [
      "https://www.fedex.com/fedextrack/?trknbr=875373500692",
      "https://www.fedex.com/fedextrack/?trknbr=875374098216",
    ]);
  });

  it("leaves a service it cannot place without a link, rather than guessing one", () => {
    const pickup = { shipMethod: "Customer Pickup", carrier: null };
    assert.deepEqual(trackingInfoFor(["ABC123"], pickup), { company: "Customer Pickup", number: "ABC123" });
  });

  it("prefers the template NetSuite holds over the carrier's public page", () => {
    const shipment = { ...SHIPMENTS[0], trackingUrlTemplate: "https://track.example/{number}" };
    assert.equal(trackingInfoFor(["875373500692"], shipment).url, "https://track.example/875373500692");
  });

  it("links every number off the template NetSuite holds for that method", () => {
    const shipment = { ...SHIPMENTS[0], trackingUrlTemplate: "https://www.fedex.com/fedextrack/?trknbr={number}" };
    assert.deepEqual(trackingInfoFor(["875373500692"], shipment), {
      company: "FedEx Ground®",
      number: "875373500692",
      url: "https://www.fedex.com/fedextrack/?trknbr=875373500692",
    });
    // Parallel arrays: Shopify pairs urls to numbers by position, so each number
    // gets its own link rather than all of them sharing the first one's.
    const many = trackingInfoFor(["875373500692", "875374098216"], shipment);
    assert.deepEqual(many.urls, [
      "https://www.fedex.com/fedextrack/?trknbr=875373500692",
      "https://www.fedex.com/fedextrack/?trknbr=875374098216",
    ]);
  });

  it("sends nothing to track when a fulfillment only corrects the order's state", () => {
    assert.equal(trackingInfoFor([], {}), null);
  });
});

describe("trackingUrlFor", () => {
  it("puts the number where the template says", () => {
    assert.equal(
      trackingUrlFor("https://www.ups.com/track?tracknum={number}&loc=en_US", "1Z52761X0125787267"),
      "https://www.ups.com/track?tracknum=1Z52761X0125787267&loc=en_US",
    );
  });

  it("appends the number to a template filled in as a bare prefix", () => {
    // The obvious way to fill the field in. Failing on it would leave a field
    // that looks right on the NetSuite record and links nowhere on the order.
    assert.equal(
      trackingUrlFor("https://www.fedex.com/fedextrack/?trknbr=", "875373500692"),
      "https://www.fedex.com/fedextrack/?trknbr=875373500692",
    );
  });

  it("escapes the number rather than pasting it into the URL raw", () => {
    assert.equal(trackingUrlFor("https://track.example/{number}", "AB 12&x=1"), "https://track.example/AB%2012%26x%3D1");
  });

  it("ignores a template that is not a URL rather than building a link to nowhere", () => {
    assert.equal(trackingUrlFor("ask the warehouse", "123"), null);
    assert.equal(trackingUrlFor("javascript:alert(1)", "123"), null);
    assert.equal(trackingUrlFor("", "123"), null);
    assert.equal(trackingUrlFor(null, "123"), null);
  });

  it("recognises the carrier from NetSuite's service text when there is no template", () => {
    assert.equal(
      trackingUrlFor(null, "1Z52761X0125787267", "UPS® Ground Customer Account UPS"),
      "https://www.ups.com/track?loc=en_US&tracknum=1Z52761X0125787267",
    );
    assert.equal(
      trackingUrlFor(null, "875373500692", "FedEx Ground® FedEx/USPS/More"),
      "https://www.fedex.com/fedextrack/?trknbr=875373500692",
    );
  });

  it("falls back to the number's own shape when nothing names a carrier", () => {
    // 5 of this account's 1452 tracked fulfillments record no service at all.
    assert.match(trackingUrlFor(null, "1Z52761X0125787267", null), /ups\.com/);
    assert.match(trackingUrlFor(null, "875373500692", null), /fedex\.com/);
    assert.equal(trackingUrlFor(null, "SOMETHINGELSE", null), null);
  });
});

describe("planShipmentFulfillments", () => {
  it("gives each NetSuite shipment its own fulfillment, lines and tracking", () => {
    const { plans, unplaced } = planShipmentFulfillments(SHIPMENTS, ORDER);
    assert.equal(plans.length, 2);
    assert.equal(unplaced.length, 0);

    const [first, second] = plans;
    assert.deepEqual(first.lineItemsByFulfillmentOrder, [{
      fulfillmentOrderId: "gid://FO/1",
      fulfillmentOrderLineItems: [{ id: "gid://FOLI/1", quantity: 3 }],
    }]);
    assert.deepEqual(first.trackingInfo, {
      company: "FedEx Ground®",
      number: "875373500692",
      url: "https://www.fedex.com/fedextrack/?trknbr=875373500692",
    });
    assert.equal(second.trackingInfo.number, "875374098216");
    assert.deepEqual(second.lineItemsByFulfillmentOrder[0].fulfillmentOrderLineItems, [{ id: "gid://FOLI/2", quantity: 1 }]);
  });

  it("never hands the same unit to two shipments", () => {
    // Two shipments of the same item: the second takes what the first left, not
    // the same three units over again. Shopify would reject the second write,
    // and the order would end up with one shipment's tracking instead of both.
    const twice = [
      { netsuiteId: "1", trackingNumbers: ["A"], items: [{ sku: "TSK4A", quantity: 2 }] },
      { netsuiteId: "2", trackingNumbers: ["B"], items: [{ sku: "TSK4A", quantity: 2 }] },
    ];
    const { plans } = planShipmentFulfillments(twice, ORDER);
    assert.deepEqual(plans.map((p) => p.lineItemsByFulfillmentOrder[0].fulfillmentOrderLineItems[0].quantity), [2, 1]);
    assert.equal(plans[1].partial, "TSK4A x1");
  });

  it("reports a shipment whose items are not open here instead of losing its numbers", () => {
    const gone = [{ netsuiteId: "9", trackingNumbers: ["Z"], items: [{ sku: "NOT-IN-SHOPIFY", quantity: 1 }] }];
    const { plans, unplaced } = planShipmentFulfillments(gone, ORDER);
    assert.equal(plans.length, 0);
    assert.equal(unplaced[0].shipment.netsuiteId, "9");
  });

  it("fulfils what NetSuite shipped under a name Shopify doesn't carry, but only when the order is fully shipped", () => {
    // 8123BQCXS is on the Shopify order and on no NetSuite shipment. On a
    // FULFILLED order it still has to end up fulfilled — without tracking,
    // because none of the shipments claimed it.
    const whole = planShipmentFulfillments(SHIPMENTS, ORDER, { fulfillRemainder: true });
    assert.equal(whole.remainder.length, 1);
    assert.deepEqual(whole.remainder[0].lineItemsByFulfillmentOrder[0].fulfillmentOrderLineItems, [{ id: "gid://FOLI/3", quantity: 1 }]);
    assert.equal(whole.remainder[0].trackingInfo, null);

    // On a partially shipped order those lines genuinely have not shipped, and
    // fulfilling them would tell the customer they had.
    assert.equal(planShipmentFulfillments(SHIPMENTS, ORDER).remainder.length, 0);
  });

  it("ignores fulfillment orders that are closed or already fulfilled", () => {
    const closed = [{ ...fulfillmentOrder("gid://FO/2", [["gid://FOLI/9", "TSK4A", 3]]), status: "CLOSED" }];
    const { plans, unplaced } = planShipmentFulfillments(SHIPMENTS, closed);
    assert.equal(plans.length, 0);
    assert.equal(unplaced.length, 2);
  });
});

describe("shipmentSummary", () => {
  it("states each shipment on the order itself, capped so orderCreate can't be lost to it", () => {
    const summary = shipmentSummary({ shipments: SHIPMENTS });
    assert.equal(
      summary,
      "875373500692 · FedEx Ground® · 2026-08-05 · TSK4A x3 | 875374098216 · FedEx Ground® · 2026-08-05 · 721520LEC x1",
    );

    // 22 shipments is a real order on this account. The value stays inside the
    // cap and drops whole lines, never half a tracking number.
    const many = Array.from({ length: 22 }, (_, i) => ({
      ...SHIPMENTS[0], netsuiteId: String(i), trackingNumbers: [`87537350069${i}`],
    }));
    const capped = shipmentSummary({ shipments: many });
    assert.ok(capped.length <= 250, `summary was ${capped.length} characters`);
    assert.match(capped, / \| \+\d+ more shipment\(s\)$/);
  });

  it("says a shipment carried no number rather than leaving it out", () => {
    // The common case on this account: 24524 of 25978 fulfillments ship with no
    // tracking number recorded at all.
    assert.match(
      shipmentSummary({ shipments: [{ shipDate: "2026-07-29", items: [{ sku: "21311", quantity: 1 }] }] }),
      /^no tracking number · 2026-07-29 · 21311 x1$/,
    );
  });

  it("is nothing at all when NetSuite reported no shipment", () => {
    assert.equal(shipmentSummary({ shipments: [] }), null);
    assert.equal(shipmentSummary({}), null);
  });
});
