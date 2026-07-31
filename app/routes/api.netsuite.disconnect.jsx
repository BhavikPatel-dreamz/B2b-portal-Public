import { authenticate } from "../shopify.server";
import { disconnectTokens } from "../lib/netsuite-oauth.server.js";

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  await disconnectTokens(session.shop);
  return { ok: true };
};
