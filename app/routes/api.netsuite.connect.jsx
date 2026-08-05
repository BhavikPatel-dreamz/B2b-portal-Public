import { authenticate } from "../shopify.server";
import { buildAuthorizeUrl, redirectUri } from "../lib/netsuite-oauth.server.js";

// Called from inside the embedded app via an authenticated fetch. Returns the
// NetSuite authorize URL so the client can open it with target "_top" — a
// plain top-level GET straight into an authenticate.admin-guarded loader
// would instead re-trigger Shopify's own embedded-auth bounce.
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  try {
    return { url: buildAuthorizeUrl(session.shop), redirectUri: redirectUri() };
  } catch (err) {
    // A misconfigured redirect URI or missing credential would otherwise throw
    // into a blank 500 and the Connect button would just sit there — and the
    // NetSuite end of the same mistake is equally mute (see redirectUri).
    return { error: err?.message || String(err) };
  }
};
