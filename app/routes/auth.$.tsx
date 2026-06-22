
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { upsertStore } from "../services/store.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // Ensure the store record exists/updates on install or re-auth
  await upsertStore({
    shopDomain: session.shop,
    accessToken: session.accessToken,
    scope: session.scope,
  });

  return null;
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
