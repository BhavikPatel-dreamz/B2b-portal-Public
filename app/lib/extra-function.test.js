import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extraFunction } from "./extra-function.server.js";

// The extra-function slot on the schedule now runs the Shopify -> app pull
// (companies + their contacts + those companies' orders) by delegating to
// syncShopifyToApp. What is worth holding down here is the part that stays true
// without a Shopify environment: the no-shop guard, and that importing the module
// never drags in the app config.

describe("extraFunction", () => {
  it("reports rather than throws when called without a shop", async () => {
    // It defaults to null so a script can call it with no shop in context. That
    // has to come back as a result the cron can report, not an exception — and it
    // must short-circuit BEFORE the lazy import of shopify-sync, so this holds
    // even with no Shopify environment set up.
    assert.deepEqual(await extraFunction(), { skipped: true, reason: "no shop given" });
    assert.deepEqual(await extraFunction(null), { skipped: true, reason: "no shop given" });
    assert.deepEqual(await extraFunction(""), { skipped: true, reason: "no shop given" });
  });

  // Importing this module must not require the Shopify app config — that is why
  // both adminFor() and extraFunction() import their Shopify dependencies lazily.
  // If either becomes a top-level import, the whole test suite stops running with
  // "Detected an empty appUrl".
  it("is importable with no environment set up", async () => {
    const mod = await import("./extra-function.server.js");
    assert.equal(typeof mod.extraFunction, "function");
    assert.equal(typeof mod.adminFor, "function");
  });
});
