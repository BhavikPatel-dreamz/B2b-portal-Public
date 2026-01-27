import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { restoreCredit } from "../services/tieredCreditService";
import { getUserById } from "../services/user.server";
import { getOrderByShopifyIdWithDetails } from "../services/order.server";

interface ShopifyDraftOrder {
  id: string;
  name: string;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, session, payload } = await authenticate.webhook(request);
  console.log(`📝 Draft Order Deleted webhook received for shop: ${shop}`);

  try {
    const draftOrder = payload as ShopifyDraftOrder;
    console.log(`Draft Order Deletion Details:`, {
      id: draftOrder.id,
      name: draftOrder.name,
    });

    // Find the store first to get shopId
    const store = await db.store.findUnique({
      where: { shopDomain: shop },
      select: { id: true },
    });

    if (!store) {
      console.log("❌ Store not found - skipping B2B processing");
      return new Response("OK", { status: 200 });
    }

    // Find existing B2B order record using order service
    const existingOrder = await getOrderByShopifyIdWithDetails(store.id, draftOrder.id.toString());

    if (!existingOrder || existingOrder.orderStatus !== "draft") {
      console.log("❌ No existing B2B draft order found - skipping");
      return new Response("OK", { status: 200 });
    }

    console.log(`✅ Found existing B2B draft order: ${existingOrder.shopifyOrderId}`);
    console.log(`💰 Releasing reserved credit: ${existingOrder.creditUsed}`);

    // Get user details using user service
    const user = await getUserById(existingOrder.createdByUserId, store.id);
    if (!user) {
      console.log("❌ User not found or doesn't belong to this shop - continuing with order deletion");
    }

    // Release any reserved credit
    if (existingOrder.creditUsed && Number(existingOrder.creditUsed) > 0) {
      try {
        const refundResult = await restoreCredit(
          existingOrder.companyId,
          existingOrder.shopifyOrderId || "",
          parseFloat(existingOrder.creditUsed.toString()),
          existingOrder.createdByUserId,
          "cancelled"
        );

        console.log(`💳 Credit refunded:`, refundResult);
      } catch (creditError: unknown) {
        console.error(`❌ Credit refund failed:`, (creditError as Error).message);
        // Continue with deletion even if credit refund fails
      }
    }

    // Mark the B2B order as cancelled/deleted
    const deletedOrder = await db.b2BOrder.update({
      where: {
        id: existingOrder.id,
      },
      data: {
        orderStatus: "cancelled",
        paymentStatus: "refunded",
        updatedAt: new Date(),
      },
    });

    console.log(`📊 Draft order marked as cancelled in B2B system:`, {
      id: deletedOrder.id,
      shopifyOrderId: deletedOrder.shopifyOrderId,
      status: deletedOrder.orderStatus,
    });

  } catch (error: unknown) {
    console.error(`❌ Error processing draft order deletion webhook:`, (error as Error).message);
    console.error((error as Error).stack);
    return new Response(`Error: ${(error as Error).message}`, { status: 200 }); // Return 200 to prevent retries
  }

  return new Response("OK", { status: 200 });
};
