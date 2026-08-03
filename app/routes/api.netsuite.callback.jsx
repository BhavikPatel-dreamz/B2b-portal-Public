import { redirect } from "react-router";
import {
  verifyState,
  exchangeCodeForTokens,
  saveTokens,
} from "../lib/netsuite-oauth.server.js";
import { clearSettingsCache } from "./app.settings";
import { clearAppLayoutCache } from "./app";

// NetSuite's redirect back is a bare top-level browser navigation with no
// Shopify session token, so this route (unlike the embedded app routes)
// authenticates via the signed `state` param instead of authenticate.admin.
export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const shop = state && verifyState(state);
  if (!code || !shop) {
    return text("NetSuite connect failed: missing or invalid state/code.", 400);
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    await saveTokens(shop, tokens);
    clearSettingsCache(shop);
    clearAppLayoutCache(shop);
  } catch (err) {
    // Authorization codes are single-use and short-lived — a stale/reused
    // code is expected to fail here rather than silently redirect.
    return text(`NetSuite connect failed: ${err?.message || err}`, 200);
  }

  const appHandle = process.env.SHOPIFY_APP_HANDLE || "b2b-portal-public-dev";
  return redirect(`https://${shop}/admin/apps/${appHandle}/app`);
};

function text(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}
