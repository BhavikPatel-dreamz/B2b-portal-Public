import type { Prisma } from "@prisma/client";
import prisma from "app/db.server";
import { getAdminForShop } from "app/shopify.server";
import type { SalesSessionUser } from "app/utils/sales-session.server";

export type SalesOrderAccessLevel = "agent" | "manager" | "admin";

export function getSalesOrderAccessLevel(
  user: SalesSessionUser,
): SalesOrderAccessLevel {
  const role = (user.companyRole || "").toLowerCase().replace(/[\s_-]/g, "");
  if (role.includes("admin")) return "admin";
  if (role.includes("manager") || role.includes("lead")) return "manager";
  return "agent";
}

export function getAccessibleCompanyIds(user: SalesSessionUser) {
  return user.salesCompanies.map((assignment) => assignment.companyId);
}

export function getOrderAccessWhere(
  user: SalesSessionUser,
): Prisma.B2BOrderWhereInput {
  const companyIds = getAccessibleCompanyIds(user);
  const accessLevel = getSalesOrderAccessLevel(user);
  return {
    companyId: { in: companyIds },
    orderStatus: { notIn: ["converted", "archived"] },
    ...(accessLevel === "agent" ? { createdByUserId: user.id } : {}),
  };
}

export function getShopifyOrderWhere(): Prisma.B2BOrderWhereInput {
  return {
    shopifyOrderId: { startsWith: "gid://shopify/Order/" },
  };
}

export async function getAccessibleOrder(
  user: SalesSessionUser,
  orderId: string,
) {
  return prisma.b2BOrder.findFirst({
    where: { id: orderId, ...getOrderAccessWhere(user) },
    include: {
      company: { include: { shop: true } },
      createdByUser: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      items: { orderBy: { createdAt: "asc" } },
      payments: { orderBy: { createdAt: "desc" } },
      activities: {
        orderBy: { createdAt: "desc" },
        include: {
          user: { select: { firstName: true, lastName: true, email: true } },
        },
      },
    },
  });
}

export async function logOrderActivity(input: {
  orderId: string;
  userId?: string | null;
  action: string;
  message?: string | null;
  metadata?: Prisma.InputJsonValue;
}) {
  return prisma.orderActivity.create({
    data: {
      orderId: input.orderId,
      userId: input.userId,
      action: input.action,
      message: input.message,
      metadata: input.metadata,
    },
  });
}

export function getOrderNumber(order: {
  orderNumber: string | null;
  shopifyOrderId: string | null;
  id: string;
}) {
  return (
    order.orderNumber ||
    (order.shopifyOrderId
      ? `#${order.shopifyOrderId.split("/").pop()}`
      : null) ||
    `ORD-${order.id.slice(-8).toUpperCase()}`
  );
}

export function isSalesPortalPaymentLinkEligible(order: {
  source: string | null;
  paymentStatus: string;
  orderStatus: string;
}) {
  return (
    order.source === "Sales Portal" &&
    order.paymentStatus.toLowerCase() === "pending" &&
    order.orderStatus.toLowerCase() !== "cancelled"
  );
}

type PaymentLinkOrder = {
  id: string;
  source: string | null;
  shopifyOrderId: string | null;
  paymentStatus: string;
  orderStatus: string;
  remainingBalance: { toString(): string };
  currencyCode: string;
  customerEmail: string | null;
  paymentLink: string | null;
  paymentLinkToken: string | null;
  company: {
    shop: {
      shopDomain: string;
    };
  };
};

