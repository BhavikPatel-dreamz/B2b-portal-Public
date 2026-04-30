import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { clearAdminCompaniesCache } from "./app.companies";
import { clearDashboardStatsCache } from "./app.home";

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { shop, payload, topic } = await authenticate.webhook(request);

    console.log(`Received ${topic} webhook for ${shop}`);
    console.log("Webhook payload:", JSON.stringify(payload, null, 2));

    // Support both library-standardized topic and raw topic
    if (topic === "SHOP_UPDATE" || topic === "shop/update") {
      // payload usually contains 'currency' in REST webhooks, 
      // but 'currencyCode' in GraphQL-style ones.
      const currency = payload.currency || payload.currency_code || payload.currencyCode;
      const name = payload.name;
      
      console.log(`Extracted name: ${name}, currency: ${currency}`);

      if (!currency) {
        console.warn("⚠️ No currency found in SHOP_UPDATE payload. Available keys:", Object.keys(payload));
      }

      try {
        await prisma.store.update({
          where: { shopDomain: shop },
          data: {
            shopName: name || undefined,
            currencyCode: currency || undefined,
            updatedAt: new Date(),
          },
        });
        
        // Clear caches to reflect changes immediately
        clearAdminCompaniesCache(shop);
        clearDashboardStatsCache(shop);

        console.log(`✅ Successfully updated store ${shop} with currency ${currency} and cleared caches`);
      } catch (error) {
        console.error(`❌ Failed to update store ${shop} in database:`, error);
      }
    } else {
      console.warn(`⚠️ Unexpected topic ${topic} hit shop/update route`);
    }

    return new Response(null, { status: 200 });
  } catch (error) {
    console.error("❌ Error processing SHOP_UPDATE webhook:", error);
    return new Response("Unauthorized", { status: 401 });
  }
};
