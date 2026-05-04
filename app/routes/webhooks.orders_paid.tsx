/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getStoreByDomain } from "../services/store.server";
import { getOrderByShopifyId, updateOrder } from "../services/order.server";

import { Prisma } from "@prisma/client";
import prisma from "app/db.server";
import { getUserByShopifyCustomerId } from "app/services/user.server";
import { calculateAvailableCredit } from "app/services/tieredCreditService";


/**
 * Trigger post-payment credit validation
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
    // Call our post-payment validation endpoint
    const validationUrl = `${process.env.SHOPIFY_APP_URL}/api/proxy/post-payment-validate`;

    const response = await fetch(validationUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        orderId,
        shopifyOrderId,
        totalAmount,
        customerId,
        companyId,
        shop,
      }),
    });

    const result = await response.json();

    console.log(`Post-payment validation result:`, {
      orderId,
      shopifyOrderId,
      success: result.success,
      validationPassed: result.validationPassed,
    });

    return result;
  } catch (error) {
    console.error("Failed to trigger post-payment validation:", error);
    return { success: false, error: "Validation trigger failed" };
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
      });

      // Update order status to reflect successful validation and payment
      // **NEW: Create credit restoration transaction for order_paid (BEFORE updating order)**

      
      const customerGid = `gid://shopify/Customer/${customerId}`;
      const orderUser = await getUserByShopifyCustomerId(store.id, customerGid);
      const createdBy = orderUser?.id || "system";
      
      const creditInfo = await calculateAvailableCredit(order.companyId!);
      if (creditInfo) {
        const restoreAmount = order.creditUsed || new Prisma.Decimal(totalAmount);
        const previousBalance = creditInfo.availableCredit;
        const newBalance = previousBalance.plus(restoreAmount);
        
        await prisma.creditTransaction.create({
          data: {
            companyId: order.companyId!,
            orderId: order.id,
            transactionType: "order_paid",
            creditAmount: restoreAmount,
            previousBalance,
            newBalance,
            notes: `Credit restored for paid order #${order.id}`,
            createdBy,
          },
        });
        console.log(`✅ Created order_paid credit transaction: +${restoreAmount} | ${previousBalance} → ${newBalance}`);
      }
      
      await updateOrder(order.id, {
        paymentStatus: "paid",
        paidAmount: new Prisma.Decimal(totalAmount),
        remainingBalance: new Prisma.Decimal(0),
        paidAt: new Date(),
      });
  

  // Removed broken transaction code


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

    return new Response();
  } catch (err) {
    console.error("Failed to handle ORDERS_PAID webhook", err);
    return new Response();
  }
};
