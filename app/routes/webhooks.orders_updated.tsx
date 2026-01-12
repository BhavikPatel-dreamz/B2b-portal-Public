/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getStoreByDomain } from "../services/store.server";
import { getOrderByShopifyId, updateOrder } from "../services/order.server";
import { validateTieredCreditForOrder, deductTieredCredit, refundTieredCredit } from "../services/tieredCreditService";
import { getUserByShopifyCustomerId } from "../services/user.server";
import { Prisma } from "@prisma/client";

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("orders/updated webhook received");
  try {
    const { payload, shop, topic } = await authenticate.webhook(request);
    console.log(`🔔 Received ${topic} webhook for ${shop}`);

    // If an outdated subscription points to this path, ignore gracefully
    if (topic !== "ORDERS_UPDATE") {
      console.info(`Webhook topic ${topic} hit orders/updated route. Ignoring.`);
      return new Response();
    }

    // Basic validation
    if (!payload || !shop) {
      return new Response("Invalid webhook payload", { status: 400 });
    }

    // Load store by shop domain
    const store = await getStoreByDomain(shop);
    if (!store) {
      console.warn(`Store not found for domain ${shop} — skipping B2B order update`);
      return new Response();
    }

    // Extract order data from webhook payload
    const customer = (payload as any).customer;
    const orderIdNum = (payload as any).id as number | undefined;
    const financialStatus = (payload as any).financial_status as string | undefined;
    const fulfillmentStatus = (payload as any).fulfillment_status as string | undefined;
    const totalPriceStr = ((payload as any).total_price ?? (payload as any).current_total_price ?? "0") as string;
    const cancelledAt = (payload as any).cancelled_at;

    if (!customer || !customer.id || !orderIdNum) {
      console.info("Order has no customer or ID; skipping B2B order update");
      return new Response();
    }

    const customerGid = `gid://shopify/Customer/${customer.id}`;
    const orderGid = `gid://shopify/Order/${orderIdNum}`;

    // Find our existing B2B order
    const existingOrder = await getOrderByShopifyId(store.id, orderGid);
    if (!existingOrder) {
      console.info(`No B2B order found for Shopify order ${orderGid} - skipping update`);
      return new Response();
    }

    console.log(`📝 Updating B2B order:`, {
      orderId: existingOrder.id,
      shopifyOrderId: orderGid,
      previousStatus: existingOrder.paymentStatus,
      newFinancialStatus: financialStatus,
      newFulfillmentStatus: fulfillmentStatus
    });

    // Find portal user for this shop + customer
    const user = await getUserByShopifyCustomerId(store.id, customerGid);
    if (!user || !user.companyId) {
      console.info(`No mapped B2B user/company for customer ${customerGid} - skipping credit processing`);
      return new Response();
    }

    // Map Shopify statuses to our local statuses
    let paymentStatus: string = "pending";
    switch (financialStatus) {
      case "paid":
        paymentStatus = "paid";
        break;
      case "partially_paid":
        paymentStatus = "partial";
        break;
      case "refunded":
      case "voided":
        paymentStatus = "cancelled";
        break;
      default:
        paymentStatus = "pending";
    }

    let orderStatus: string = "submitted";
    if (cancelledAt) {
      orderStatus = "cancelled";
    } else {
      switch (fulfillmentStatus) {
        case "fulfilled":
          orderStatus = "delivered";
          break;
        case "partial":
        case "in_progress":
          orderStatus = "processing";
          break;
        case "cancelled":
          orderStatus = "cancelled";
          break;
        default:
          orderStatus = "submitted";
      }
    }

    const orderTotal = new Prisma.Decimal(totalPriceStr);
    const previousPaymentStatus = existingOrder.paymentStatus;

    // Handle payment status transitions
    if (previousPaymentStatus !== paymentStatus) {
      console.log(`💳 Payment status changed from ${previousPaymentStatus} to ${paymentStatus}`);

      try {
        if (paymentStatus === "paid" && previousPaymentStatus === "pending") {
          // Order was paid - validate and finalize credit deduction
          console.log(`✅ Order payment confirmed - finalizing credit deduction`);

          const validation = await validateTieredCreditForOrder({
            companyId: user.companyId,
            userId: user.id,
            orderAmount: orderTotal.toNumber(),
          });

          if (!validation.success) {
            console.warn(`❌ Post-payment credit validation failed:`, {
              orderId: existingOrder.id,
              reason: validation.error
            });

            // Update order with validation failure
            await updateOrder(existingOrder.id, {
              paymentStatus: "paid",
              orderStatus: "submitted",
              paidAmount: orderTotal,
              remainingBalance: new Prisma.Decimal(0),
              paidAt: new Date(),
              notes: `Post-payment credit validation failed: ${validation.error}. Requires manual review.`
            });
          } else {
            // Credit validation passed - order is fully processed
            await updateOrder(existingOrder.id, {
              paymentStatus: "paid",
              orderStatus,
              paidAmount: orderTotal,
              remainingBalance: new Prisma.Decimal(0),
              paidAt: new Date(),
            });

            console.log(`✅ B2B order payment processed successfully`);
          }

        } else if (paymentStatus === "cancelled" || orderStatus === "cancelled") {
          // Order was cancelled - refund reserved credit
          console.log(`❌ Order cancelled - refunding reserved credit`);

          try {
            await refundTieredCredit({
              companyId: user.companyId,
              userId: user.id,
              amount: existingOrder.creditUsed.toNumber(),
              orderId: orderGid,
              description: `Credit refund for cancelled order ${orderIdNum}`
            });

            await updateOrder(existingOrder.id, {
              paymentStatus: "cancelled",
              orderStatus: "cancelled",
              creditUsed: new Prisma.Decimal(0),
              remainingBalance: orderTotal,
              notes: `Order cancelled - credit refunded`
            });

            console.log(`✅ Credit refunded for cancelled order`);
          } catch (refundError) {
            console.error(`Failed to refund credit for cancelled order:`, refundError);
          }

        } else if (paymentStatus === "partial") {
          // Partial payment - update accordingly
          const partialAmount = new Prisma.Decimal(totalPriceStr);
          await updateOrder(existingOrder.id, {
            paymentStatus: "partial",
            orderStatus,
            paidAmount: partialAmount,
            remainingBalance: orderTotal.minus(partialAmount),
          });

        } else {
          // Other status changes
          await updateOrder(existingOrder.id, {
            paymentStatus,
            orderStatus,
          });
        }

      } catch (error) {
        console.error(`Failed to process payment status change:`, error);
        // Still update basic order info
        await updateOrder(existingOrder.id, {
          paymentStatus,
          orderStatus,
          notes: `Status update error: ${error instanceof Error ? error.message : 'Unknown error'}`
        });
      }

    } else {
      // Only fulfillment status changed
      await updateOrder(existingOrder.id, {
        orderStatus,
      });
      console.log(`📦 Updated fulfillment status to ${orderStatus}`);
    }

    return new Response();

  } catch (verifyErr) {
    let headers: Record<string, string> | undefined;
    try {
      headers = Object.fromEntries(request.headers.entries());
    } catch (e) {
      // ignore header logging failure
    }
    console.error("Webhook verification failed for orders/updated", verifyErr, headers ? { headers } : undefined);
    return new Response("Unauthorized", { status: 401 });
  }
};
