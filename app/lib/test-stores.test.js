import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTestStore, testStores } from "./test-stores.server.js";

// Who sees the schedule card's technical half. Getting this wrong in the "too
// generous" direction shows every merchant the app's crontab line and NetSuite
// query, so the closed-by-default cases are the ones that matter most here.

const SHOP = "vijay-checkout.myshopify.com";

describe("isTestStore — closed by default", () => {
  // An allowlist that defaults to "everyone" is not an allowlist. The day
  // someone forgets to set the variable, it must show nothing rather than
  // everything, and it must fail that way silently-safe rather than silently-open.
  it("shows nobody when the variable is unset or empty", () => {
    for (const raw of [undefined, null, "", "   ", ",", ",,  ,"]) {
      assert.equal(isTestStore(SHOP, raw), false, `expected closed for ${JSON.stringify(raw)}`);
    }
  });

  it("shows nobody when the shop is not on the list", () => {
    assert.equal(isTestStore("real-store.myshopify.com", SHOP), false);
    assert.equal(isTestStore(SHOP, "someone-else.myshopify.com"), false);
  });

  it("does not match a shop that merely contains a listed name", () => {
    // Substring matching here would open the card on any store whose name
    // happens to embed a dev store's.
    assert.equal(isTestStore("not-vijay-checkout.myshopify.com", SHOP), false);
    assert.equal(isTestStore("vijay-checkout-staging.myshopify.com", SHOP), false);
  });

  it("shows nobody for a missing shop, whatever the list says", () => {
    for (const shop of [undefined, null, "", "  "]) {
      assert.equal(isTestStore(shop, SHOP), false);
    }
  });
});

describe("isTestStore — matching", () => {
  it("matches the exact shop domain", () => {
    assert.equal(isTestStore(SHOP, SHOP), true);
  });

  it("matches one entry out of a comma-separated list", () => {
    const list = "a.myshopify.com,vijay-checkout.myshopify.com,b.myshopify.com";
    assert.equal(isTestStore(SHOP, list), true);
    assert.equal(isTestStore("b.myshopify.com", list), true);
    assert.equal(isTestStore("c.myshopify.com", list), false);
  });

  it("ignores spacing and case, which is how the value gets typed", () => {
    assert.equal(isTestStore(SHOP, "  VIJAY-CHECKOUT.MyShopify.com  "), true);
    assert.equal(isTestStore(SHOP, "a.myshopify.com ,  vijay-checkout.myshopify.com "), true);
    assert.equal(isTestStore("VIJAY-CHECKOUT.myshopify.com", SHOP), true);
  });

  // "The shop name" is what people actually type. Accepting the bare handle
  // avoids the failure where the list looks right and silently matches nothing.
  it("accepts the bare handle as well as the full domain", () => {
    assert.equal(isTestStore(SHOP, "vijay-checkout"), true);
    assert.equal(isTestStore("vijay-checkout", SHOP), true);
    assert.equal(isTestStore("vijay-checkout", "vijay-checkout"), true);
  });

  // Deliberate, and has to be typed on purpose — a dev machine that wants the
  // card everywhere.
  it("treats * as everyone", () => {
    assert.equal(isTestStore(SHOP, "*"), true);
    assert.equal(isTestStore("anything.myshopify.com", "a.myshopify.com,*"), true);
  });
});

describe("testStores", () => {
  it("parses to a clean lower-cased list", () => {
    assert.deepEqual(testStores(" A.myshopify.com , b.myshopify.com ,, "), [
      "a.myshopify.com",
      "b.myshopify.com",
    ]);
  });

  it("is empty for nothing worth listing", () => {
    assert.deepEqual(testStores(undefined), []);
    assert.deepEqual(testStores("  ,  "), []);
  });
});
