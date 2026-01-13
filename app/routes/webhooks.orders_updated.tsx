/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getStoreByDomain } from "../services/store.server";
import { getOrderByShopifyId, updateOrder } from "../services/order.server";
import { validateTieredCreditForOrder, restoreTieredCredit } from "../services/tieredCreditService";
import { getUserByShopifyCustomerId } from "../services/user.server";
import { calculateAvailableCredit } from "../services/creditService";
import { Prisma } from "@prisma/client";

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("orders/updated webhook received");
  try {
    const { payload, shop, topic } = await authenticate.webhook(request);
    console.log(`🔔 Received ${topic} webhook for ${shop},${JSON.stringify(payload)}`);

    // If an outdated subscription points to this path, ignore gracefully
    if (topic !== "ORDERS_UPDATED" && topic !== "ORDERS_EDITED") {
      console.info(`Webhook topic ${topic} hit orders/updated route. Ignoring.`);
      return new Response(null, { status: 200 });
    }

    // Basic validation
    if (!payload || !shop) {
      return new Response("Invalid webhook payload", { status: 400 });
    }

    // Load store by shop domain
    const store = await getStoreByDomain(shop);
    if (!store) {
      console.warn(`Store not found for domain ${shop} — skipping B2B order update`);
      return new Response(null, { status: 200 });
    }

    // Extract order data from webhook payload
    const customer = (payload as any).customer;
    const orderIdNum = (payload as any).id as number | undefined;
    const financialStatus = (payload as any).financial_status as string | undefined;
    const fulfillmentStatus = (payload as any).fulfillment_status as string | undefined;
    const totalPriceStr = ((payload as any).current_total_price ?? (payload as any).total_price ?? "0") as string; // Use current_total_price first (after refunds)
    const originalTotalPrice = (payload as any).total_price as string;
    const cancelledAt = (payload as any).cancelled_at;
    const updatedAt = (payload as any).updated_at;
    const confirmedStatus = (payload as any).confirmed;
    const currency = (payload as any).currency || (payload as any).presentment_currency;
    const orderNumber = (payload as any).order_number || (payload as any).number;
    const paymentTerms = (payload as any).payment_terms;
    const totalOutstanding = (payload as any).total_outstanding;
    const refunds = (payload as any).refunds || [];
    const paidAmount = (() => {
      if (totalOutstanding !== undefined) {
        // Calculate paid amount as total - outstanding
        return new Prisma.Decimal(totalPriceStr).minus(new Prisma.Decimal(totalOutstanding));
      } else if (financialStatus === "paid") {
        // If marked as paid but no outstanding info, assume fully paid
        return new Prisma.Decimal(totalPriceStr);
      } else {
        // Default to 0 for pending/unpaid orders
        return new Prisma.Decimal(0);
      }
    })();
    if (!customer || !customer.id || !orderIdNum) {
      console.info("Order has no customer or ID; skipping B2B order update");
      return new Response(null, { status: 200 });
    }

    const customerGid = `gid://shopify/Customer/${customer.id}`;
    const orderGid = `gid://shopify/Order/${orderIdNum}`;

    {
      console.log(`🔍 Processing B2B order update for Shopify order ID: ${orderGid}, Customer ID: ${store},${orderIdNum}`);
    }
    // Find our existing B2B order
    const existingOrder = await getOrderByShopifyId(store.id, orderGid);
    if (!existingOrder) {
      console.info(`No B2B order found for Shopify order ${orderGid} - skipping update`);
      return new Response(null, { status: 200 });
    }

    console.log(`📝 Updating B2B order:`, {
      orderId: existingOrder.id,
      shopifyOrderId: orderGid,
      orderNumber: orderNumber,
      currency: currency,
      originalTotalPrice: originalTotalPrice,
      currentTotalPrice: totalPriceStr,
      totalOutstanding: totalOutstanding,
      calculatedPaidAmount: paidAmount.toString(),
      existingCreditUsed: existingOrder.creditUsed?.toString() || '0',
      newFinancialStatus: financialStatus,
      newFulfillmentStatus: fulfillmentStatus,
      confirmed: confirmedStatus,
      updatedAt: updatedAt,
      refundsCount: refunds.length,
      paymentTerms: paymentTerms ? {
        dueInDays: paymentTerms.due_in_days,
        type: paymentTerms.payment_terms_type,
        name: paymentTerms.payment_terms_name
      } : null
    });

    // Find portal user for this shop + customer
    const user = await getUserByShopifyCustomerId(store.id, customerGid);
    if (!user || !user.companyId) {
      console.info(`No mapped B2B user/company for customer ${customerGid} - skipping credit processing`);
      return new Response(null, { status: 200 });
    }

    // Map Shopify statuses to our local statuses
    let paymentStatus: string = "pending";
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

    let orderStatus: string = "submitted";
    if (cancelledAt) {
      orderStatus = "cancelled";
    } else {
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
    }

    const orderTotal = new Prisma.Decimal(totalPriceStr);
    const previousPaymentStatus = existingOrder.paymentStatus;

    // Handle payment status transitions
    if (previousPaymentStatus !== paymentStatus) {
      console.log(`💳 Payment status changed from ${previousPaymentStatus} to ${paymentStatus}`);

      try {
        if (paymentStatus === "paid" && (previousPaymentStatus === "pending" || previousPaymentStatus === "partial")) {
          // Order was paid - validate and finalize credit deduction
          console.log(`✅ Order payment confirmed - finalizing credit deduction for amount: ${orderTotal.toString()}`);

          const validation = await validateTieredCreditForOrder(
            user.companyId,
            user.id,
            orderTotal.toNumber()
          );

          if (!validation.canCreate) {
            console.warn(`❌ Post-payment credit validation failed:`, {
              orderId: existingOrder.id,
              reason: validation.message
            });

            // Update order with validation failure but still mark as paid
            await updateOrder(existingOrder.id, {
              paymentStatus: "paid",
              orderStatus: "paid",
              orderTotal: new Prisma.Decimal(totalPriceStr),
              paidAmount: new Prisma.Decimal(totalPriceStr), // Fully paid amount
              creditUsed: new Prisma.Decimal(0), // No credit used when fully paid
              remainingBalance: new Prisma.Decimal(0), // No remaining balance since it's paid
              paidAt: new Date(),
              updatedAt: updatedAt ? new Date(updatedAt) : new Date(),
              notes: `Post-payment credit validation failed: ${validation.message}. Requires manual review.`
            });
          } else {
            // Credit validation passed - order is fully processed
            //const unpaidAmount = orderTotal.minus(new Prisma.Decimal(totalPriceStr)); // Amount charged to company credit
            await updateOrder(existingOrder.id, {
              paymentStatus: "paid",
              orderStatus: "paid",
              orderTotal: new Prisma.Decimal(totalPriceStr),
              paidAmount: new Prisma.Decimal(totalPriceStr), // Fully paid amount
              creditUsed: new Prisma.Decimal(0), // No credit used when fully paid
              remainingBalance: new Prisma.Decimal(0), // No remaining balance since it's paid
              paidAt: new Date(),
              updatedAt: updatedAt ? new Date(updatedAt) : new Date(),
            });

            console.log(`✅ B2B order payment processed successfully:`, {
              orderTotal: totalPriceStr,
              paidAmount: totalPriceStr,
              creditUsed: "0", // No credit used when fully paid
              remainingBalance: "0"
            });
          }

        } else if (paymentStatus === "cancelled" || orderStatus === "cancelled") {
          // Order was cancelled - refund reserved credit
          console.log(`❌ Order cancelled - refunding reserved credit`);

          try {
            const creditToRefund = existingOrder.creditUsed ? existingOrder.creditUsed.toNumber() : 0;

            if (creditToRefund > 0) {
              await restoreTieredCredit(
                user.companyId,
                user.id,
                orderGid,
                creditToRefund,
                "cancelled"
              );
            }

            await updateOrder(existingOrder.id, {
              paymentStatus: "cancelled",
              orderStatus: "cancelled",
              orderTotal: new Prisma.Decimal(totalPriceStr),
              creditUsed: new Prisma.Decimal(0),
              remainingBalance: new Prisma.Decimal(totalPriceStr),
              updatedAt: updatedAt ? new Date(updatedAt) : new Date(),
              notes: `Order cancelled - ${creditToRefund > 0 ? 'credit refunded' : 'no credit to refund'}`
            });

            console.log(`✅ Credit refunded for cancelled order`);
          } catch (refundError) {
            console.error(`Failed to refund credit for cancelled order:`, refundError);
          }

        } else if (paymentStatus === "partial") {
          // Partial payment - credit used is the unpaid amount
          const unpaidAmount = orderTotal.minus(paidAmount);

          // Calculate company's remaining credit balance after this order
          const companyCredit = await calculateAvailableCredit(user.companyId);
          const companyRemainingBalance = companyCredit ? companyCredit.availableCredit.minus(unpaidAmount) : new Prisma.Decimal(0);

          await updateOrder(existingOrder.id, {
            paymentStatus: "partial",
            orderStatus: "submitted",
            orderTotal: new Prisma.Decimal(totalPriceStr),
            paidAmount: paidAmount,
            creditUsed: unpaidAmount, // Credit used is the unpaid portion
            remainingBalance: companyRemainingBalance, // Company's remaining credit balance
            updatedAt: updatedAt ? new Date(updatedAt) : new Date(),
          });

          console.log(`💰 Partial payment processed:`, {
            orderTotal: totalPriceStr,
            paidAmount: paidAmount.toString(),
            creditUsed: unpaidAmount.toString(), // Unpaid amount charged to credit
            companyRemainingBalance: companyRemainingBalance.toString()
          });

        } else {
          // Other status changes - update all relevant order details

          const creditToUse = paymentStatus === "paid" ? orderTotal : paidAmount;

          // Calculate company's remaining credit balance after this order
          const unpaidAmount = orderTotal.minus(paidAmount);
          const companyCredit = await calculateAvailableCredit(user.companyId);
          const companyRemainingBalance = companyCredit ? companyCredit.availableCredit.minus(unpaidAmount) : new Prisma.Decimal(0);

          await updateOrder(existingOrder.id, {
            paymentStatus,
            orderStatus,
            orderTotal: orderTotal,
            paidAmount: paidAmount,
            creditUsed: creditToUse, // Credit used based on payment status
            remainingBalance: companyRemainingBalance, // Company's remaining credit balance
            updatedAt: updatedAt ? new Date(updatedAt) : new Date(),
            notes: paymentTerms ?
              `Payment Terms: ${paymentTerms.payment_terms_name || 'Net'} ${paymentTerms.due_in_days || 0} days` :
              undefined
          });

          console.log(`🔄 Order details updated:`, {
            paymentStatus,
            orderStatus,
            orderTotal: orderTotal.toString(),
            paidAmount: paidAmount.toString(),
            creditUsed: creditToUse.toString(),
            companyRemainingBalance: companyRemainingBalance.toString(),
            currency: currency
          });
        }

      } catch (error) {
        console.error(`Failed to process payment status change:`, error);
        // Still update basic order info with current totals

        const creditToUse = paymentStatus === "paid" ? orderTotal : paidAmount;

        // Calculate company's remaining credit balance after this order
        const unpaidAmount = orderTotal.minus(paidAmount);
        const companyCredit = await calculateAvailableCredit(user.companyId);
        const companyRemainingBalance = companyCredit ? companyCredit.availableCredit.minus(unpaidAmount) : new Prisma.Decimal(0);

        await updateOrder(existingOrder.id, {
          paymentStatus,
          orderStatus,
          orderTotal: new Prisma.Decimal(totalPriceStr),
          paidAmount: paidAmount,
          creditUsed: creditToUse,
          remainingBalance: companyRemainingBalance, // Company's remaining credit balance
          updatedAt: updatedAt ? new Date(updatedAt) : new Date(),
          notes: `Status update error: ${error instanceof Error ? error.message : 'Unknown error'}`
        });
      }

    } else {
      // Only fulfillment status changed - but still update all order details to keep in sync
      const unpaidAmount = orderTotal.minus(paidAmount);

      // Calculate company's remaining credit balance after this order
      const companyCredit = await calculateAvailableCredit(user.companyId);
      const companyRemainingBalance = companyCredit ? companyCredit.availableCredit.minus(unpaidAmount) : new Prisma.Decimal(0);

      await updateOrder(existingOrder.id, {
        orderStatus,
        orderTotal: new Prisma.Decimal(totalPriceStr),
        paidAmount: paidAmount,
        creditUsed: unpaidAmount, // Credit used is unpaid amount
        remainingBalance: companyRemainingBalance, // Company's remaining credit balance
        updatedAt: updatedAt ? new Date(updatedAt) : new Date(),
        notes: paymentTerms ?
          `Payment Terms: ${paymentTerms.payment_terms_name || 'Net'} ${paymentTerms.due_in_days || 0} days` :
          undefined
      });

      console.log(`📦 Updated fulfillment status to ${orderStatus} and synced all order details:`, {
        orderTotal: totalPriceStr,
        paidAmount: paidAmount.toString(),
        creditUsed: unpaidAmount.toString(),
        companyRemainingBalance: companyRemainingBalance.toString()
      });
    }

    return new Response(null, { status: 200 });

  } catch (verifyErr) {
    let headers: Record<string, string> | undefined;
    try {
      headers = Object.fromEntries(request.headers.entries());
    } catch (e) {
      // ignore header logging failure
    }
    console.error("Webhook verification failed for orders/updated", verifyErr, headers ? { headers } : undefined);
    return new Response("Unauthorized", { status: 401 });
  }
};
