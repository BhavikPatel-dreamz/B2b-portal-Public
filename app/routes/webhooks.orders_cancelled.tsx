/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getStoreByDomain } from "../services/store.server";
import { getOrderByShopifyId, updateOrder } from "../services/order.server";
import { restoreCredit } from "../services/creditService";

// Handle Shopify ORDERS_CANCELLED webhook
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

    const order = await getOrderByShopifyId(store.id, orderGid);
    if (!order) return new Response();

    // Restore any remaining balance to credit ledger
    try {
      if (order.remainingBalance) {
        await restoreCredit(order.companyId!, order.id, order.remainingBalance, "system", "cancelled");
      }
    } catch (creditErr) {
      console.error("Failed to restore credit on cancellation", creditErr);
    }

    // Mark the order as cancelled locally
    await updateOrder(order.id, {
      orderStatus: "cancelled",
      paymentStatus: "cancelled",
      remainingBalance: 0,
    });

    return new Response();
  } catch (err) {
    console.error("Failed to handle ORDERS_CANCELLED webhook", err);
    return new Response();
  }
};
