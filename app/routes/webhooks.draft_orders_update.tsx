import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { deductCredit, restoreCredit } from "../services/tieredCreditService";
import { getCompanyByUserId } from "../services/user.server";
import { upsertOrder, getOrderByShopifyIdWithDetails, deleteOrder, convertDraftOrderToFinal } from "../services/order.server";
import { getStoreByDomain } from "../services/store.server";

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
  note_attributes?: {
    name: string;
    value: string;
  }[];
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, shop, payload } = await authenticate.webhook(request);
  console.log(`📝 Draft Order Updated webhook received for shop: ${shop}`);

  try {
    const draftOrder = payload as ShopifyDraftOrder;

    // Extract order source from note_attributes (e.g., 'quick_order')
    const orderSource =
      draftOrder.note_attributes?.find((attr: any) => attr.name === "_source")
        ?.value || null;

    console.log(`Draft Order Update Details:`, {
      id: draftOrder.id,
      email: draftOrder.email,
      total_price: draftOrder.total_price,
      currency: draftOrder.currency,
      status: draftOrder.status,
      line_items_count: draftOrder.line_items?.length,
      source: orderSource,
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
      return new Response("OK", { status: 200 });
    }

    // Find existing B2B order record using order service
    const existingOrder = await getOrderByShopifyIdWithDetails(store.id, draftOrder.id.toString());

    if (!existingOrder) {
      console.log("❌ No existing B2B draft order found - skipping");
      return new Response("OK", { status: 200 });
    }

    console.log(`✅ Found existing B2B draft order: ${existingOrder.shopifyOrderId}`);

    // Find B2B user by Shopify customer ID using user service
    const b2bUser = await getCompanyByUserId(store.id, `gid://shopify/Customer/${customerId}`);

    if (!b2bUser?.company) {
      console.log("❌ No B2B company found for customer - skipping B2B processing");
      return new Response("OK", { status: 200 });
    }

    console.log(`✅ Found B2B company: ${b2bUser.company.name} (ID: ${b2bUser.company.id})`);

    // Check if the draft order status is "completed" - if so, mark it as converted/archived in B2B system
    if (draftOrder.status === "completed") {
      console.log(`🔄 Draft order status is "completed" - marking as converted/archived in B2B system`);

      const finalOrderId = (draftOrder as any).order_id
        ? (draftOrder as any).order_id.toString()
        : "unknown";

      try {
        await convertDraftOrderToFinal(draftOrder.id.toString(), finalOrderId, admin);
      } catch (convError: unknown) {
        console.error(`❌ Failed to convert draft order:`, (convError as Error).message);
        return new Response(`Failed to convert draft order: ${(convError as Error).message}`, { status: 500 });
      }

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
          console.log(`🏦 Attempting to deduct additional ${amountDifference} credit for company ${b2bUser.company.id}`);

          const additionalCreditResult = await deductCredit(
            b2bUser.company.id,
            existingOrder.id, // Use the database order ID
            amountDifference,
            b2bUser.id,
            admin // Pass admin context for metafield sync
          );

          console.log(`💳 Additional credit deducted:`, additionalCreditResult);
        } else {
          // Amount decreased, release some credit
          const releaseAmount = Math.abs(amountDifference);
          console.log(`🏦 Attempting to restore ${releaseAmount} credit for company ${b2bUser.company.id}`);

          const releaseResult = await restoreCredit(
            b2bUser.company.id,
            existingOrder.id, // Use the database order ID
            releaseAmount,
            b2bUser.id,
            "cancelled",
            admin // Pass admin context for metafield sync
          );



          console.log(`💳 Credit released:`, releaseResult);
        }
      } catch (creditError: unknown) {
        console.error(`❌ Credit adjustment failed:`, {
          error: (creditError as Error).message,
          stack: (creditError as Error).stack,
          companyId: b2bUser.company.id,
          orderAmount: amountDifference
        });
        // Don't fail the webhook, just log the error
        return new Response(`Credit adjustment failed: ${(creditError as Error).message}`, { status: 500 });
      }
    }

    // Update the B2B order record using upsert function (same as create)
    const updatedOrder = await upsertOrder({
      shopifyOrderId: draftOrder.id.toString(),
      companyId: b2bUser.company.id,
      createdByUserId: b2bUser.id,
      shopId: store.id,
      orderTotal: newTotalAmount,
      creditUsed: newTotalAmount, // Use total amount since we track credit used
      userCreditUsed: 0, // Add required field - no user-specific credit used for draft orders
      paymentStatus: "pending",
      orderStatus: "draft", // Draft order status
      remainingBalance: newTotalAmount,
      source: orderSource,
    });

    console.log(`📊 Draft order updated in B2B system:`, {
      id: updatedOrder.id,
      shopifyOrderId: updatedOrder.shopifyOrderId,
      orderTotal: updatedOrder.orderTotal,
      creditUsed: updatedOrder.creditUsed,
      userCreditUsed: updatedOrder.userCreditUsed,
    });

  } catch (error: unknown) {
    console.error(`❌ Error processing draft order update webhook:`, (error as Error).message);
    console.error((error as Error).stack);
    return new Response(`Error: ${(error as Error).message}`, { status: 500 }); 
  }

  return new Response("OK", { status: 200 });
};
