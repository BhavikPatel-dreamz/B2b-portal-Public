import prisma from "../db.server";
import { Decimal } from "@prisma/client/runtime/library";
import { syncCompanyCreditMetafields } from "./metafieldSync.server";
import { authenticate } from "../shopify.server";

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

  // Calculate used credit: sum of all unpaid orders (pending orders are considered "used" credit)
  const ordersWithBalance = await prisma.b2BOrder.aggregate({
    where: {
      companyId,
      paymentStatus: { in: ["pending", "partial"] },
      orderStatus: { notIn: ["cancelled"] }, // All unpaid orders except cancelled
    },
    _sum: {
      remainingBalance: true,
    },
  });

  const usedCredit = ordersWithBalance._sum.remainingBalance || new Decimal(0);

  // Pending credit is separate - these would be orders in draft state that haven't been confirmed yet
  // For now, we're not tracking true "pending" credit separate from "used" credit
  const pendingCredit = new Decimal(0);

  const availableCredit = new Decimal(company.creditLimit)
    .minus(usedCredit);
    // pendingCredit is 0, so we only subtract usedCredit

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

interface CreditDeductionResult {
  success: boolean;
  message?: string;
  newBalance?: Decimal;
  creditUsed?: Decimal;
}

/**
 * Deduct credit for an order
 * Creates a transaction log and updates the order's credit usage
 */
export async function deductCredit(
  companyId: string,
  orderId: string,
  amount: number | Decimal,
  userId: string,
  admin?: any // Optional admin context for metafield sync
): Promise<CreditDeductionResult> {
  const amountDecimal = new Decimal(amount);

  // Get current credit info
  const creditInfo = await calculateAvailableCredit(companyId);
  if (!creditInfo) {
    throw new Error("Company not found");
  }

  // Calculate previous balance (this is available credit before deduction)
  const previousBalance = creditInfo.availableCredit;
  const newBalance = previousBalance.minus(amountDecimal);

  // Check if credit transaction already exists for this order
  const existingTransaction = await prisma.creditTransaction.findFirst({
    where: {
      companyId,
      orderId,
      transactionType: "order_created",
    },
  });

  if (existingTransaction) {
    // Update existing transaction
    await prisma.creditTransaction.update({
      where: { id: existingTransaction.id },
      data: {
        creditAmount: amountDecimal.negated(), // Negative because we're deducting
        previousBalance,
        newBalance,
        notes: `Credit deducted for order ${orderId} (updated)`,
        createdBy: userId,
      },
    });
  } else {
    // Create new credit transaction log
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
  }

  // Check if the order exists in our database before updating
  const existingOrder = await prisma.b2BOrder.findUnique({
    where: { id: orderId },
    select: { id: true },
  });

  if (existingOrder) {
    // Update the order to reflect credit used
    await prisma.b2BOrder.update({
      where: { id: orderId },
      data: {
        creditUsed: amountDecimal,
        remainingBalance: amountDecimal,
      },
    });
  } else {
    console.log(`⚠️ Order ${orderId} not found in database - skipping order update`);
  }

  // Sync updated credit information to Shopify metafields for cart validation
  if (admin) {
    try {
      await syncCompanyCreditMetafields(admin, companyId);
      console.log(`✅ Synced credit data to Shopify metafields for company ${companyId}`);
    } catch (syncError) {
      console.error(`❌ Failed to sync credit metafields:`, syncError);
      // Don't throw error - credit deduction was successful, just metafield sync failed
    }
  } else {
    console.log(`⚠️ No admin context provided - skipping metafield sync`);
  }

  return {
    success: true,
    message: `Credit deducted successfully for order ${orderId}`,
    newBalance,
    creditUsed: amountDecimal
  };
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
  reason: "cancelled" | "refunded" = "cancelled",
  admin?: any // Optional admin context for metafield sync
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

  // Sync updated credit information to Shopify metafields for cart validation
  if (admin) {
    try {
      await syncCompanyCreditMetafields(admin, companyId);
      console.log(`✅ Synced credit data to Shopify metafields after restore for company ${companyId}`);
    } catch (syncError) {
      console.error(`❌ Failed to sync credit metafields after restore:`, syncError);
      // Don't throw error - credit restoration was successful, just metafield sync failed
    }
  } else {
    console.log(`⚠️ No admin context provided for restore - skipping metafield sync`);
  }
}

/**
 * Update pending credit by recalculating from unpaid orders
 * This is a maintenance function to ensure accuracy
 * Note: With current business logic, all unpaid orders count as "used credit"
 */
export async function updatePendingCredit(companyId: string): Promise<{
  totalPending: Decimal;
  orderCount: number;
}> {
  // Get all unpaid orders that would be considered "used credit"
  const unpaidOrders = await prisma.b2BOrder.findMany({
    where: {
      companyId,
      paymentStatus: { in: ["pending", "partial"] },
      orderStatus: { notIn: ["cancelled"] },
    },
    select: {
      id: true,
      remainingBalance: true,
    },
  });

  const totalPending = unpaidOrders.reduce(
    (sum, order) => sum.plus(order.remainingBalance),
    new Decimal(0)
  );

  return {
    totalPending: new Decimal(0), // Pending is always 0 with current logic
    orderCount: 0, // No separate pending orders
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
