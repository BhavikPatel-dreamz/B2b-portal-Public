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


  interface ShopifyDraftOrder {
    id: string;
    name: string;
    email: string;
    total_price: string;
    currency: string;
    status: string;
    "b2b?": boolean;
    line_items?: {
      id: string;
      name: string;
      quantity: number;
      price: string;
      currency: string;
    }[];
    customer?: {
      id: string;
    };
  }
  
  try {
    const draftOrder = payload as ShopifyDraftOrder;

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
      console.log(`📝 Syncing draft order ${draftOrder.id} to B2B system`);

      // Create or update order using upsert function
      const draftOrderData = await upsertOrder({
        shopifyOrderId: draftOrder.id.toString(),
        companyId: b2bUser.company.id,
        createdByUserId: b2bUser.id,
        shopId: store.id,
        orderTotal: totalAmount,
        creditUsed: totalAmount, // This will be set in the DB
        userCreditUsed: 0, 
        paymentStatus: "pending",
        orderStatus: "draft", 
        remainingBalance: totalAmount,
      });

      console.log(`📊 Order record synced (ID: ${draftOrderData.id}). Processing credit deduction...`);

      // Single path for credit deduction
      const creditDeductionResult = await deductCredit(
        b2bUser.company.id,
        draftOrderData.id, 
        totalAmount,
        b2bUser.id,
        admin 
      );
      console.log(`✅ Credit deduction successful:`, creditDeductionResult);

    } catch (creditError: unknown) {
      console.error(`❌ Credit reservation failed:`, {
        error: (creditError as Error).message,
        stack: (creditError as Error).stack,
        companyId: b2bUser.company.id,
        orderAmount: totalAmount
      });
      // Don't fail the webhook, just log the error
      return new Response(`Credit reservation failed: ${(creditError as Error).message}`, { status: 500 });
    }

  } catch (error: unknown) {
    console.error(`❌ Error processing draft order webhook:`, (error as Error).message);
    console.error((error as Error).stack);
    return new Response(`Error: ${(error as Error).message}`, { status: 500 });
  }

  return new Response("OK", { status: 200 });
};
