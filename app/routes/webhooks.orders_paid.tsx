/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ActionFunctionArgs } from "react-router";
import { authenticate, getAdminForShop } from "../shopify.server";
import { getStoreByDomain } from "../services/store.server";
import { getOrderByShopifyId, updateOrder } from "../services/order.server";
import { syncCompanyCreditMetafields } from "../services/metafieldSync.server";
import { Prisma } from "@prisma/client";
import prisma from "app/db.server";
import { getUserByShopifyCustomerId } from "app/services/user.server";
import { calculateAvailableCredit, validateTieredCreditForOrder } from "app/services/tieredCreditService";


/**
 * Perform post-payment credit validation locally
 */
async function triggerPostPaymentValidation(
  shop: string,
  orderId: string,
  shopifyOrderId: string,
  totalAmount: number,
  customerId?: string,
  companyId?: string
) {
  try {
    console.log(`🔍 Performing local post-payment validation for order ${shopifyOrderId}`);

    if (!companyId) {
      return { success: false, error: "Missing company ID" };
    }

    // Find the user who placed the order to get their tiered credit info
    const customerGid = `gid://shopify/Customer/${customerId}`;
    const store = await getStoreByDomain(shop);
    if (!store) {
      return { success: false, error: "Store not found" };
    }

    const user = await getUserByShopifyCustomerId(store.id, customerGid);
    if (!user) {
      // If we can't find the user, we'll still allow the paid order but log a warning
      console.warn(`⚠️ User not found for customer ${customerGid} during post-payment validation`);
      return { success: true, validationPassed: true };
    }

    // Perform tiered credit validation
    // We pass the current order's ID to exclude it from "used credit" calculation
    // because it was already created and might be counted twice otherwise
    const validation = await validateTieredCreditForOrder(
      companyId,
      user.id,
      totalAmount,
      shopifyOrderId
    );

    console.log(`Post-payment validation result:`, {
      orderId,
      shopifyOrderId,
      success: true,
      validationPassed: validation.canCreate,
      message: validation.message
    });

    return { 
      success: true, 
      validationPassed: validation.canCreate,
      error: validation.canCreate ? undefined : validation.message
    };
  } catch (error) {
    console.error("Failed to perform post-payment validation:", error);
    // On error, we fail safe and allow the order since it's already paid
    return { success: true, validationPassed: true, warning: "Validation error, allowed by default" };
  }
}

// Handle Shopify ORDERS_PAID webhook
export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic } = await authenticate.webhook(request);
  console.log(`🔔 Received ${topic} webhook for ${shop}`);

  try {
    if (!payload || !shop) return new Response();

    const store = await getStoreByDomain(shop);
    if (!store) return new Response();

    const orderIdNum = (payload as any).id as number | undefined;
    const orderNumber = (payload as any).order_number || (payload as any).number;
    const totalPriceStr = ((payload as any).total_price ?? (payload as any).current_total_price ?? "0") as string;
    const customerId = (payload as any).customer?.id;

    if (!orderIdNum) return new Response();

    const orderGid = `gid://shopify/Order/${orderIdNum}`;
    const totalAmount = parseFloat(totalPriceStr);

    // Find our B2B order
    const order = await getOrderByShopifyId(store.id, orderGid);
    if (!order) {
      console.log(`No B2B order found for Shopify order ${orderGid} - skipping post-payment validation`);
      return new Response();
    }

    console.log(`💳 PAYMENT RECEIVED - Starting post-payment credit validation:`, {
      b2bOrderId: order.id,
      shopifyOrderId: orderGid,
      orderNumber,
      totalAmount,
      companyId: order.companyId,
    });

    // **CRITICAL: POST-PAYMENT CREDIT VALIDATION**
    // This is where we validate credit AFTER payment was processed
    const validationResult = await triggerPostPaymentValidation(
      shop,
      order.id,
      orderGid,
      totalAmount,
      customerId?.toString(),
      order.companyId
    );

    if (validationResult.success && validationResult.validationPassed) {
      // ✅ Credit validation passed - order confirmed
      console.log(`✅ POST-PAYMENT VALIDATION PASSED - Order confirmed:`, {
        orderId: order.id,
        shopifyOrderId: orderGid,
        orderNumber,
      });

      // Update order status to reflect successful validation and payment
      // Note: Credit restoration is handled in webhooks.orders_updated.tsx to avoid duplicates
      
      await updateOrder(order.id, {
        paymentStatus: "paid",
        paidAmount: new Prisma.Decimal(totalAmount),
        creditUsed: new Prisma.Decimal(0),
        remainingBalance: new Prisma.Decimal(0),
        paidAt: new Date(),
      });
    } else {
      // ❌ Credit validation failed - order will be refunded/cancelled
      console.warn(`🚫 POST-PAYMENT VALIDATION FAILED - Order will be refunded:`, {
        orderId: order.id,
        shopifyOrderId: orderGid,
        reason: validationResult.error || "Credit validation failed",
      });

      // Update order to reflect the failure
      await updateOrder(order.id, {
        paymentStatus: "refunded",
        paidAmount: new Prisma.Decimal(0),
        remainingBalance: new Prisma.Decimal(totalAmount),
        notes: `Post-payment validation failed: ${validationResult.error}`,
      });
    }

    // Sync metafields after order payment to update creditUsed
    try {
      const shopAdmin = await getAdminForShop(shop);
      await syncCompanyCreditMetafields(shopAdmin as any, order.companyId!);
      console.log(`✅ Metafields synced for company ${order.companyId} after order payment`);
    } catch (syncError) {
      console.error(`⚠️ Failed to sync metafields after order payment:`, syncError);
      // Don't fail the webhook if sync fails
    }

    return new Response();
  } catch (err) {
    console.error("Failed to handle ORDERS_PAID webhook", err);
    return new Response();
  }
};
