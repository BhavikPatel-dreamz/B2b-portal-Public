/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getStoreByDomain } from "../services/store.server";
import { getOrderByShopifyId, updateOrder } from "../services/order.server";
import { Prisma } from "@prisma/client";

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

    // Since order_edit webhook doesn't have full order details,
    // we need to fetch order from Shopify to get current status/totals
    const adminSession = await authenticate.admin(request);
    if (!adminSession) return new Response();

    const orderQuery = `
      query GetOrder($id: ID!) {
        order(id: $id) {
          id
          totalPriceSet {
            shopMoney {
              amount
            }
          }
          financialStatus
          fulfillmentStatus
        }
      }
    `;

    const response = await adminSession.graphql(orderQuery, {
      variables: { id: orderGid },
    });
    const result = await response.json();
    const order = result?.data?.order;
    if (!order) return new Response();

    // Map statuses from Shopify
    const financialStatus = order.financialStatus as string | undefined;
    const fulfillmentStatus = order.fulfillmentStatus as string | undefined;
    let paymentStatus: string = "pending";
    switch (financialStatus) {
      case "PAID":
        paymentStatus = "paid";
        break;
      case "PARTIALLY_PAID":
        paymentStatus = "partial";
        break;
      case "REFUNDED":
      case "VOIDED":
        paymentStatus = "cancelled";
        break;
      default:
        paymentStatus = "pending";
    }

    let orderStatus: string = "submitted";
    switch (fulfillmentStatus) {
      case "FULFILLED":
        orderStatus = "delivered";
        break;
      case "PARTIAL":
      case "IN_PROGRESS":
        orderStatus = "processing";
        break;
      case "CANCELLED":
        orderStatus = "cancelled";
        break;
      default:
        orderStatus = "submitted";
    }

    const orderTotal = new Prisma.Decimal(
      order.totalPriceSet?.shopMoney?.amount ?? "0",
    );
    const currentPaid = existing.paidAmount ?? new Prisma.Decimal(0);
    const paidAmount = paymentStatus === "paid" ? orderTotal : currentPaid;
    const remainingBalance = orderTotal.minus(paidAmount);

    // Update existing order via service
    await updateOrder(existing.id, {
      orderTotal,
      paymentStatus,
      orderStatus: paymentStatus === "cancelled" ? "cancelled" : orderStatus,
      paidAmount,
      remainingBalance,
      paidAt:
        paymentStatus === "paid"
          ? existing.paidAt ?? new Date()
          : remainingBalance.isZero()
            ? existing.paidAt ?? new Date()
            : existing.paidAt,
    });

    return new Response();
  } catch (err) {
    console.error("Failed to handle ORDERS_EDITED webhook", err);
    return new Response();
  }
};
