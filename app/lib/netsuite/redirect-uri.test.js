import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { buildAuthorizeUrl, redirectUri } from "./oauth.server.js";

// The redirect URI is the one OAuth parameter NetSuite checks silently: a
// mismatch is only ever reported as "your login attempt was not successful", on
// NetSuite's own login page, with no way back to the app. So the rules it has to
// follow are worth pinning down here rather than rediscovering them from a
// login screen.

const ENV_KEYS = [
  "NETSUITE_REDIRECT_URI",
  "SHOPIFY_APP_URL",
  "NETSUITE_ACCOUNT_ID",
  "NETSUITE_CONSUMER_KEY",
  "SHOPIFY_API_SECRET",
];

const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("redirectUri", () => {
  it("uses NETSUITE_REDIRECT_URI exactly as registered", () => {
    process.env.NETSUITE_REDIRECT_URI = "https://app.example.com/api/netsuite/callback";
    process.env.SHOPIFY_APP_URL = "https://some-tunnel.trycloudflare.com";
    assert.equal(redirectUri(), "https://app.example.com/api/netsuite/callback");
  });

  // NetSuite compares the raw string, so a trailing slash is a different URI —
  // whichever form is registered there has to survive this function untouched.
  it("does not normalise the registered value", () => {
    process.env.NETSUITE_REDIRECT_URI = "https://app.example.com/api/netsuite/callback/";
    assert.equal(redirectUri(), "https://app.example.com/api/netsuite/callback/");
  });

  it("falls back to SHOPIFY_APP_URL, without doubling its slash", () => {
    delete process.env.NETSUITE_REDIRECT_URI;
    process.env.SHOPIFY_APP_URL = "https://app.example.com/";
    assert.equal(redirectUri(), "https://app.example.com/api/netsuite/callback");
  });

  // Both are blank under `shopify app dev` until the CLI supplies a tunnel, and
  // the resulting "/api/netsuite/callback" would be sent to NetSuite as-is.
  it("refuses to build a callback out of nothing", () => {
    delete process.env.NETSUITE_REDIRECT_URI;
    process.env.SHOPIFY_APP_URL = "";
    assert.throws(() => redirectUri(), /NETSUITE_REDIRECT_URI/);
  });

  it("rejects http and localhost, which NetSuite will not accept", () => {
    process.env.NETSUITE_REDIRECT_URI = "http://localhost:3000/api/netsuite/callback";
    assert.throws(() => redirectUri(), /https/);
  });
});

describe("buildAuthorizeUrl", () => {
  it("writes a sandbox account id the way its hostname spells it", () => {
    process.env.NETSUITE_ACCOUNT_ID = "5895946_SB1";
    process.env.NETSUITE_CONSUMER_KEY = "consumer-key";
    process.env.SHOPIFY_API_SECRET = "shopify-secret";
    process.env.NETSUITE_REDIRECT_URI = "https://app.example.com/api/netsuite/callback";

    const url = new URL(buildAuthorizeUrl("shop.myshopify.com"));
    assert.equal(url.host, "5895946-sb1.app.netsuite.com");
    assert.equal(url.searchParams.get("redirect_uri"), "https://app.example.com/api/netsuite/callback");
    assert.equal(url.searchParams.get("scope"), "restlets rest_webservices");
    // NetSuite requires at least 24 characters of state and fails the login,
    // not the authorization, when it gets fewer.
    assert.ok(url.searchParams.get("state").length >= 24);
  });
});
