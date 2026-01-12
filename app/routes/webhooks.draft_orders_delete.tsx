import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { tieredCreditService } from "../services/tieredCreditService";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, session, payload } = await authenticate.webhook(request);
  console.log(`📝 Draft Order Deleted webhook received for shop: ${shop}`);

  try {
    const draftOrder = payload as any;
    console.log(`Draft Order Deletion Details:`, {
      id: draftOrder.id,
      name: draftOrder.name,
    });

    // Find existing B2B order record
    const existingOrder = await db.b2BOrder.findFirst({
      where: {
        shopifyOrderId: draftOrder.id.toString(),
        shop: { domain: shop },
        orderStatus: "draft",
      },
      include: {
        company: {
          include: {
            account: true,
          },
        },
        user: true,
      },
    });

    if (!existingOrder) {
      console.log("❌ No existing B2B draft order found - skipping");
      return new Response("OK", { status: 200 });
    }

    console.log(`✅ Found existing B2B draft order: ${existingOrder.shopifyOrderId}`);
    console.log(`💰 Releasing reserved credit: ${existingOrder.creditUsed}`);

    // Release any reserved credit
    if (existingOrder.creditUsed && existingOrder.creditUsed > 0) {
      try {
        const refundResult = await tieredCreditService.refundCredit({
          companyId: existingOrder.companyId,
          userId: existingOrder.createdByUserId,
          amount: parseFloat(existingOrder.creditUsed.toString()),
          orderId: existingOrder.shopifyOrderId,
          reason: "Draft order deleted",
          shop: shop,
        });

        console.log(`💳 Credit refunded:`, refundResult);
      } catch (creditError: any) {
        console.error(`❌ Credit refund failed:`, creditError.message);
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

  } catch (error: any) {
    console.error(`❌ Error processing draft order deletion webhook:`, error.message);
    console.error(error.stack);
    return new Response(`Error: ${error.message}`, { status: 200 }); // Return 200 to prevent retries
  }

  return new Response("OK", { status: 200 });
};
