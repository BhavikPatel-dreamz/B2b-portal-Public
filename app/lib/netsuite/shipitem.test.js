/* eslint-env node */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pickTrackingUrlTemplate } from "./shipitem.js";

describe("pickTrackingUrlTemplate", () => {
  // A NetSuite Shipping Item as SuiteQL returns it: the standard columns, plus
  // whatever custom fields the account created.
  const SHIP_ITEM = {
    links: [], id: "8993", itemid: "FedEx Ground®", displayname: "FedEx Ground®",
    servicecode: "24", costbasis: "fedexRealTimeRate", isinactive: "F",
  };

  it("finds the URL whatever the field is called", () => {
    // The field id is whatever the person who created it typed. Matching on the
    // name would mean the feature silently doing nothing on an account that
    // spelled it differently — so the {number} placeholder is what identifies it.
    for (const field of ["custitem_tracking_url", "custitem_track_link", "custitem2", "custitem_ns_courier_lookup"]) {
      assert.equal(
        pickTrackingUrlTemplate({ ...SHIP_ITEM, [field]: "https://www.fedex.com/fedextrack/?trknbr={number}" }),
        "https://www.fedex.com/fedextrack/?trknbr={number}",
      );
    }
  });

  it("takes a URL with no placeholder when the field name says tracking", () => {
    assert.equal(
      pickTrackingUrlTemplate({ ...SHIP_ITEM, custitem_tracking_url: "https://www.fedex.com/fedextrack/?trknbr=" }),
      "https://www.fedex.com/fedextrack/?trknbr=",
    );
  });

  it("leaves other URLs on the record alone", () => {
    // A shipping item can carry a carrier's home page or a rate card. Hanging
    // one of those off a customer's tracking number is worse than no link.
    assert.equal(pickTrackingUrlTemplate({ ...SHIP_ITEM, custitem_carrier_website: "https://www.fedex.com/" }), null);
    assert.equal(pickTrackingUrlTemplate({ ...SHIP_ITEM, custitem_rate_card: "https://example.com/rates.pdf" }), null);
  });

  it("prefers the placeholder template over a plain URL elsewhere", () => {
    assert.equal(
      pickTrackingUrlTemplate({
        ...SHIP_ITEM,
        custitem_carrier_url: "https://www.fedex.com/",
        custitem9: "https://www.fedex.com/fedextrack/?trknbr={number}",
      }),
      "https://www.fedex.com/fedextrack/?trknbr={number}",
    );
  });

  it("reads exactly the pinned column when one is configured", () => {
    const row = { ...SHIP_ITEM, custitem_a: "https://a.example/{number}", custitem_b: "https://b.example/{number}" };
    assert.equal(pickTrackingUrlTemplate(row, "custitem_b"), "https://b.example/{number}");
    assert.equal(pickTrackingUrlTemplate(row, "custitem_missing"), null);
  });

  it("is null on a record with nothing filled in, which is the normal state", () => {
    assert.equal(pickTrackingUrlTemplate(SHIP_ITEM), null);
    assert.equal(pickTrackingUrlTemplate({}), null);
    assert.equal(pickTrackingUrlTemplate(null), null);
  });
});
