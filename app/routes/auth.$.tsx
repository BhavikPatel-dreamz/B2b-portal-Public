import { redirect } from "react-router";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate, registerWebhooks } from "../shopify.server";
import { upsertStore } from "../services/store.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // Ensure the store record exists/updates on install or re-auth
  await upsertStore({
    shopDomain: session.shop,
    accessToken: session.accessToken,
    scope: session.scope,
  });

  // Ensure webhooks are registered for this shop
  try {
    await registerWebhooks({ session });
  } catch (err) {
    console.error("Failed to register webhooks", err);
  }

  const storeName = session.shop.split(".")[0];
  return redirect(
    `https://admin.shopify.com/store/${storeName}/apps/b2b-portal-public-3/app/home`
  );
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
