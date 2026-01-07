import prisma from "../db.server";
import { Prisma } from "@prisma/client";

export interface CreateCompanyInput {
  shopId: string;
  shopifyCompanyId?: string | null;
  name: string;
  contactName?: string | null;
  contactEmail?: string | null;
  creditLimit?: number | Prisma.Decimal;
}

export interface UpdateCompanyInput {
  shopifyCompanyId?: string | null;
  name?: string;
  contactName?: string | null;
  contactEmail?: string | null;
  creditLimit?: number | Prisma.Decimal;
}

export interface CreateCreditTransactionInput {
  companyId: string;
  orderId?: string | null;
  transactionType: string;
  creditAmount: number | Prisma.Decimal;
  previousBalance: number | Prisma.Decimal;
  newBalance: number | Prisma.Decimal;
  notes?: string | null;
  createdBy: string;
}

/**
 * Create a new company account
 */
export async function createCompany(data: CreateCompanyInput) {
  return await prisma.companyAccount.create({
    data: {
      shopId: data.shopId,
      shopifyCompanyId: data.shopifyCompanyId,
      name: data.name,
      contactName: data.contactName,
      contactEmail: data.contactEmail,
      creditLimit: data.creditLimit
        ? new Prisma.Decimal(data.creditLimit.toString())
        : new Prisma.Decimal(0),
    },
    include: {
      users: true,
      orders: true,
      creditTransactions: true,
    },
  });
}

/**
 * Get company by ID
 */
export async function getCompanyById(id: string) {
  return await prisma.companyAccount.findUnique({
    where: { id },
    include: {
      shop: true,
      users: true,
      orders: true,
      creditTransactions: true,
    },
  });
}

/**
 * Get company by Shopify company ID
 */
export async function getCompanyByShopifyId(
  shopId: string,
  shopifyCompanyId: string,
) {
  return await prisma.companyAccount.findUnique({
    where: {
      shopId_shopifyCompanyId: {
        shopId,
        shopifyCompanyId,
      },
    },
    include: {
      users: true,
      orders: true,
    },
  });
}

/**
 * Get all companies for a shop
 */
export async function getCompaniesByShop(
  shopId: string,
  options?: {
    orderBy?: Prisma.CompanyAccountOrderByWithRelationInput;
    take?: number;
    skip?: number;
  },
) {
  return await prisma.companyAccount.findMany({
    where: { shopId },
    orderBy: options?.orderBy || { updatedAt: "desc" },
    take: options?.take,
    skip: options?.skip,
    include: {
      _count: {
        select: {
          users: true,
          orders: true,
        },
      },
    },
  });
}

/**
 * Update a company
 */
export async function updateCompany(id: string, data: UpdateCompanyInput) {
  const updateData: Prisma.CompanyAccountUpdateInput = {
    ...data,
    updatedAt: new Date(),
  };

  if (data.creditLimit !== undefined) {
    updateData.creditLimit = new Prisma.Decimal(data.creditLimit.toString());
  }

  return await prisma.companyAccount.update({
    where: { id },
    data: updateData,
    include: {
      users: true,
      orders: true,
    },
  });
}

/**
 * Upsert a company (create or update)
 */
export async function upsertCompany(
  shopId: string,
  shopifyCompanyId: string,
  data: Omit<CreateCompanyInput, "shopId" | "shopifyCompanyId">,
) {
  return await prisma.companyAccount.upsert({
    where: {
      shopId_shopifyCompanyId: {
        shopId,
        shopifyCompanyId,
      },
    },
    update: {
      name: data.name,
      contactName: data.contactName,
      contactEmail: data.contactEmail,
      creditLimit: data.creditLimit
        ? new Prisma.Decimal(data.creditLimit.toString())
        : undefined,
      updatedAt: new Date(),
    },
    create: {
      shopId,
      shopifyCompanyId,
      name: data.name,
      contactName: data.contactName,
      contactEmail: data.contactEmail,
      creditLimit: data.creditLimit
        ? new Prisma.Decimal(data.creditLimit.toString())
        : new Prisma.Decimal(0),
    },
    include: {
      users: true,
    },
  });
}

/**
 * Delete a company
 */
export async function deleteCompany(id: string) {
  return await prisma.companyAccount.delete({
    where: { id },
  });
}

/**
 * Count companies for a shop
 */
export async function countCompanies(shopId: string) {
  return await prisma.companyAccount.count({
    where: { shopId },
  });
}

/**
 * Create a credit transaction
 */
export async function createCreditTransaction(
  data: CreateCreditTransactionInput,
) {
  return await prisma.creditTransaction.create({
    data: {
      companyId: data.companyId,
      orderId: data.orderId,
      transactionType: data.transactionType,
      creditAmount: new Prisma.Decimal(data.creditAmount.toString()),
      previousBalance: new Prisma.Decimal(data.previousBalance.toString()),
      newBalance: new Prisma.Decimal(data.newBalance.toString()),
      notes: data.notes,
      createdBy: data.createdBy,
    },
  });
}

