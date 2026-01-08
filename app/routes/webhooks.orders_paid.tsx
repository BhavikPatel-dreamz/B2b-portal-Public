/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getStoreByDomain } from "../services/store.server";
import { getOrderByShopifyId, updateOrder } from "../services/order.server";
import { Prisma } from "@prisma/client";

// Handle Shopify ORDERS_PAID webhook
export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    if (!payload || !shop) return new Response();

    const store = await getStoreByDomain(shop);
    if (!store) return new Response();

    const orderIdNum = (payload as any).id as number | undefined;
    const totalPriceStr = ((payload as any).total_price ?? (payload as any).current_total_price ?? "0") as string;
    if (!orderIdNum) return new Response();

    const orderGid = `gid://shopify/Order/${orderIdNum}`;

    const order = await getOrderByShopifyId(store.id, orderGid);
    if (!order) return new Response();

    // If Shopify says paid, mark fully paid locally
    const orderTotal = new Prisma.Decimal(totalPriceStr);

    await updateOrder(order.id, {
      paymentStatus: "paid",
      paidAmount: orderTotal,
      remainingBalance: new Prisma.Decimal(0),
      paidAt: new Date(),
    });

    return new Response();
  } catch (err) {
    console.error("Failed to handle ORDERS_PAID webhook", err);
    return new Response();
  }
};
