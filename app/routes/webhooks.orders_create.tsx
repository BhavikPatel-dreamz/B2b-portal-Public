/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getStoreByDomain } from "../services/store.server";
import { createOrder } from "../services/order.server";
import { getUserByShopifyCustomerId } from "../services/user.server";
import { Prisma } from "@prisma/client";


export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("orders/create webhook received");
  try {

    const { payload, shop, topic } = await authenticate.webhook(request);
    console.log(`Received ${topic} webhook for ${shop} ${payload }`);

    // If an outdated subscription points edited to this path, ignore gracefully
    if (topic !== "ORDERS_CREATE") {
      console.info(`Webhook topic ${topic} hit orders/create route. Ignoring.`);
      return new Response();
    }

  try {
    // Basic validation
    if (!payload || !shop) {
      return new Response("Invalid webhook payload", { status: 400 });
    }

    // Load store by shop domain
    const store = await getStoreByDomain(shop);
    if (!store) {
      console.warn(`Store not found for domain ${shop} — skipping B2B order log`);
      return new Response();
    }

    // Extract customer from webhook payload (REST orders payload)
    const customer = (payload as any).customer;
    const orderIdNum = (payload as any).id as number | undefined;
    const financialStatus = (payload as any).financial_status as string | undefined;
    const fulfillmentStatus = (payload as any).fulfillment_status as string | undefined;
    const totalPriceStr = ((payload as any).total_price ?? (payload as any).current_total_price ?? "0") as string;

    if (!customer || !customer.id) {
      // No customer on order — cannot associate to a B2B user/company
      console.info("Order has no customer; skipping B2B order entry");
      return new Response();
    }

    // Convert numeric Shopify IDs to GraphQL GIDs used in our DB
    const customerGid = `gid://shopify/Customer/${customer.id}`;
    const orderGid = orderIdNum ? `gid://shopify/Order/${orderIdNum}` : undefined;

    // Find portal user for this shop + customer
    const user = await getUserByShopifyCustomerId(store.id, customerGid);

    console.log("Mapped user for customer:", { user, customerGid, userId: user?.id, companyId: user?.companyId });

    if (!user || !user.companyId) {
      console.info(
        `No mapped B2B user/company for customer ${customerGid} on shop ${shop}; skipping B2B order entry`,
      );
      return new Response();
    }

    // Map Shopify statuses to our local statuses
    let paymentStatus: string = "pending"; // pending, partial, paid, cancelled
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

    let orderStatus: string = "submitted"; // draft, submitted, processing, shipped, delivered, cancelled
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

    // Amounts
    const orderTotal = new Prisma.Decimal(totalPriceStr);
    const paidAmount = paymentStatus === "paid" ? orderTotal : new Prisma.Decimal(0);
    const remainingBalance = orderTotal.minus(paidAmount);

    console.log(`🎯 B2B Order Creation - Processing:`, {
      orderId: orderIdNum,
      companyId: user.companyId,
      paymentStatus,
      orderStatus,
      orderTotal: orderTotal.toString(),
      paidAmount: paidAmount.toString(),
      remainingBalance: remainingBalance.toString()
    });

    // For B2B orders with pending payment, we still need to reserve the credit
    // and validate against company limits
    if (paymentStatus === "pending") {
      console.log(`🔄 B2B Order with pending payment - reserving credit`);

      // Import credit validation service
      const { validateTieredCreditForOrder, deductTieredCredit } = await import("../services/tieredCreditService");

      try {
        // Validate credit availability for the order
        const validation = await validateTieredCreditForOrder({
          companyId: user.companyId,
          userId: user.id,
          orderAmount: orderTotal.toNumber(),
        });

        if (!validation.success) {
          console.warn(`❌ Credit validation failed for pending B2B order:`, {
            orderId: orderIdNum,
            companyId: user.companyId,
            reason: validation.error
          });

          // Still create the order but mark it as requiring attention
          await createOrder({
            companyId: user.companyId,
            createdByUserId: user.id,
            shopId: store.id,
            shopifyOrderId: orderGid,
            orderTotal,
            creditUsed: new Prisma.Decimal(0), // No credit used yet since payment is pending
            userCreditUsed: new Prisma.Decimal(0), // No user credit used yet
            remainingBalance,
            paymentStatus: "pending",
            orderStatus: "submitted",
            notes: `Credit validation failed: ${validation.error}. Order requires manual review.`
          });

          console.log(`⚠️ B2B order created with credit validation warning`);
          return new Response();
        }

        // Validation passed - reserve credit for pending payment
        await deductTieredCredit({
          companyId: user.companyId,
          userId: user.id,
          amount: orderTotal.toNumber(),
          orderId: orderGid || `temp-${orderIdNum}`,
          description: `Credit reserved for pending order ${orderIdNum}`
        });

        console.log(`✅ Credit reserved for pending B2B order:`, {
          orderId: orderIdNum,
          creditReserved: orderTotal.toString()
        });

      } catch (creditError) {
        console.error(`Failed to process credit for pending B2B order:`, creditError);
        // Continue with order creation but log the error
      }
    }

    // Create B2B order entry via service
    await createOrder({
      companyId: user.companyId,
      createdByUserId: user.id,
      shopId: store.id,
      shopifyOrderId: orderGid,
      orderTotal,
      creditUsed: paymentStatus === "pending" ? orderTotal : new Prisma.Decimal(0), // Credit is reserved for pending orders
      userCreditUsed: new Prisma.Decimal(0), // No user credit used for orders
      remainingBalance,
      paymentStatus,
      orderStatus,
    });

    return new Response();
  } catch (err) {
    console.error("Failed to log B2B order from orders/create webhook", err);
    // Return 200 so Shopify doesn't retry indefinitely; log for follow-up
    return new Response();
  }
  } catch (verifyErr) {
    let headers: Record<string, string> | undefined;
    try {
      headers = Object.fromEntries(request.headers.entries());
    } catch (e) {
      // ignore header logging failure
    }
    console.error("Webhook verification failed for orders/create", verifyErr, headers ? { headers } : undefined);
    return new Response("Unauthorized", { status: 401 });
  }
};