/**
 * Get credit transactions for a company
 */
export async function getCreditTransactionsByCompany(
  companyId: string,
  options?: {
    transactionType?: string | string[];
    orderBy?: Prisma.CreditTransactionOrderByWithRelationInput;
    take?: number;
    skip?: number;
  },
) {
  const where: Prisma.CreditTransactionWhereInput = {
    companyId,
  };

  if (options?.transactionType) {
    where.transactionType = Array.isArray(options.transactionType)
      ? { in: options.transactionType }
      : options.transactionType;
  }

  return await prisma.creditTransaction.findMany({
    where,
    orderBy: options?.orderBy || { createdAt: "desc" },
    take: options?.take,
    skip: options?.skip,
  });
}

/**
 * Count credit transactions
 */
export async function countCreditTransactions(
  where: Prisma.CreditTransactionWhereInput,
) {
  return await prisma.creditTransaction.count({ where });
}

/**
 * Get company with credit summary
 */
export async function getCompanyWithCreditSummary(companyId: string) {
  const company = await getCompanyById(companyId);

  if (!company) {
    return null;
  }

  // Get pending orders total
  const pendingOrders = await prisma.b2BOrder.aggregate({
    where: {
      companyId,
      orderStatus: { in: ["draft", "submitted", "processing"] },
    },
    _sum: {
      remainingBalance: true,
    },
    _count: true,
  });

  const pendingCredit = pendingOrders._sum.remainingBalance || new Prisma.Decimal(0);
  const usedCredit = company.creditLimit.minus(pendingCredit);
  const availableCredit = company.creditLimit.minus(pendingCredit);

  return {
    company,
    creditLimit: company.creditLimit,
    usedCredit,
    pendingCredit,
    availableCredit,
    pendingOrderCount: pendingOrders._count,
  };
}

/**
 * Get company dashboard data
 */
export async function getCompanyDashboardData(companyId: string, shopId: string) {
  // Get company
  const company = await prisma.companyAccount.findUnique({
    where: { id: companyId },
    select: {
      id: true,
      name: true,
      contactName: true,
      contactEmail: true,
      shopId: true,
      shopifyCompanyId: true,
      paymentTeam: true,
    },
  });

  if (!company || company.shopId !== shopId) {
    return null;
  }

  // Get recent orders
  const recentOrders = await prisma.b2BOrder.findMany({
    where: {
      companyId,
      orderStatus: { not: "cancelled" },
    },
    orderBy: {
      createdAt: "desc",
    },
    take: 10,
    include: {
      createdByUser: {
        select: {
          email: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  });

  // Get order statistics
  const [totalOrders, paidOrders, unpaidOrders, pendingOrders] = await Promise.all([
    prisma.b2BOrder.count({
      where: { companyId, orderStatus: { not: "cancelled" } },
    }),
    prisma.b2BOrder.count({
      where: {
        companyId,
        paymentStatus: "paid",
        orderStatus: { not: "cancelled" },
      },
    }),
    prisma.b2BOrder.count({
      where: {
        companyId,
        paymentStatus: { in: ["pending", "partial"] },
        orderStatus: { not: "cancelled" },
      },
    }),
    prisma.b2BOrder.count({
      where: {
        companyId,
        orderStatus: { in: ["draft", "submitted", "processing"] },
      },
    }),
  ]);

  // Get users (first 10)
  const users = await prisma.user.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      role: true,
      companyRole: true,
      status: true,
      createdAt: true,
    },
  });

  // Get total user count
  const totalUsers = await prisma.user.count({
    where: { companyId },
  });

  return {
    company,
    recentOrders,
    orderStats: {
      total: totalOrders,
      paid: paidOrders,
      unpaid: unpaidOrders,
      pending: pendingOrders,
    },
    users,
    totalUsers,
  };
}

/**
 * Get all users for a company
 */
export async function getCompanyUsers(companyId: string, shopId: string) {
  // Verify company belongs to shop
  const company = await prisma.companyAccount.findUnique({
    where: { id: companyId },
    select: { shopId: true, name: true, shopifyCompanyId: true },
  });

  if (!company || company.shopId !== shopId) {
    return null;
  }

  const users = await prisma.user.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      role: true,
      companyRole: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return {
    company,
    users,
  };
}

/**
 * Get all orders for a company
 */
export async function getCompanyOrders(companyId: string, shopId: string) {
  // Verify company belongs to shop
  const company = await prisma.companyAccount.findUnique({
    where: { id: companyId },
    select: { shopId: true, name: true, shopifyCompanyId: true },
  });

  if (!company || company.shopId !== shopId) {
    return null;
  }

  const orders = await prisma.b2BOrder.findMany({
    where: {
      companyId,
      orderStatus: { not: "cancelled" },
    },
    orderBy: {
      createdAt: "desc",
    },
    include: {
      createdByUser: {
        select: {
          email: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  });

  return {
    company,
    orders,
  };
}
