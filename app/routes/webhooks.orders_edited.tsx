/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getStoreByDomain } from "../services/store.server";
import { Prisma } from "@prisma/client";

// Handle Shopify ORDERS_EDITED webhook
export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    if (!payload || !shop) return new Response();

    const store = await getStoreByDomain(shop);
    if (!store) return new Response();

    const orderIdNum = (payload as any).id as number | undefined;
    if (!orderIdNum) return new Response();

    const orderGid = `gid://shopify/Order/${orderIdNum}`;

    // Update local B2B order totals/statuses based on edited order
    const totalPriceStr = ((payload as any).total_price ?? (payload as any).current_total_price ?? "0") as string;
    const orderTotal = new Prisma.Decimal(totalPriceStr);

    const existing = await prisma.b2BOrder.findFirst({
      where: { shopId: store.id, shopifyOrderId: orderGid },
      select: { id: true, paidAmount: true },
    });

    if (!existing) return new Response();

    const paidAmount = existing.paidAmount ?? new Prisma.Decimal(0);
    const remainingBalance = orderTotal.minus(paidAmount);

    await prisma.b2BOrder.update({
      where: { id: existing.id },
      data: {
        orderTotal,
        remainingBalance,
        orderStatus: remainingBalance.isZero() ? "delivered" : "processing",
      },
    });

    return new Response();
  } catch (err) {
    console.error("Failed to handle ORDERS_EDITED webhook", err);
    return new Response();
  }
};
