import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../../shopify.server";
import { getStoreByDomain } from "../../services/store.server";
import { calculateAvailableCredit } from "../../services/creditService";
import prisma from "../../db.server";
import { Decimal } from "@prisma/client/runtime/library";

interface ProcessPaymentRequest {
  orderId: string;
  shop: string;
  paymentAmount: number;
  paymentMethod?: string; // credit, card, bank_transfer, etc.
  notes?: string;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    await authenticate.public.appProxy(request);

    const requestData: ProcessPaymentRequest = await request.json();
    const { orderId, shop, paymentAmount, paymentMethod = "credit", notes } = requestData;

    // Validate required fields
    if (!orderId || !shop || !paymentAmount) {
      return Response.json(
        {
          error: "Missing required fields: orderId, shop, paymentAmount",
        },
        { status: 400 }
      );
    }

    if (paymentAmount <= 0) {
      return Response.json(
        { error: "Payment amount must be greater than 0" },
        { status: 400 }
      );
    }

    // Get store
    const store = await getStoreByDomain(shop);
    if (!store || !store.accessToken) {
      return Response.json({ error: "Store not found" }, { status: 404 });
    }

    // Get order with company info
    const order = await prisma.b2BOrder.findUnique({
      where: { id: orderId },
      include: {
        company: {
          select: {
            id: true,
            name: true,
            creditLimit: true,
          },
        },
        createdByUser: {
          select: {
            id: true,
            email: true,
          },
        },
      },
    });

    if (!order) {
      return Response.json({ error: "Order not found" }, { status: 404 });
    }

    if (order.shopId !== store.id) {
      return Response.json(
        { error: "Order does not belong to this store" },
        { status: 403 }
      );
    }

    // Check if order can accept payments
    if (order.orderStatus === "cancelled") {
      return Response.json(
        { error: "Cannot process payment for cancelled order" },
        { status: 400 }
      );
    }

    if (order.paymentStatus === "paid") {
      return Response.json(
        { error: "Order is already fully paid" },
        { status: 400 }
      );
    }

    // Validate payment amount doesn't exceed remaining balance
    const paymentAmountDecimal = new Decimal(paymentAmount);
    if (paymentAmountDecimal.greaterThan(order.remainingBalance)) {
      return Response.json(
        {
          error: "Payment amount exceeds remaining balance",
          remainingBalance: order.remainingBalance.toNumber(),
          attemptedPayment: paymentAmount,
        },
        { status: 400 }
      );
    }

    // Process payment in a transaction
    try {
      const result = await prisma.$transaction(async (tx) => {
        // Create OrderPayment record
        const payment = await tx.orderPayment.create({
          data: {
            orderId: order.id,
            amount: paymentAmountDecimal,
            method: paymentMethod,
            status: "received",
            receivedAt: new Date(),
          },
        });

        // Calculate new balances
        const newPaidAmount = order.paidAmount.plus(paymentAmountDecimal);
        const newRemainingBalance = order.remainingBalance.minus(paymentAmountDecimal);

        // Determine new payment status
        let newPaymentStatus = "partial";
        let paidAt = null;

        if (newRemainingBalance.lessThanOrEqualTo(0)) {
          newPaymentStatus = "paid";
          paidAt = new Date();
        }

        // Update order
        const updatedOrder = await tx.b2BOrder.update({
          where: { id: order.id },
          data: {
            paidAmount: newPaidAmount,
            remainingBalance: newRemainingBalance,
            paymentStatus: newPaymentStatus,
            paidAt,
          },
        });

        // Get current credit info before transaction
        const creditInfoBefore = await calculateAvailableCredit(order.companyId);
        const previousBalance = creditInfoBefore?.availableCredit || new Decimal(0);

        // Create CreditTransaction log
        const creditTransaction = await tx.creditTransaction.create({
          data: {
            companyId: order.companyId,
            orderId: order.id,
            transactionType: "payment_received",
            creditAmount: paymentAmountDecimal, // Positive amount
            previousBalance,
            newBalance: previousBalance.plus(paymentAmountDecimal),
            notes: notes
              ? `Payment received: ${notes}`
              : `Payment of ${paymentAmount} received for order ${orderId}`,
            createdBy: order.createdByUserId,
          },
        });

        // If fully paid, remove from pending credit and add back to available credit
        // This is automatically handled by the calculateAvailableCredit function
        // since it checks paymentStatus and orderStatus

        return {
          payment,
          updatedOrder,
          creditTransaction,
        };
      });

      // Get updated credit info after payment
      const updatedCreditInfo = await calculateAvailableCredit(order.companyId);

      return Response.json(
        {
          success: true,
          payment: {
            id: result.payment.id,
            amount: paymentAmount,
            method: paymentMethod,
            status: result.payment.status,
            receivedAt: result.payment.receivedAt,
          },
          order: {
            id: result.updatedOrder.id,
            orderTotal: result.updatedOrder.orderTotal.toNumber(),
            paidAmount: result.updatedOrder.paidAmount.toNumber(),
            remainingBalance: result.updatedOrder.remainingBalance.toNumber(),
            paymentStatus: result.updatedOrder.paymentStatus,
            orderStatus: result.updatedOrder.orderStatus,
            paidAt: result.updatedOrder.paidAt,
          },
          creditInfo: {
            creditLimit: updatedCreditInfo?.creditLimit.toNumber() || 0,
            availableCredit: updatedCreditInfo?.availableCredit.toNumber() || 0,
            usedCredit: updatedCreditInfo?.usedCredit.toNumber() || 0,
            pendingCredit: updatedCreditInfo?.pendingCredit.toNumber() || 0,
          },
          message:
            result.updatedOrder.paymentStatus === "paid"
              ? "Payment received - Order fully paid"
              : "Partial payment received",
        },
        { status: 200 }
      );
    } catch (error: any) {
      console.error("Error processing payment:", error);
      return Response.json(
        {
          error: "Failed to process payment",
          details: error.message,
        },
        { status: 500 }
      );
    }
  } catch (error: any) {
    console.error("Error in payment processing endpoint:", error);
    return Response.json(
      {
        error: "Internal server error",
        details: error.message,
      },
      { status: 500 }
    );
  }
};
