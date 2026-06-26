import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
  DeliveryMethod,
  BillingInterval,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import type { Session } from "@shopify/shopify-api";
import { Prisma } from "@prisma/client";
import prisma from "./db.server";
import { PAID_PLAN, PLAN_99 } from "./billing-plans.shared";
import { upsertStore } from "./services/store.server";
import { sendAppWelcomeEmail } from "./utils/email";
import {
  registerCartValidationFunction,
  debugListAllShopifyFunctions,
  unregisterAllCartValidations,
} from "./services/cartValidationRegistration.server";
import { DEFAULT_CONFIG, serializeConfig } from "./utils/form-config.shared";

type AdminGraphQLClient = {
  graphql: (
    query: string,
    options?: {
      variables?: Record<string, unknown>;
    },
  ) => Promise<Response>;
};

class PrismaSessionStorageWithStore extends PrismaSessionStorage<
  typeof prisma
> {
  // Upsert store record whenever Shopify saves a session (install or token refresh)
  async storeSession(session: Session) {
    const saved = await super.storeSession(session);
    if (!saved) return saved;

    if (!session.accessToken) return saved;

    try {
      // For background session saves, we might not have a full 'admin' object easily available
      // but we can try to fetch the shop info if we have the accessToken.
      // However, to keep it simple and reliable, we mostly rely on afterAuth for the initial setup
      // and SHOP_UPDATE webhooks for ongoing changes.

      await upsertStore({
        shopDomain: session.shop,
        accessToken: session.accessToken,
        scope: session.scope,
      });
    } catch (error) {
      console.error("Failed to upsert store during session save", error);
    }

    return saved;
  }
}

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.January26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorageWithStore(prisma),
  distribution: AppDistribution.AppStore,
  billing: {
    [PAID_PLAN]: {
      lineItems: [
        {
          amount: 49,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
    [PLAN_99]: {
      lineItems: [
        {
          amount: 99,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
  },
  future: {
    expiringOfflineAccessTokens: true,
  },
  // Hook to run after app installation/authentication
  hooks: {
    afterAuth: async ({ admin, session }) => {
      console.log("🔧 Running post-installation setup...");

      let store;

      try {
        // Fetch shop details including currency and ID
        const response = await admin.graphql(
          `#graphql
          query {
            shop {
              id
              name
              currencyCode
              email
              contactEmail
            }
          }`,
        );
        const shopData = await response.json();
        const shop = shopData?.data?.shop;
        console.log(`🔍 Shop data for ${session.shop}:`, JSON.stringify(shop));

        const existingStore = await prisma.store.findUnique({
          where: { shopDomain: session.shop },
          select: { id: true, contactEmail: true },
        });

        const storeContactEmail = shop?.contactEmail || shop?.email;

        let storeOwnerName: string | null = null;
        try {
          const shopRes = await fetch(
            `https://${session.shop}/admin/api/2026-01/shop.json`,
            {
              headers: { "X-Shopify-Access-Token": session.accessToken ?? "" },
            },
          );
          const shopJson = await shopRes.json();
          storeOwnerName = shopJson?.shop?.shop_owner?.trim() || null;
        } catch (e) {
          console.warn("⚠️ Could not fetch shop_owner from REST API:", e);
        }

        store = await upsertStore({
          shopDomain: session.shop,
          accessToken: session.accessToken ?? "",
          scope: session.scope,
          shopName: shop?.name,
          currencyCode: shop?.currencyCode,
          contactEmail: storeContactEmail,
          storeOwnerName,
        });

        // Send welcome email if this is a new store or contact email was previously missing
        if (!existingStore || !existingStore.contactEmail) {
          console.log(
            `📧 Triggering welcome email to ${storeContactEmail} for ${session.shop}...`,
          );
          // Pass the email directly to avoid race conditions with uninstalls
          sendAppWelcomeEmail(store.id, storeContactEmail || undefined).catch(
            (err) => {
              console.error(
                `❌ Background welcome email failed for ${session.shop}:`,
                err,
              );
            },
          );
        }

        const defaultStoredConfig = serializeConfig(DEFAULT_CONFIG);

        await prisma.formFieldConfig.upsert({
          where: { shopId: store.id },
          update: {},
          create: {
            shopId: store.id,
            fields: defaultStoredConfig as unknown as Prisma.JsonArray,
          },
        });

        // Set validation state metafield
        const storeRecord = await prisma.store.findUnique({
          where: { shopDomain: session.shop },
          select: { plan: true },
        });
        const isPaidPlan = storeRecord?.plan === "approved payment";

        console.log(
          `🏷️ Setting validation state metafield for ${session.shop} (isPaid: ${isPaidPlan})`,
        );
        await admin.graphql(
          `
          mutation SetMetafield($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields {
                id
                key
                value
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
          {
            variables: {
              metafields: [
                {
                  namespace: "smartb2b",
                  key: "validation_enabled",
                  type: "single_line_text_field",
                  value: isPaidPlan ? "true" : "false",
                  ownerId: shop.id,
                },
                {
                  namespace: "smartb2b",
                  key: "block_orders_when_credit_unavailable",
                  type: "single_line_text_field",
                  value: "false",
                  ownerId: shop.id,
                },
              ],
            },
          },
        );

        console.log(`✅ Store bootstrap completed for ${session.shop}`);
      } catch (error) {
        console.error("❌ Error during store bootstrap:", error);
      }

      console.log(
        `ℹ️ Webhook registration is managed by shopify.app.toml for ${session.shop}`,
      );

      // First, debug what functions are available
      try {
        console.log("🔍 Running debug function listing...");
        const debugResult = await debugListAllShopifyFunctions(admin);
        if (debugResult.success) {
          console.log(
            `✅ Debug listing completed - found ${debugResult.totalFunctions} total functions`,
          );
        } else {
          console.warn(`⚠️ Debug listing failed: ${debugResult.error}`);
        }
      } catch (error) {
        console.error("❌ Error in debug function listing:", error);
      }

      // Register or unregister cart validation function based on plan
      try {
        const storeRecord = await prisma.store.findUnique({
          where: { shopDomain: session.shop },
          select: { plan: true },
        });

        if (storeRecord?.plan === "approved payment") {
          console.log(
            `🚀 Registering cart validation for paid store ${session.shop}...`,
          );
          const result = await registerCartValidationFunction(admin);
          console.log("Cart validation registration result:", result);
          if (result.success) {
            console.log(`✅ Post-install setup completed: ${result.message}`);
          } else {
            console.warn(
              `⚠️ Post-install setup warning: ${result.message || result.error}`,
            );
            if ("debug" in result && result.debug) {
              console.log(
                "🐛 Debug info:",
                JSON.stringify(result.debug, null, 2),
              );
            }
          }
        } else {
          console.log(
            `ℹ️ Ensuring cart validation is unregistered for ${storeRecord?.plan || "free"} store ${session.shop}...`,
          );
          await unregisterAllCartValidations(admin);
        }
      } catch (error) {
        console.error("❌ Error in post-install setup:", error);
      }
    },
  },
  // Register webhook endpoints
  webhooks: {
    ORDERS_CREATE: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/orders/create",
    },
    ORDERS_PAID: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/orders/paid",
    },
    ORDERS_CANCELLED: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/orders/cancelled",
    },
    ORDERS_UPDATED: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/orders/updated",
    },
    ORDERS_EDITED: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/orders/edited",
    },
    CUSTOMERS_CREATE: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/customers/create",
    },
    CUSTOMERS_DELETE: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/customers/delete",
    },
    SHOP_UPDATE: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/shop/update",
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;

function createAdminGraphQLClient(
  shop: string,
  accessToken: string,
): AdminGraphQLClient {
  return {
    graphql: async (
      query: string,
      options?: {
        variables?: Record<string, unknown>;
      },
    ) => {
      return fetch(
        `https://${shop}/admin/api/${ApiVersion.January26}/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({
            query,
            variables: options?.variables ?? {},
          }),
        },
      );
    },
  };
}

export async function getAdminForShop(
  shop: string,
): Promise<AdminGraphQLClient> {
  const store = await prisma.store.findUnique({
    where: { shopDomain: shop },
    select: { accessToken: true },
  });

  if (!store) {
    throw new Error(`Store not found for shop ${shop}`);
  }

  if (!store.accessToken) {
    throw new Error(`Store access token not available for shop ${shop}`);
  }

  return createAdminGraphQLClient(shop, store.accessToken);
}
