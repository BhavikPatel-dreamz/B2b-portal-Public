import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { deductCredit, restoreCredit } from "../services/tieredCreditService";
import { getUserById } from "../services/user.server";
import { getOrderByShopifyIdWithDetails } from "../services/order.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const {  shop,  payload } = await authenticate.webhook(request);
  console.log(`📝 Draft Order Updated webhook received for shop: ${shop}`);

  try {
    const draftOrder = payload as any;
    console.log(`Draft Order Update Details:`, {
      id: draftOrder.id,
      email: draftOrder.email,
      total_price: draftOrder.total_price,
      currency: draftOrder.currency,
      status: draftOrder.status,
      line_items_count: draftOrder.line_items?.length
    });

    // Check if this is a B2B draft order
    if (!draftOrder.customer?.id) {
      console.log("❌ No customer found in draft order - skipping B2B processing");
      return new Response("OK", { status: 200 });
    }

    const customerId = draftOrder.customer.id.toString();
    console.log(`🔍 Looking for B2B user with Shopify customer ID: ${customerId}`);

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

    if (!existingOrder) {
      console.log("❌ No existing B2B draft order found - skipping");
      return new Response("OK", { status: 200 });
    }

    console.log(`✅ Found existing B2B draft order: ${existingOrder.orderNumber}`);

    // Get user details using user service
    const user = await getUserById(existingOrder.userId, store.id);
    if (!user) {
      console.log("❌ User not found or doesn't belong to this shop - skipping");
      return new Response("OK", { status: 200 });
    }

    const newTotalAmount = parseFloat(draftOrder.total_price || "0");
    const previousAmount = existingOrder.orderTotal;
    const amountDifference = newTotalAmount - parseFloat(previousAmount.toString());

    console.log(`💰 Price change: ${previousAmount} → ${newTotalAmount} (difference: ${amountDifference})`);

    // Handle credit adjustment if amount changed
    if (amountDifference !== 0) {
      try {
        if (amountDifference > 0) {
          // Need to deduct more credit
          const additionalCreditResult = await deductCredit({
            companyId: existingOrder.companyId,
            orderAmount: amountDifference,
            orderId: draftOrder.id.toString(),
            description: `Additional credit for draft order ${draftOrder.name || draftOrder.order_number}`,
          });

          console.log(`💳 Additional credit deducted:`, additionalCreditResult);
        } else {
          // Amount decreased, release some credit
          const releaseAmount = Math.abs(amountDifference);
          const releaseResult = await restoreCredit({
            companyId: existingOrder.companyId,
            orderAmount: releaseAmount,
            orderId: draftOrder.id.toString(),
            description: "Draft order amount decreased",
          });

          console.log(`💳 Credit released:`, releaseResult);
        }
      } catch (creditError: any) {
        console.error(`❌ Credit adjustment failed:`, creditError.message);
        // Don't fail the webhook, just log the error
      }
    }

    // Update the B2B order record
    const updatedOrder = await db.b2BOrder.update({
      where: {
        id: existingOrder.id,
      },
      data: {
        orderTotal: newTotalAmount,
        creditUsed: newTotalAmount, // Update credit amount to match new total
        remainingBalance: newTotalAmount,
        updatedAt: new Date(),
      },
    });

    console.log(`📊 Draft order updated in B2B system:`, {
      id: updatedOrder.id,
      shopifyOrderId: updatedOrder.shopifyOrderId,
      newTotal: updatedOrder.orderTotal,
      creditUsed: updatedOrder.creditUsed,
    });

  } catch (error: any) {
    console.error(`❌ Error processing draft order update webhook:`, error.message);
    console.error(error.stack);
    return new Response(`Error: ${error.message}`, { status: 500 });
  }

  return new Response("OK", { status: 200 });
};
