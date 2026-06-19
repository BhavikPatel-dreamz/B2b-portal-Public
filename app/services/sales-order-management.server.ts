import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import prisma from "app/db.server";
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
    ...(accessLevel === "agent" ? { createdByUserId: user.id } : {}),
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
    (order.shopifyOrderId ? `#${order.shopifyOrderId.split("/").pop()}` : null) ||
    `ORD-${order.id.slice(-8).toUpperCase()}`
  );
}

export function createPaymentLink(request: Request, orderId: string) {
  const token = crypto.randomBytes(24).toString("hex");
  const url = new URL(request.url);
  return {
    token,
    link: `${url.origin}/pay/order/${orderId}/${token}`,
  };
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
