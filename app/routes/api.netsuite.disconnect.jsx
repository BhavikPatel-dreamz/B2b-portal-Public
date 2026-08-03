import { authenticate } from "../shopify.server";
import { disconnectTokens } from "../lib/netsuite-oauth.server.js";
import { clearSettingsCache } from "./app.settings";
import { clearAppLayoutCache } from "./app";

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  await disconnectTokens(session.shop);
  clearSettingsCache(session.shop);
  clearAppLayoutCache(session.shop);
  return { ok: true };
};
