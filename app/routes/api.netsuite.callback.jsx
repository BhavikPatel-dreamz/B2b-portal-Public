import { redirect } from "react-router";
import {
  verifyState,
  exchangeCodeForTokens,
  saveTokens,
} from "../lib/netsuite-oauth.server.js";

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
  } catch (err) {
    // Authorization codes are single-use and short-lived — a stale/reused
    // code is expected to fail here rather than silently redirect.
    return text(`NetSuite connect failed: ${err?.message || err}`, 200);
  }
  // return text(`NetSuite connect succeeded: ${shop}`, 200);
  // Land the admin back inside the embedded app on its index page (app._index),
  // not on the bare /admin/apps list. The app handle is the subdomain of the app
  // URL, e.g. "smartb2b" for https://smartb2b.dynamicdreamz.com.
  const appHandle =
    process.env.SHOPIFY_APP_URL?.split("//")[1]?.split(".")[0] || "smartb2b";
  return redirect(`https://${shop}/admin/apps/${appHandle}`);
};

function text(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}
