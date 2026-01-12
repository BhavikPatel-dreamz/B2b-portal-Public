import prisma from "../db.server";
import { Prisma } from "@prisma/client";

export interface CreateOrderInput {
  companyId: string;
  createdByUserId: string;
  shopId: string;
  shopifyOrderId?: string | null;
  orderTotal: number | Prisma.Decimal;
  creditUsed: number | Prisma.Decimal;
  remainingBalance: number | Prisma.Decimal;
  paymentStatus?: string;
  orderStatus?: string;
}

export interface UpdateOrderInput {
  shopifyOrderId?: string | null;
  orderTotal?: number | Prisma.Decimal;
  creditUsed?: number | Prisma.Decimal;
  paymentStatus?: string;
  orderStatus?: string;
  paidAmount?: number | Prisma.Decimal;
  remainingBalance?: number | Prisma.Decimal;
  paidAt?: Date | null;
}

export interface CreateOrderPaymentInput {
  orderId: string;
  amount: number | Prisma.Decimal;
  method?: string | null;
  status?: string;
  receivedAt?: Date | null;
}

export interface UpdateOrderPaymentInput {
  amount?: number | Prisma.Decimal;
  method?: string | null;
  status?: string;
  receivedAt?: Date | null;
}

/**
 * Create a new B2B order
 */
export async function createOrder(data: CreateOrderInput) {
  return await prisma.b2BOrder.create({
    data: {
      companyId: data.companyId,
      createdByUserId: data.createdByUserId,
      shopId: data.shopId,
      shopifyOrderId: data.shopifyOrderId,
      orderTotal: new Prisma.Decimal(data.orderTotal.toString()),
      creditUsed: new Prisma.Decimal(data.creditUsed.toString()),
      remainingBalance: new Prisma.Decimal(data.remainingBalance.toString()),
      paidAmount: new Prisma.Decimal(0),
      paymentStatus: data.paymentStatus || "pending",
      orderStatus: data.orderStatus || "draft",
    },
    include: {
      company: true,
      createdByUser: true,
      payments: true,
    },
  });
}

/**
 * Get order by ID
 */
export async function getOrderById(id: string) {
  return await prisma.b2BOrder.findUnique({
    where: { id },
    include: {
      company: true,
      createdByUser: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
        },
      },
      payments: true,
    },
  });
}

/**
 * Get order by Shop ID and Shopify Order GID (used by webhooks)
 */
export async function getOrderByShopifyId(shopId: string, shopifyOrderId: string) {
  return await prisma.b2BOrder.findFirst({
    where: { shopId, shopifyOrderId },
    select: {
      id: true,
      orderTotal: true,
      companyId: true,
      remainingBalance: true,
      paidAmount: true,
      paidAt: true,
    },
  });
}

/**
 * Get complete order details by Shop ID and Shopify Order GID with all relations
 */
export async function getOrderByShopifyIdWithDetails(shopId: string, shopifyOrderId: string) {
  return await prisma.b2BOrder.findFirst({
    where: { shopId, shopifyOrderId },
    include: {
      company: {
        include: {
          account: true,
        },
      },
      createdByUser: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
        },
      },
      payments: true,
      shop: true,
    },
  });
}

/**
 * Get orders by company
 */
export async function getOrdersByCompany(
  companyId: string,
  options?: {
    orderStatus?: string | string[];
    paymentStatus?: string | string[];
    orderBy?: Prisma.B2BOrderOrderByWithRelationInput;
    take?: number;
    skip?: number;
  },
) {
  const where: Prisma.B2BOrderWhereInput = {
    companyId,
  };

  if (options?.orderStatus) {
    where.orderStatus = Array.isArray(options.orderStatus)
      ? { in: options.orderStatus }
      : options.orderStatus;
  }

  if (options?.paymentStatus) {
    where.paymentStatus = Array.isArray(options.paymentStatus)
      ? { in: options.paymentStatus }
      : options.paymentStatus;
  }

  return await prisma.b2BOrder.findMany({
    where,
    orderBy: options?.orderBy || { createdAt: "desc" },
    take: options?.take,
    skip: options?.skip,
    include: {
      company: true,
      createdByUser: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
        },
      },
      payments: true,
    },
  });
}

