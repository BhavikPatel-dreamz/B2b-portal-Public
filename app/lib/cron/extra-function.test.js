import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extraFunction } from "./extra-function.server.js";

// The open slot on the schedule. There is nothing in it yet, so what is worth
// holding down is the contract around it — the part that stops being obvious
// once someone writes work into the middle of it.

describe("extraFunction", () => {
  it("reports rather than throws when called without a shop", async () => {
    // It defaults to null so a script can call it with no shop in context. That
    // has to come back as a result the cron can report, not an exception.
    assert.deepEqual(await extraFunction(), { skipped: true, reason: "no shop given" });
    assert.deepEqual(await extraFunction(null), { skipped: true, reason: "no shop given" });
  });

  it("says it is empty instead of reporting a silent success", async () => {
    const result = await extraFunction("vijay-checkout.myshopify.com");
    assert.equal(result.skipped, true);
    // The message names the file to write in, so the cron's own response answers
    // "why did this job do nothing".
    assert.match(result.reason, /app\/lib\/extra-function\.server\.js/);
  });

  it("always resolves to an object the job runner can report", async () => {
    for (const shop of [undefined, null, "", "shop.myshopify.com"]) {
      const result = await extraFunction(shop);
      assert.equal(typeof result, "object");
      assert.notEqual(result, null);
    }
  });

  // Importing this module must not require the Shopify app config — that is why
  // adminFor() imports it lazily. If that ever becomes a top-level import, the
  // whole test suite stops running with "Detected an empty appUrl".
  it("is importable with no environment set up", async () => {
    const mod = await import("./extra-function.server.js");
    assert.equal(typeof mod.extraFunction, "function");
    assert.equal(typeof mod.adminFor, "function");
  });
});
