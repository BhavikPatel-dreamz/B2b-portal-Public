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

  // NetSuite reports a rejected authorization here rather than on the token
  // exchange — but only for problems it finds after the user is authenticated.
  // A wrong redirect_uri never reaches this route at all: NetSuite has nowhere
  // to send the failure, so it stays on its own login page saying the login
  // attempt was not successful. See redirectUri in netsuite-oauth.server.js.
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    const detail = url.searchParams.get("error_description") || "";
    return text(`NetSuite connect failed: ${oauthError} ${detail}`.trim(), 400);
  }

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
  return redirect(`https://${shop}/admin/apps/${process.env.SHOPIFY_APP_HANDLE}`);
};

function text(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}
