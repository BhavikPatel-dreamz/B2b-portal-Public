import { authenticate } from "../shopify.server";
import { buildAuthorizeUrl } from "../lib/netsuite-oauth.server.js";

// Called from inside the embedded app via an authenticated fetch. Returns the
// NetSuite authorize URL so the client can open it with target "_top" — a
// plain top-level GET straight into an authenticate.admin-guarded loader
// would instead re-trigger Shopify's own embedded-auth bounce.
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  return { url: buildAuthorizeUrl(session.shop) };
};
