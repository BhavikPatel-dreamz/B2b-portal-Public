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
import {
  PAID_PLAN,
  USAGE_PLAN,
} from "./billing-plans.shared";
import { upsertStore } from "./services/store.server";
import { registerCartValidationFunction, debugListAllShopifyFunctions } from "./services/cartValidationRegistration.server";
import {
  DEFAULT_CONFIG,
  serializeConfig,
} from "./utils/form-config.shared";

class PrismaSessionStorageWithStore extends PrismaSessionStorage<typeof prisma> {
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
    [USAGE_PLAN]: {
      lineItems: [
        {
          amount: 5,
          currencyCode: "USD",
          interval: BillingInterval.Usage,
          terms: "Usage based",
      
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
        // Fetch shop details including currency
        const response = await admin.graphql(
          `#graphql
          query {
            shop {
              name
              currencyCode
            }
          }`
        );
        const shopData = await response.json();
        const shop = shopData?.data?.shop;

        store = await upsertStore({
          shopDomain: session.shop,
          accessToken: session.accessToken ?? "",
          scope: session.scope,
          shopName: shop?.name,
          currencyCode: shop?.currencyCode,
        });

      
        const defaultStoredConfig = serializeConfig(DEFAULT_CONFIG);

        await prisma.formFieldConfig.upsert({
          where: { shopId: store.id },
          update: {},
          create: {
            shopId: store.id,
            fields: defaultStoredConfig as unknown as Prisma.JsonArray,
          },
        });

        console.log(`✅ Store bootstrap completed for ${session.shop}`);
      } catch (error) {
        console.error("❌ Error during store bootstrap:", error);
      }

      // Register webhooks
      try {
        await shopify.registerWebhooks({ session });
        console.log(`✅ Webhooks registered for ${session.shop}`);
      } catch (error) {
        console.error(`❌ Failed to register webhooks for ${session.shop}:`, error);
      }

      // First, debug what functions are available
      try {
        console.log("🔍 Running debug function listing...");
        const debugResult = await debugListAllShopifyFunctions(admin);
        if (debugResult.success) {
          console.log(`✅ Debug listing completed - found ${debugResult.totalFunctions} total functions`);
        } else {
          console.warn(`⚠️ Debug listing failed: ${debugResult.error}`);
        }
      } catch (error) {
        console.error("❌ Error in debug function listing:", error);
      }

      // Register cart validation function
      try {
        const result = await registerCartValidationFunction(admin);
        if (result.success) {
          console.log(`✅ Post-install setup completed: ${result.message}`);
        } else {
          console.warn(`⚠️ Post-install setup warning: ${result.message || result.error}`);
          if (result.debug) {
            console.log("🐛 Debug info:", JSON.stringify(result.debug, null, 2));
          }
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