/**
 * Get orders by user
 */
export async function getOrdersByUser(
  userId: string,
  options?: {
    orderStatus?: string | string[];
    orderBy?: Prisma.B2BOrderOrderByWithRelationInput;
    take?: number;
    skip?: number;
  },
) {
  const where: Prisma.B2BOrderWhereInput = {
    createdByUserId: userId,
  };

  if (options?.orderStatus) {
    where.orderStatus = Array.isArray(options.orderStatus)
      ? { in: options.orderStatus }
      : options.orderStatus;
  }

  return await prisma.b2BOrder.findMany({
    where,
    orderBy: options?.orderBy || { createdAt: "desc" },
    take: options?.take,
    skip: options?.skip,
    include: {
      company: true,
      payments: true,
    },
  });
}

/**
 * Update an order
 */
export async function updateOrder(id: string, data: UpdateOrderInput) {
  const updateData: Prisma.B2BOrderUpdateInput = {
    ...data,
    updatedAt: new Date(),
  };

  // Convert numeric fields to Decimal
  if (data.orderTotal !== undefined) {
    updateData.orderTotal = new Prisma.Decimal(data.orderTotal.toString());
  }
  if (data.creditUsed !== undefined) {
    updateData.creditUsed = new Prisma.Decimal(data.creditUsed.toString());
  }
  if (data.paidAmount !== undefined) {
    updateData.paidAmount = new Prisma.Decimal(data.paidAmount.toString());
  }
  if (data.remainingBalance !== undefined) {
    updateData.remainingBalance = new Prisma.Decimal(
      data.remainingBalance.toString(),
    );
  }

  return await prisma.b2BOrder.update({
    where: { id },
    data: updateData,
    include: {
      company: true,
      createdByUser: true,
      payments: true,
    },
  });
}

/**
 * Delete an order
 */
export async function deleteOrder(id: string) {
  return await prisma.b2BOrder.delete({
    where: { id },
  });
}

/**
 * Count orders
 */
export async function countOrders(where: Prisma.B2BOrderWhereInput) {
  return await prisma.b2BOrder.count({ where });
}

/**
 * Count orders by company
 */
export async function countOrdersByCompany(
  companyId: string,
  options?: {
    orderStatus?: string | string[];
    paymentStatus?: string | string[];
  },
) {
  const where: Prisma.B2BOrderWhereInput = {
    companyId,
  };

  if (options?.orderStatus) {
    where.orderStatus = Array.isArray(options.orderStatus)
      ? { in: options.orderStatus }
      : options.orderStatus;
  }

  if (options?.paymentStatus) {
    where.paymentStatus = Array.isArray(options.paymentStatus)
      ? { in: options.paymentStatus }
      : options.paymentStatus;
  }

  return await countOrders(where);
}

/**
 * Create an order payment
 */
export async function createOrderPayment(data: CreateOrderPaymentInput) {
  return await prisma.orderPayment.create({
    data: {
      orderId: data.orderId,
      amount: new Prisma.Decimal(data.amount.toString()),
      method: data.method,
      status: data.status || "pending",
      receivedAt: data.receivedAt,
    },
  });
}

/**
 * Get payment by ID
 */
export async function getPaymentById(id: string) {
  return await prisma.orderPayment.findUnique({
    where: { id },
    include: {
      order: true,
    },
  });
}

/**
 * Get payments by order
 */
export async function getPaymentsByOrder(orderId: string) {
  return await prisma.orderPayment.findMany({
    where: { orderId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Update an order payment
 */
export async function updateOrderPayment(
  id: string,
  data: UpdateOrderPaymentInput,
) {
  const updateData: Prisma.OrderPaymentUpdateInput = {
    ...data,
    updatedAt: new Date(),
  };

  if (data.amount !== undefined) {
    updateData.amount = new Prisma.Decimal(data.amount.toString());
  }

  return await prisma.orderPayment.update({
    where: { id },
    data: updateData,
  });
}

/**
 * Delete an order payment
 */
export async function deleteOrderPayment(id: string) {
  return await prisma.orderPayment.delete({
    where: { id },
  });
}
