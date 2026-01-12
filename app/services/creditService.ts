import prisma from "../db.server";
import { Decimal } from "@prisma/client/runtime/library";

interface CreditAvailability {
  creditLimit: Decimal;
  usedCredit: Decimal;
  pendingCredit: Decimal;
  availableCredit: Decimal;
}

/**
 * Calculate available credit for a company
 * Formula: credit_limit - used_credit - pending_credit
 */
export async function calculateAvailableCredit(
  companyId: string
): Promise<CreditAvailability | null> {
  const company = await prisma.companyAccount.findUnique({
    where: { id: companyId },
    select: { creditLimit: true },
  });

  if (!company) {
    return null;
  }

  // Ensure creditLimit is not undefined/null
  if (company.creditLimit === null || company.creditLimit === undefined) {
    console.error(`Company ${companyId} has null/undefined creditLimit:`, company.creditLimit);
    // Set default credit limit of 0
    company.creditLimit = new Decimal(0);
  }

  // Calculate used credit: sum of all unpaid order amounts (pending + partial)
  const ordersWithBalance = await prisma.b2BOrder.aggregate({
    where: {
      companyId,
      paymentStatus: { in: ["pending", "partial"] },
      orderStatus: { notIn: ["cancelled"] },
    },
    _sum: {
      remainingBalance: true,
    },
  });

  const usedCredit = ordersWithBalance._sum.remainingBalance || new Decimal(0);

  // Calculate pending credit: sum of all pending/processing orders not yet shipped
  const pendingOrders = await prisma.b2BOrder.aggregate({
    where: {
      companyId,
      paymentStatus: { in: ["pending", "partial"] },
      orderStatus: { in: ["draft", "submitted", "processing"] },
    },
    _sum: {
      remainingBalance: true,
    },
  });

  const pendingCredit = pendingOrders._sum.remainingBalance || new Decimal(0);

  const availableCredit = new Decimal(company.creditLimit)
    .minus(usedCredit)
    .minus(pendingCredit);

  return {
    creditLimit: company.creditLimit,
    usedCredit,
    pendingCredit,
    availableCredit,
  };
}

/**
 * Check if company can create an order with the given amount
 */
export async function canCreateOrder(
  companyId: string,
  orderAmount: number | Decimal
): Promise<{ canCreate: boolean; availableCredit?: Decimal; message?: string }> {
  const creditInfo = await calculateAvailableCredit(companyId);

  if (!creditInfo) {
    return {
      canCreate: false,
      message: "Company not found",
    };
  }

  const orderAmountDecimal = new Decimal(orderAmount);

  if (creditInfo.availableCredit.lessThan(orderAmountDecimal)) {
    return {
      canCreate: false,
      availableCredit: creditInfo.availableCredit,
      message: `Insufficient credit. Available: ${creditInfo.availableCredit}, Required: ${orderAmountDecimal}`,
    };
  }

  return {
    canCreate: true,
    availableCredit: creditInfo.availableCredit,
  };
}

/**
 * Deduct credit when an order is created
 * Creates a transaction log and updates the order's credit usage
 */
export async function deductCredit(
  companyId: string,
  orderId: string,
  amount: number | Decimal,
  userId: string
): Promise<void> {
  const amountDecimal = new Decimal(amount);

  // Get current credit info
  const creditInfo = await calculateAvailableCredit(companyId);
  if (!creditInfo) {
    throw new Error("Company not found");
  }

  // Calculate previous balance (this is available credit before deduction)
  const previousBalance = creditInfo.availableCredit;
  const newBalance = previousBalance.minus(amountDecimal);

  // Create credit transaction log
  await prisma.creditTransaction.create({
    data: {
      companyId,
      orderId,
      transactionType: "order_created",
      creditAmount: amountDecimal.negated(), // Negative because we're deducting
      previousBalance,
      newBalance,
      notes: `Credit deducted for order ${orderId}`,
      createdBy: userId,
    },
  });

  // Update the order to reflect credit used
  await prisma.b2BOrder.update({
    where: { id: orderId },
    data: {
      creditUsed: amountDecimal,
      remainingBalance: amountDecimal,
    },
  });
}

/**
 * Restore credit when an order is cancelled or refunded
 * Creates a transaction log
 */
export async function restoreCredit(
  companyId: string,
  orderId: string,
  amount: number | Decimal,
  userId: string,
  reason: "cancelled" | "refunded" = "cancelled"
): Promise<void> {
  const amountDecimal = new Decimal(amount);

  // Get current credit info
  const creditInfo = await calculateAvailableCredit(companyId);
  if (!creditInfo) {
    throw new Error("Company not found");
  }

  const previousBalance = creditInfo.availableCredit;
  const newBalance = previousBalance.plus(amountDecimal);

  // Create credit transaction log
  await prisma.creditTransaction.create({
    data: {
      companyId,
      orderId,
      transactionType: reason === "cancelled" ? "order_cancelled" : "payment_received",
      creditAmount: amountDecimal, // Positive because we're restoring
      previousBalance,
      newBalance,
      notes: `Credit restored for ${reason} order ${orderId}`,
      createdBy: userId,
    },
  });
}

/**
 * Update pending credit by recalculating from unpaid orders
 * This is a maintenance function to ensure accuracy
 */
export async function updatePendingCredit(companyId: string): Promise<{
  totalPending: Decimal;
  orderCount: number;
}> {
  // Get all pending/processing orders
  const pendingOrders = await prisma.b2BOrder.findMany({
    where: {
      companyId,
      paymentStatus: { in: ["pending", "partial"] },
      orderStatus: { in: ["draft", "submitted", "processing"] },
    },
    select: {
      id: true,
      remainingBalance: true,
    },
  });

  const totalPending = pendingOrders.reduce(
    (sum, order) => sum.plus(order.remainingBalance),
    new Decimal(0)
  );

  return {
    totalPending,
    orderCount: pendingOrders.length,
  };
}

/**
 * Get credit summary for a company
 */
export async function getCreditSummary(companyId: string) {
  const company = await prisma.companyAccount.findUnique({
    where: { id: companyId },
    select: {
      id: true,
      name: true,
      creditLimit: true,
    },
  });

  if (!company) {
    return null;
  }

  const creditInfo = await calculateAvailableCredit(companyId);
  const pendingInfo = await updatePendingCredit(companyId);

  // Get recent transactions
  const recentTransactions = await prisma.creditTransaction.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      transactionType: true,
      creditAmount: true,
      previousBalance: true,
      newBalance: true,
      notes: true,
      createdAt: true,
      orderId: true,
    },
  });

  return {
    company,
    creditLimit: creditInfo?.creditLimit || new Decimal(0),
    usedCredit: creditInfo?.usedCredit || new Decimal(0),
    pendingCredit: creditInfo?.pendingCredit || new Decimal(0),
    availableCredit: creditInfo?.availableCredit || new Decimal(0),
    pendingOrderCount: pendingInfo.orderCount,
    recentTransactions,
  };
}
