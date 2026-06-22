/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getStoreByDomain } from "../services/store.server";
import { getOrderByShopifyId } from "../services/order.server";

// Handle Shopify ORDERS_EDITED webhook
export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    if (!payload || !shop) return new Response();

    const store = await getStoreByDomain(shop);
    if (!store) return new Response();

    // Extract order ID from order_edit wrapper
    const orderIdNum = (payload as any).order_edit?.order_id as number | undefined;
    if (!orderIdNum) return new Response();

    const orderGid = `gid://shopify/Order/${orderIdNum}`;

    // Find existing order in our DB
    const existing = await getOrderByShopifyId(store.id, orderGid);

    // Only sync if order exists and belongs to a registered B2B company
    if (!existing?.companyId) return new Response();

    console.log("ℹ️ ORDERS_EDITED webhook acknowledged without local status sync", {
      orderId: existing.id,
      shopifyOrderId: orderGid,
      currentPaymentStatus: existing.paymentStatus,
      currentOrderStatus: existing.orderStatus,
    });

    return new Response();
  } catch (err) {
    console.error("Failed to handle ORDERS_EDITED webhook", err);
    return new Response();
  }
};
