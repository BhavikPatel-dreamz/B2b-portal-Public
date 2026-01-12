import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

import { deductCredit } from "../services/tieredCreditService";
import { getCompanyByUserId } from "../services/user.server";
import {  upsertOrder } from "../services/order.server";
import { getStoreByDomain } from "../services/store.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, shop, payload } = await authenticate.webhook(request);
  console.log(JSON.stringify(payload))
  console.log(`📝 Draft Order Created webhook received for shop: ${shop}`);

  try {
    const draftOrder = payload as any;

    // Validate required fields from the payload
    if (!draftOrder.id || !draftOrder.total_price) {
      console.log("❌ Invalid draft order payload - missing required fields");
      return new Response("Invalid payload", { status: 400 });
    }

    console.log(`Draft Order Details:`, {
      id: draftOrder.id,
      name: draftOrder.name,
      email: draftOrder.email,
      total_price: draftOrder.total_price,
      currency: draftOrder.currency,
      status: draftOrder.status,
      b2b: draftOrder["b2b?"],
      line_items_count: draftOrder.line_items?.length
    });

    // Check if this is a B2B draft order
    if (!draftOrder["b2b?"] || draftOrder["b2b?"] !== true) {
      console.log("❌ Not a B2B draft order - skipping B2B processing");
      return new Response("OK", { status: 200 });
    }

    // Check if this is a B2B draft order
    if (!draftOrder.customer?.id) {
      console.log("❌ No customer found in draft order - skipping B2B processing");
      return new Response("OK", { status: 200 });
    }

    const customerId = draftOrder.customer.id.toString();
    console.log(`🔍 Looking for B2B user with Shopify customer ID: ${customerId}`);

    // Find the store first to get shopId

    const store = await getStoreByDomain(shop);
        if (!store) {
          console.log(`Store not found for domain ${shop} — skipping B2B order log`);
          return new Response();
        }


    // Find B2B user by Shopify customer ID using user service
    const b2bUser = await getCompanyByUserId(store.id, `gid://shopify/Customer/${customerId}`);

    if (!b2bUser?.company) {
      console.log("❌ No B2B company found for customer - skipping B2B processing");
      return new Response("OK", { status: 200 });
    }

    console.log(`✅ Found B2B company: ${b2bUser.company.name} (ID: ${b2bUser.company.id})`);

    const totalAmount = parseFloat(draftOrder.total_price || "0");
    console.log(`💰 Draft order total: ${totalAmount} ${draftOrder.currency}`);

    // Reserve credit for the draft order (pending review)
    try {
      console.log(`🏦 Attempting to deduct ${totalAmount} credit for company ${b2bUser.company.id}`);


      console.log(`💳 Credit reserved successfully for draft order ${draftOrder.name || `#${draftOrder.id}`}`);

      // Create or update order using upsert function
      const draftOrderData = await upsertOrder({
        shopifyOrderId: draftOrder.id.toString(),
        companyId: b2bUser.company.id,
        createdByUserId: b2bUser.id,
        shopId: store.id,
        orderTotal: totalAmount,
        creditUsed: totalAmount, // Use total amount since we deducted credit
        userCreditUsed: 0, // Add required field - no user-specific credit used for draft orders
        paymentStatus: "pending",
        orderStatus: "draft", // Draft order status
        remainingBalance: totalAmount,
      });

      console.log(`📊 Upserted draft order in B2B system:`, {
        id: draftOrderData.id,
        shopifyOrderId: draftOrderData.shopifyOrderId,
        orderTotal: draftOrderData.orderTotal,
        creditUsed: draftOrderData.creditUsed,
        userCreditUsed: draftOrderData.userCreditUsed,
      });

     const creditDeductionResult = await deductCredit(
        b2bUser.company.id,
        draftOrderData.id, // Use the actual order ID from database instead of shopify order ID
        totalAmount,
        b2bUser.id,
        admin // Pass admin context for metafield sync
      );
      console.log(`✅ Credit deduction result:`, creditDeductionResult);


      console.log(`📊 Draft order stored in B2B system:`, {
        id: draftOrderData.id,
        shopifyOrderId: draftOrderData.shopifyOrderId,
        orderTotal: draftOrderData.orderTotal,
        creditUsed: draftOrderData.creditUsed,
        userCreditUsed: draftOrderData.userCreditUsed,
      });

    } catch (creditError: any) {
      console.error(`❌ Credit reservation failed:`, {
        error: creditError.message,
        stack: creditError.stack,
        companyId: b2bUser.company.id,
        orderAmount: totalAmount
      });
      // Don't fail the webhook, just log the error
      return new Response(`Credit reservation failed: ${creditError.message}`, { status: 500 });
    }

  } catch (error: any) {
    console.error(`❌ Error processing draft order webhook:`, error.message);
    console.error(error.stack);
    return new Response(`Error: ${error.message}`, { status: 500 });
  }

  return new Response("OK", { status: 200 });
};
