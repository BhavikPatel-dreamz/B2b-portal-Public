import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../../shopify.server";
import { getStoreByDomain } from "../../services/store.server";
import {
  calculateAvailableCredit,
  validateTieredCreditForOrder,
  deductTieredCredit,
} from "../../services/tieredCreditService";

import prisma from "../../db.server";
import { Decimal } from "@prisma/client/runtime/library";

interface OrderItem {
  variantId: string;
  quantity: number;
  price: number;
  title?: string;
}

interface CreateOrderRequest {
  companyId: string;
  customerId: string;
  shop: string;
  orderItems: OrderItem[];
  totalAmount: number;
  shippingAddress?: {
    firstName?: string;
    lastName?: string;
    address1: string;
    address2?: string;
    city: string;
    province: string;
    country: string;
    zip: string;
    phone?: string;
  };
  notes?: string;
}

/**
 * Create a draft order in Shopify
 */
async function createShopifyDraftOrder(
  admin: any,
  orderData: {
    customerId: string;
    lineItems: Array<{ variantId: string; quantity: number }>;
    shippingAddress?: any;
    note?: string;
  }
) {
  const mutation = `
    mutation draftOrderCreate($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id
          name
          totalPrice
          subtotalPrice
          totalTax
          createdAt
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const lineItems = orderData.lineItems.map((item) => ({
    variantId: item.variantId,
    quantity: item.quantity,
  }));

  const input: any = {
    customerId: orderData.customerId,
    lineItems,
  };

  if (orderData.shippingAddress) {
    input.shippingAddress = orderData.shippingAddress;
  }

  if (orderData.note) {
    input.note = orderData.note;
  }

  try {
    const response = await admin.graphql(mutation, {
      variables: { input },
    });
    const data = await response.json();

    if (data.errors) {
      console.error("Shopify GraphQL errors:", data.errors);
      return { success: false, error: data.errors[0].message };
    }

    if (data.data?.draftOrderCreate?.userErrors?.length > 0) {
      const errors = data.data.draftOrderCreate.userErrors;
      console.error("Shopify user errors:", errors);
      return { success: false, error: errors[0].message };
    }

    return {
      success: true,
      draftOrder: data.data?.draftOrderCreate?.draftOrder,
    };
  } catch (error) {
    console.error("Error creating Shopify draft order:", error);
    return { success: false, error: "Failed to create draft order in Shopify" };
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const { admin } = await authenticate.public.appProxy(request);

    const requestData: CreateOrderRequest = await request.json();
    const { companyId, customerId, shop, orderItems, totalAmount, shippingAddress, notes } =
      requestData;

    // Validate required fields
    if (!companyId || !customerId || !shop || !orderItems || !totalAmount) {
      return Response.json(
        {
          error: "Missing required fields: companyId, customerId, shop, orderItems, totalAmount",
        },
        { status: 400 }
      );
    }

    if (!Array.isArray(orderItems) || orderItems.length === 0) {
      return Response.json(
        { error: "orderItems must be a non-empty array" },
        { status: 400 }
      );
    }

    // Get store
    const store = await getStoreByDomain(shop);
    if (!store || !store.accessToken) {
      return Response.json({ error: "Store not found" }, { status: 404 });
    }

    // Get company
    const company = await prisma.companyAccount.findUnique({
      where: { id: companyId },
      select: {
        id: true,
        name: true,
        shopId: true,
        creditLimit: true,
      },
    });

    if (!company) {
      return Response.json({ error: "Company not found" }, { status: 404 });
    }

    if (company.shopId !== store.id) {
      return Response.json(
        { error: "Company does not belong to this store" },
        { status: 403 }
      );
    }

    // Verify user belongs to company and get user info
    const user = await prisma.user.findFirst({
      where: {
        companyId,
        isActive: true,
        status: "APPROVED",
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        userCreditLimit: true,
        userCreditUsed: true,
      },
    });

    if (!user) {
      return Response.json(
        { error: "No active user found for this company" },
        { status: 403 }
      );
    }

    // Check if company is active (has credit limit > 0)
    if (company.creditLimit.lessThanOrEqualTo(0)) {
      return Response.json(
        { error: "Company account is suspended or has no credit limit" },
        { status: 403 }
      );
    }

    // Use tiered credit validation (checks both company and user limits)
    const creditValidation = await validateTieredCreditForOrder(
      companyId,
      user.id,
      totalAmount
    );

    if (!creditValidation.canCreate) {
      const shortfallAmount = creditValidation.creditInfo
        ? new Decimal(totalAmount).minus(
            creditValidation.limitingFactor === "company"
              ? creditValidation.creditInfo.company.availableCredit
              : creditValidation.creditInfo.user.userCreditAvailable
          ).toNumber()
        : totalAmount;

      return Response.json(
        {
          error: "Insufficient credit",
          message: creditValidation.message,
          limitingFactor: creditValidation.limitingFactor,
          availableCredit: creditValidation.creditInfo
            ? (creditValidation.limitingFactor === "company"
                ? creditValidation.creditInfo.company.availableCredit.toNumber()
                : creditValidation.creditInfo.user.userCreditAvailable.toNumber())
            : 0,
          requiredAmount: totalAmount,
          shortfall: shortfallAmount,
          userInfo: creditValidation.creditInfo ? {
            hasUserLimit: creditValidation.creditInfo.user.hasUserLimit,
            userCreditAvailable: creditValidation.creditInfo.user.userCreditAvailable.toNumber(),
            userCreditLimit: creditValidation.creditInfo.user.userCreditLimit?.toNumber() || null,
          } : null,
        },
        { status: 400 }
      );
    }

    // Start transaction to create order
    let b2bOrder;
    let shopifyDraftOrder;

    try {
      // Create B2B Order in database with status "draft"
      b2bOrder = await prisma.b2BOrder.create({
        data: {
          companyId,
          createdByUserId: user.id,
          shopId: store.id,
          orderTotal: new Decimal(totalAmount),
          creditUsed: new Decimal(0), // Will be set by deductCredit
          userCreditUsed: new Decimal(0), // Add required field
          paymentStatus: "pending",
          orderStatus: "draft",
          remainingBalance: new Decimal(totalAmount),
          paidAmount: new Decimal(0),
        },
      });

      // Deduct credit and create transaction log
      await deductTieredCredit(companyId, user.id, b2bOrder.id, totalAmount, "order_created");

      // Create draft order in Shopify
      const shopifyResult = await createShopifyDraftOrder(admin, {
        customerId,
        lineItems: orderItems.map((item) => ({
          variantId: item.variantId,
          quantity: item.quantity,
        })),
        shippingAddress,
        note: notes
          ? `B2B Order #${b2bOrder.id}\n${notes}`
          : `B2B Order #${b2bOrder.id}`,
      });

      if (!shopifyResult.success) {
        // Rollback: Delete the B2B order and restore credit
        await prisma.b2BOrder.delete({ where: { id: b2bOrder.id } });

        // Restore credit by creating a reversal transaction
        await prisma.creditTransaction.create({
          data: {
            companyId,
            orderId: b2bOrder.id,
            transactionType: "order_cancelled",
            creditAmount: new Decimal(totalAmount),
            previousBalance: new Decimal(0), // Will be recalculated
            newBalance: new Decimal(0), // Will be recalculated
            notes: `Order creation failed - Shopify sync error. Credit restored.`,
            createdBy: "system",
          },
        });

        return Response.json(
          {
            error: "Failed to sync order with Shopify",
            details: shopifyResult.error,
          },
          { status: 500 }
        );
      }

      shopifyDraftOrder = shopifyResult.draftOrder;

      // Update B2B order with Shopify draft order ID
      await prisma.b2BOrder.update({
        where: { id: b2bOrder.id },
        data: {
          shopifyOrderId: shopifyDraftOrder.id,
          orderStatus: "submitted",
        },
      });

      // Get updated credit info
      const updatedCreditInfo = await calculateAvailableCredit(companyId);

      return Response.json(
        {
          success: true,
          order: {
            id: b2bOrder.id,
            shopifyOrderId: shopifyDraftOrder.id,
            shopifyOrderName: shopifyDraftOrder.name,
            orderTotal: totalAmount,
            paymentStatus: "pending",
            orderStatus: "submitted",
            createdAt: b2bOrder.createdAt,
          },
          creditInfo: {
            creditLimit: updatedCreditInfo?.creditLimit.toNumber() || 0,
            availableCredit: updatedCreditInfo?.availableCredit.toNumber() || 0,
            usedCredit: updatedCreditInfo?.usedCredit.toNumber() || 0,
            pendingCredit: updatedCreditInfo?.pendingCredit.toNumber() || 0,
          },
          message: "Order created successfully",
        },
        { status: 201 }
      );
    } catch (error: any) {
      console.error("Error creating B2B order:", error);

      // Rollback if we created a B2B order
      if (b2bOrder) {
        try {
          await prisma.b2BOrder.delete({ where: { id: b2bOrder.id } });

          // Restore credit
          await prisma.creditTransaction.create({
            data: {
              companyId,
              orderId: b2bOrder.id,
              transactionType: "order_cancelled",
              creditAmount: new Decimal(totalAmount),
              previousBalance: new Decimal(0),
              newBalance: new Decimal(0),
              notes: `Order creation failed - Database error. Credit restored.`,
              createdBy: "system",
            },
          });
        } catch (rollbackError) {
          console.error("Error during rollback:", rollbackError);
        }
      }

      return Response.json(
        {
          error: "Failed to create order",
          details: error.message,
        },
        { status: 500 }
      );
    }
  } catch (error: any) {
    console.error("Error in order creation endpoint:", error);
    return Response.json(
      {
        error: "Internal server error",
        details: error.message,
      },
      { status: 500 }
    );
  }
};
