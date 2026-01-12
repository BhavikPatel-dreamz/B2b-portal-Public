import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { tieredCreditService } from "../services/tieredCreditService";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, session, payload } = await authenticate.webhook(request);
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

    // Find B2B user by Shopify customer ID
    const b2bUser = await db.user.findFirst({
      where: {
        shopifyCustomerId: customerId,
        shop: shop,
      },
      include: {
        company: {
          include: {
            account: true,
          },
        },
      },
    });

    if (!b2bUser?.company) {
      console.log("❌ No B2B company found for customer - skipping B2B processing");
      return new Response("OK", { status: 200 });
    }

    console.log(`✅ Found B2B company: ${b2bUser.company.name} (ID: ${b2bUser.company.id})`);

    const totalAmount = parseFloat(draftOrder.total_price || "0");
    console.log(`💰 Draft order total: ${totalAmount} ${draftOrder.currency}`);

    // Reserve credit for the draft order (pending review)
    try {
      const creditResult = await tieredCreditService.reserveCredit({
        companyId: b2bUser.company.id,
        userId: b2bUser.id,
        amount: totalAmount,
        orderId: draftOrder.id.toString(),
        orderNumber: draftOrder.name || draftOrder.order_number,
        shop: shop,
      });

      console.log(`💳 Credit reservation result:`, creditResult);

      // Store draft order information for tracking
      const draftOrderData = await db.b2BOrder.create({
        data: {
          shopifyOrderId: draftOrder.id.toString(),
          companyId: b2bUser.company.id,
          createdByUserId: b2bUser.id,
          shopId: b2bUser.company.shopId,
          orderTotal: totalAmount,
          creditUsed: creditResult.amount,
          userCreditUsed: 0, // Will be calculated based on user credit usage
          paymentStatus: "pending",
          orderStatus: "draft", // Draft order status
          remainingBalance: totalAmount,
        },
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
