/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getStoreByDomain } from "../services/store.server";
import prisma from "app/db.server";

// Handle Shopify ORDERS_PAID webhook
export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic } = await authenticate.webhook(request);
  console.log(`🔔 Received ${topic} webhook for ${shop}`);

  try {
    if (!payload || !shop) return new Response();

    const store = await getStoreByDomain(shop);
    if (!store) return new Response();

    const orderIdNum = (payload as any).id as number | undefined;
    const orderNumber =
      (payload as any).order_number || (payload as any).number;
    const financialStatus = String(
      (payload as any).financial_status || "",
    ).toLowerCase();
    const totalOutstanding = Number((payload as any).total_outstanding ?? 0);
    const paidTotal = Number(
      (payload as any).current_total_price ?? (payload as any).total_price,
    );
    const currency = String(
      (payload as any).currency || (payload as any).presentment_currency || "",
    );
    const customerEmail = String(
      (payload as any).email || (payload as any).customer?.email || "",
    );

    if (!orderIdNum) return new Response();

    const orderGid = `gid://shopify/Order/${orderIdNum}`;

    // Find our B2B order
    const order = await prisma.b2BOrder.findFirst({
      where: {
        shopId: store.id,
        shopifyOrderId: orderGid,
        source: "Sales Portal",
      },
    });
    if (!order) {
      console.log(
        `No B2B order found for Shopify order ${orderGid} - skipping post-payment validation`,
      );
      return new Response();
    }

    if (financialStatus !== "paid" || totalOutstanding > 0) {
      console.warn(
        "Ignoring orders/paid webhook without confirmed full payment",
        {
          b2bOrderId: order.id,
          financialStatus,
          totalOutstanding,
        },
      );
      return new Response();
    }
    if (currency && currency !== order.currencyCode) {
      console.error("Ignoring orders/paid webhook with a currency mismatch", {
        b2bOrderId: order.id,
        expectedCurrency: order.currencyCode,
        receivedCurrency: currency,
      });
      return new Response();
    }
    if (
      !Number.isFinite(paidTotal) ||
      Math.abs(paidTotal - Number(order.orderTotal)) > 0.009
    ) {
      console.error("Ignoring orders/paid webhook with an amount mismatch", {
        b2bOrderId: order.id,
        expectedAmount: order.orderTotal.toString(),
        receivedAmount: paidTotal,
      });
      return new Response();
    }
    if (
      order.customerEmail &&
      customerEmail &&
      order.customerEmail.toLowerCase() !== customerEmail.toLowerCase()
    ) {
      console.error("Ignoring orders/paid webhook with a customer mismatch", {
        b2bOrderId: order.id,
      });
      return new Response();
    }

    const paidAt = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.b2BOrder.updateMany({
        where: {
          id: order.id,
          source: "Sales Portal",
          paymentStatus: "pending",
          orderStatus: { not: "cancelled" },
        },
        data: {
          paymentStatus: "paid",
          orderStatus: "paid",
          paidAmount: order.orderTotal,
          remainingBalance: 0,
          paidAt,
        },
      });
      if (result.count === 0) return false;

      await tx.orderPayment.create({
        data: {
          orderId: order.id,
          amount: order.orderTotal,
          method: "shopify",
          status: "paid",
          receivedAt: paidAt,
        },
      });
      await tx.orderActivity.create({
        data: {
          orderId: order.id,
          action: "Payment Confirmed",
          message:
            "Shopify confirmed full payment through the orders/paid webhook.",
          metadata: {
            provider: "shopify",
            shopifyOrderId: orderGid,
            currency: order.currencyCode,
            amount: order.orderTotal.toString(),
          },
        },
      });
      return true;
    });

    console.log(`Sales Portal payment confirmation processed`, {
      b2bOrderId: order.id,
      shopifyOrderId: orderGid,
      orderNumber,
      companyId: order.companyId,
      previousPaymentStatus: order.paymentStatus,
      updated,
    });

    return new Response();
  } catch (err) {
    console.error("Failed to handle ORDERS_PAID webhook", err);
    return new Response("Webhook processing failed", { status: 500 });
  }
};
