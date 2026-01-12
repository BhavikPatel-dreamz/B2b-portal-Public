import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { deductCredit } from "../services/tieredCreditService";
import { getUserByShopifyCustomerId } from "../services/user.server";
import { createOrder } from "../services/order.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const {  shop, payload } = await authenticate.webhook(request);
  console.log(`📝 Draft Order Created webhook received for shop: ${shop}`);

  try {
    const draftOrder = payload as any;
    console.log(`Draft Order Details:`, {
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

    // Find B2B user by Shopify customer ID using user service
    const b2bUser = await getUserByShopifyCustomerId(store.id, `gid://shopify/Customer/${customerId}`);

    if (!b2bUser?.company) {
      console.log("❌ No B2B company found for customer - skipping B2B processing");
      return new Response("OK", { status: 200 });
    }

    console.log(`✅ Found B2B company: ${b2bUser.company.name} (ID: ${b2bUser.company.id})`);

    const totalAmount = parseFloat(draftOrder.total_price || "0");
    console.log(`💰 Draft order total: ${totalAmount} ${draftOrder.currency}`);

    // Reserve credit for the draft order (pending review)
    try {
      const creditResult = await deductCredit({
        companyId: b2bUser.company.id,
        orderAmount: totalAmount,
        orderId: draftOrder.id.toString(),
        description: `Credit reserved for draft order ${draftOrder.name || draftOrder.order_number}`,
      });

      console.log(`💳 Credit reservation result:`, creditResult);

      // Store draft order information for tracking using order service
      const draftOrderData = await createOrder({
        shopifyOrderId: draftOrder.id.toString(),
        companyId: b2bUser.company.id,
        createdByUserId: b2bUser.id,
        shopId: store.id,
        orderTotal: totalAmount,
        creditUsed: totalAmount, // Use total amount since we deducted credit
        paymentStatus: "pending",
        orderStatus: "draft", // Draft order status
        remainingBalance: totalAmount,
      });

      console.log(`📊 Draft order stored in B2B system:`, {
        id: draftOrderData.id,
        shopifyOrderId: draftOrderData.shopifyOrderId,
        orderTotal: draftOrderData.orderTotal,
        creditUsed: draftOrderData.creditUsed,
      });

    } catch (creditError: any) {
      console.error(`❌ Credit reservation failed:`, creditError.message);
      // Don't fail the webhook, just log the error
    }

  } catch (error: any) {
    console.error(`❌ Error processing draft order webhook:`, error.message);
    console.error(error.stack);
    return new Response(`Error: ${error.message}`, { status: 500 });
  }

  return new Response("OK", { status: 200 });
};
