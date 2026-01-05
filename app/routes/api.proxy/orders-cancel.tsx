import type { ActionFunctionArgs } from "react-router";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../../shopify.server";
import { getStoreByDomain } from "../../services/store.server";
import { restoreCredit, calculateAvailableCredit } from "../../services/creditService";
import prisma from "../../db.server";

interface CancelOrderRequest {
  orderId: string;
  shop: string;
  reason?: string;
  userId?: string; // User requesting the cancellation
}

/**
 * Cancel a draft order in Shopify
 */
async function cancelShopifyDraftOrder(admin: AdminApiContext, draftOrderId: string) {
  const mutation = `
    mutation draftOrderDelete($input: DraftOrderDeleteInput!) {
      draftOrderDelete(input: $input) {
        deletedId
        userErrors {
          field
          message
        }
      }
    }
  `;

  try {
    const response = await admin.graphql(mutation, {
      variables: {
        input: {
          id: draftOrderId,
        },
      },
    });
    const jsonData = await response.json();
    const data = jsonData as {
      data?: {
        draftOrderDelete?: {
          deletedId: string;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      };
      errors?: Array<{ message: string }>;
    };

    if (data.errors) {
      console.error("Shopify GraphQL errors:", data.errors);
      return { success: false, error: data.errors[0].message };
    }

    if (data.data?.draftOrderDelete?.userErrors && data.data.draftOrderDelete.userErrors.length > 0) {
      const errors = data.data.draftOrderDelete.userErrors;
      console.error("Shopify user errors:", errors);
      return { success: false, error: errors[0].message };
    }

    return {
      success: true,
      deletedId: data.data?.draftOrderDelete?.deletedId || "",
    };
  } catch (error) {
    console.error("Error cancelling Shopify draft order:", error);
    return { success: false, error: "Failed to cancel draft order in Shopify" };
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const { admin } = await authenticate.public.appProxy(request);

    const requestData: CancelOrderRequest = await request.json();
    const { orderId, shop, userId } = requestData;

    // Validate required fields
    if (!orderId || !shop) {
      return Response.json(
        {
          error: "Missing required fields: orderId, shop",
        },
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

    // Check if order is already cancelled
    if (order.orderStatus === "cancelled") {
      return Response.json(
        { error: "Order is already cancelled" },
        { status: 400 }
      );
    }

    // Check if order can be cancelled (not shipped/delivered)
    const nonCancellableStatuses = ["shipped", "delivered"];
    if (nonCancellableStatuses.includes(order.orderStatus)) {
      return Response.json(
        {
          error: `Cannot cancel order with status: ${order.orderStatus}`,
          currentStatus: order.orderStatus,
        },
        { status: 400 }
      );
    }

    // Determine who initiated the cancellation
    const cancelledBy = userId || order.createdByUserId;

    // Process cancellation in a transaction
    try {
      const result = await prisma.$transaction(async (tx) => {
        // Update order status
        const updatedOrder = await tx.b2BOrder.update({
          where: { id: orderId },
          data: {
            orderStatus: "cancelled",
            paymentStatus: "cancelled",
          },
        });

        // If order has unpaid/partial balance, restore credit
        let creditRestored = false;
        let creditTransaction = null;

        if (
          (order.paymentStatus === "pending" || order.paymentStatus === "partial") &&
          order.remainingBalance.greaterThan(0)
        ) {
          // Restore credit for the remaining balance
          await restoreCredit(
            order.companyId,
            orderId,
            order.remainingBalance,
            cancelledBy,
            "cancelled"
          );

          creditRestored = true;

          // Get the transaction we just created
          creditTransaction = await tx.creditTransaction.findFirst({
            where: {
              companyId: order.companyId,
              orderId,
              transactionType: "order_cancelled",
            },
            orderBy: {
              createdAt: "desc",
            },
          });
        }

        // Cancel/delete draft order in Shopify if it exists
        let shopifyResult = null;
        if (order.shopifyOrderId && admin) {
          shopifyResult = await cancelShopifyDraftOrder(admin, order.shopifyOrderId);

          if (!shopifyResult.success) {
            console.warn(
              `Failed to cancel Shopify draft order ${order.shopifyOrderId}:`,
              shopifyResult.error
            );
            // Continue with cancellation even if Shopify sync fails
            // The order is marked as cancelled in our system
          }
        }

        return {
          updatedOrder,
          creditRestored,
          creditTransaction,
          shopifyResult,
        };
      });

      // Get updated credit info after cancellation
      const updatedCreditInfo = await calculateAvailableCredit(order.companyId);

      return Response.json(
        {
          success: true,
          order: {
            id: result.updatedOrder.id,
            orderStatus: result.updatedOrder.orderStatus,
            paymentStatus: result.updatedOrder.paymentStatus,
            orderTotal: result.updatedOrder.orderTotal.toNumber(),
            paidAmount: result.updatedOrder.paidAmount.toNumber(),
            remainingBalance: result.updatedOrder.remainingBalance.toNumber(),
          },
          creditRestored: result.creditRestored,
          creditInfo: {
            creditLimit: updatedCreditInfo?.creditLimit.toNumber() || 0,
            availableCredit: updatedCreditInfo?.availableCredit.toNumber() || 0,
            usedCredit: updatedCreditInfo?.usedCredit.toNumber() || 0,
            pendingCredit: updatedCreditInfo?.pendingCredit.toNumber() || 0,
          },
          shopifySynced: result.shopifyResult?.success || false,
          message: result.creditRestored
            ? `Order cancelled successfully. Credit of ${order.remainingBalance} restored.`
            : "Order cancelled successfully",
        },
        { status: 200 }
      );
    } catch (error) {
      console.error("Error cancelling order:", error);
      return Response.json(
        {
          error: "Failed to cancel order",
          details: error instanceof Error ? error.message : "Unknown error",
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error("Error in order cancellation endpoint:", error);
    return Response.json(
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
};