export async function getOrCreateSalesOrderPaymentLink(
  order: PaymentLinkOrder,
) {
  if (!isSalesPortalPaymentLinkEligible(order)) {
    throw new Error(
      "Payment links are available only for pending Sales Portal orders.",
    );
  }
  if (!order.shopifyOrderId?.startsWith("gid://shopify/Order/")) {
    throw new Error(
      "This Sales Portal order is not connected to a Shopify order.",
    );
  }

  const admin = await getAdminForShop(order.company.shop.shopDomain);
  const response = await admin.graphql(
    `#graphql
      query SalesPortalPaymentLink($id: ID!) {
        order(id: $id) {
          id
          cancelledAt
          displayFinancialStatus
          statusPageUrl
          paymentCollectionDetails {
            additionalPaymentCollectionUrl
          }
          email
          customer {
            email
          }
          totalOutstandingSet {
            shopMoney {
              amount
              currencyCode
            }
          }
        }
      }
    `,
    { variables: { id: order.shopifyOrderId } },
  );
  const payload = (await response.json()) as {
    data?: {
      order?: {
        id: string;
        cancelledAt: string | null;
        displayFinancialStatus: string | null;
        statusPageUrl: string;
        paymentCollectionDetails: {
          additionalPaymentCollectionUrl: string | null;
        };
        email: string | null;
        customer: { email: string | null } | null;
        totalOutstandingSet: {
          shopMoney: { amount: string; currencyCode: string };
        };
      } | null;
    };
    errors?: Array<{ message: string }>;
  };
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }

  const shopifyOrder = payload.data?.order;
  if (!shopifyOrder || shopifyOrder.id !== order.shopifyOrderId) {
    throw new Error("The connected Shopify order could not be verified.");
  }
  if (shopifyOrder.cancelledAt) {
    throw new Error("Cancelled orders cannot receive a payment link.");
  }
  if (shopifyOrder.displayFinancialStatus?.toLowerCase() !== "pending") {
    throw new Error("Shopify no longer reports this order as pending payment.");
  }

  const outstanding = shopifyOrder.totalOutstandingSet.shopMoney;
  const expectedAmount = Number(order.remainingBalance.toString());
  const providerAmount = Number(outstanding.amount);
  if (
    outstanding.currencyCode !== order.currencyCode ||
    !Number.isFinite(providerAmount) ||
    Math.abs(providerAmount - expectedAmount) > 0.009
  ) {
    throw new Error(
      "The Shopify payment amount or currency does not match the Sales Portal order.",
    );
  }

  const providerEmail = shopifyOrder.email || shopifyOrder.customer?.email;
  if (
    order.customerEmail &&
    providerEmail &&
    order.customerEmail.toLowerCase() !== providerEmail.toLowerCase()
  ) {
    throw new Error(
      "The Shopify customer does not match the Sales Portal order.",
    );
  }

  const paymentLink =
    shopifyOrder.paymentCollectionDetails.additionalPaymentCollectionUrl;
  if (!paymentLink) {
    console.error("[sales-payment-link] Shopify has no collection URL", {
      orderId: order.id,
      shopifyOrderId: order.shopifyOrderId,
      financialStatus: shopifyOrder.displayFinancialStatus,
      hasStatusPageUrl: Boolean(shopifyOrder.statusPageUrl),
    });
    throw new Error(
      "Shopify has not enabled online payment collection for this order. Check the store payment gateway and B2B payment settings.",
    );
  }
  const parsedPaymentLink = new URL(paymentLink);
  if (parsedPaymentLink.protocol !== "https:") {
    console.error(
      "[sales-payment-link] Shopify returned an unsafe collection URL",
      {
        orderId: order.id,
        shopifyOrderId: order.shopifyOrderId,
      },
    );
    throw new Error("Shopify returned an invalid payment collection URL.");
  }

  const reused = order.paymentLink === paymentLink && !order.paymentLinkToken;
  const saved = await prisma.b2BOrder.updateMany({
    where: {
      id: order.id,
      source: "Sales Portal",
      paymentStatus: "pending",
      orderStatus: { not: "cancelled" },
    },
    data: reused
      ? { paymentLink }
      : {
          paymentLink,
          paymentLinkToken: null,
          paymentLinkAt: new Date(),
        },
  });
  if (saved.count === 0) {
    throw new Error("This order is no longer eligible for a payment link.");
  }

  return { link: paymentLink, reused };
}

export async function notifyOrderCreator(input: {
  orderId: string;
  receiverId: string;
  shopId: string;
  shopifyOrderId?: string | null;
  title: string;
  message: string;
  activityType: string;
}) {
  return prisma.notification.create({
    data: {
      receiverId: input.receiverId,
      shopId: input.shopId,
      shopifyOrderId: input.shopifyOrderId,
      title: input.title,
      message: input.message,
      activityType: input.activityType,
      activeAction: input.activityType,
    },
  });
}
