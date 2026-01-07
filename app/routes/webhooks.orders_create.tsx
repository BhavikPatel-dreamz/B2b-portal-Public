import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getStoreByDomain } from "../services/store.server";
import { Prisma } from "@prisma/client";

// Handle Shopify ORDERS_CREATE webhook
export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

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
    const user = await prisma.user.findFirst({
      where: {
        shopId: store.id,
        shopifyCustomerId: customerGid,
        isActive: true,
        status: "APPROVED",
      },
      select: { id: true, companyId: true },
    });

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

    // Create B2B order entry
    await prisma.b2BOrder.create({
      data: {
        companyId: user.companyId,
        createdByUserId: user.id,
        shopId: store.id,
        shopifyOrderId: orderGid,
        orderTotal,
        creditUsed: new Prisma.Decimal(0), // unknown from Shopify checkout; treat as 0
        paymentStatus,
        orderStatus,
        paidAmount,
        remainingBalance,
      },
    });

    return new Response();
  } catch (err) {
    console.error("Failed to log B2B order from orders/create webhook", err);
    // Return 200 so Shopify doesn't retry indefinitely; log for follow-up
    return new Response();
  }
};
