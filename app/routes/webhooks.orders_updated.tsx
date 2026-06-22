/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getStoreByDomain } from "../services/store.server";
import { getOrderByShopifyId } from "../services/order.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("orders/updated webhook received");
  try {
    const { payload, shop, topic } = await authenticate.webhook(request);
    console.log(`🔔 Received ${topic} webhook for ${shop},${JSON.stringify(payload)}`);

    // If an outdated subscription points to this path, ignore gracefully
    if (topic !== "ORDERS_UPDATED" && topic !== "ORDERS_EDITED") {
      console.info(`Webhook topic ${topic} hit orders/updated route. Ignoring.`);
      return new Response(null, { status: 200 });
    }

    // Basic validation
    if (!payload || !shop) {
      return new Response("Invalid webhook payload", { status: 400 });
    }

    // Load store by shop domain
    const store = await getStoreByDomain(shop);
    if (!store) {
      console.warn(`Store not found for domain ${shop} — skipping B2B order update`);
      return new Response(null, { status: 200 });
    }

    // Extract order data from webhook payload
    const customer = (payload as any).customer;
    const orderIdNum = (payload as any).id as number | undefined;
    const financialStatus = (payload as any).financial_status as string | undefined;
    const fulfillmentStatus = (payload as any).fulfillment_status as string | undefined;
    const totalPriceStr = ((payload as any).current_total_price ?? (payload as any).total_price ?? "0") as string; // Use current_total_price first (after refunds)
    const originalTotalPrice = (payload as any).total_price as string;
    const cancelledAt = (payload as any).cancelled_at;
    const updatedAt = (payload as any).updated_at;
    const confirmedStatus = (payload as any).confirmed;
    const currency = (payload as any).currency || (payload as any).presentment_currency;
    const orderNumber = (payload as any).order_number || (payload as any).number;
    const paymentTerms = (payload as any).payment_terms;
    const totalOutstanding = (payload as any).total_outstanding;
    const refunds = (payload as any).refunds || [];
    if (!customer || !customer.id || !orderIdNum) {
      console.info("Order has no customer or ID; skipping B2B order update");
      return new Response(null, { status: 200 });
    }

    const customerGid = `gid://shopify/Customer/${customer.id}`;
    const orderGid = `gid://shopify/Order/${orderIdNum}`;

    {
      console.log(`🔍 Processing B2B order update for Shopify order ID: ${orderGid}, Customer ID: ${customerGid}`);
    }
    // Find our existing B2B order
    const existingOrder = await getOrderByShopifyId(store.id, orderGid);
    if (!existingOrder) {
      console.info(`No B2B order found for Shopify order ${orderGid} - skipping update`);
      return new Response(null, { status: 200 });
    }

    // Extract order source from note_attributes (e.g., 'quick_order')
    const orderSource =
      (payload as any).note_attributes?.find(
        (attr: any) => attr.name === "_source",
      )?.value || null;

    console.log(`📝 Updating B2B order:`, {
      orderId: existingOrder.id,
      shopifyOrderId: orderGid,
      orderNumber: orderNumber,
      currency: currency,
      originalTotalPrice: originalTotalPrice,
      currentTotalPrice: totalPriceStr,
      totalOutstanding: totalOutstanding,
      existingCreditUsed: existingOrder.creditUsed?.toString() || '0',
      existingPaymentStatus: existingOrder.paymentStatus,
      existingOrderStatus: existingOrder.orderStatus,
      newFinancialStatus: financialStatus,
      newFulfillmentStatus: fulfillmentStatus,
      confirmed: confirmedStatus,
      updatedAt: updatedAt,
      refundsCount: refunds.length,
      source: orderSource,
      paymentTerms: paymentTerms ? {
        dueInDays: paymentTerms.due_in_days,
        type: paymentTerms.payment_terms_type,
        name: paymentTerms.payment_terms_name
      } : null
    });

    console.log("ℹ️ ORDERS_UPDATED webhook acknowledged without local status sync", {
      orderId: existingOrder.id,
      shopifyOrderId: orderGid,
      ignoredFinancialStatus: financialStatus,
      ignoredFulfillmentStatus: fulfillmentStatus,
      ignoredCancelledAt: cancelledAt,
    });

    return new Response(null, { status: 200 });

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
