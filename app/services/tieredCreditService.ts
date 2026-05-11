import prisma from "../db.server";
import { Decimal } from "@prisma/client/runtime/library";
import { autoSyncCreditMetafields } from "./metafieldSync.server";

interface UserCreditInfo {
  userId: string;
  userCreditLimit: Decimal | null;
  userCreditUsed: Decimal;
  userCreditAvailable: Decimal;
  hasUserLimit: boolean;
}

interface TieredCreditAvailability {
  company: {
    creditLimit: Decimal;
    usedCredit: Decimal;
    pendingCredit: Decimal;
    availableCredit: Decimal;
  };
  user: UserCreditInfo;
  canCreateOrder: boolean;
  limitingFactor: "company" | "user" | "none";
  message?: string;
}

/**
 * Calculate user-specific credit usage and availability
 */
export async function calculateUserCredit(
  userId: string,
  excludeOrderId?: string,
): Promise<UserCreditInfo | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      userCreditLimit: true,
      userCreditUsed: true,
    },
  });

  if (!user) {
    return null;
  }

  // If we're validating an existing order (post-payment), we need to exclude 
  // that order's usage from the total so we don't count it twice.
  let currentUsage = user.userCreditUsed;
  
  if (excludeOrderId) {
    // 1. Check if the B2B order exists and has user credit usage
    const excludedOrder = await prisma.b2BOrder.findFirst({
      where: {
        OR: [
          { id: excludeOrderId },
          { shopifyOrderId: excludeOrderId }
        ],
        createdByUserId: userId
      },
      select: { userCreditUsed: true }
    });

    if (excludedOrder) {
      currentUsage = currentUsage.minus(excludedOrder.userCreditUsed);
    } else {
      // 2. If the order doesn't exist yet, check if credit was already deducted 
      // via a CreditTransaction for this specific order/shopifyOrderId
      const excludedTx = await prisma.creditTransaction.findFirst({
        where: {
          OR: [
            { orderId: excludeOrderId },
            // Try to match Shopify ID format if only numeric was provided
            { orderId: excludeOrderId.startsWith("gid://") ? excludeOrderId : `gid://shopify/Order/${excludeOrderId}` }
          ],
          userId: userId,
          transactionType: { in: ["order_created", "order_updated", "credit_reserved"] }
        },
        select: { creditAmount: true }
      });

      if (excludedTx) {
        // creditAmount is negative for deductions, so we take the absolute value or negate it
        currentUsage = currentUsage.minus(excludedTx.creditAmount.abs());
      }
    }
  }

  // If user has no credit limit set, they have unlimited personal credit
  // (still subject to company limits)
  const hasUserLimit = user.userCreditLimit !== null;
  const userCreditLimit = user.userCreditLimit
    ? new Decimal(user.userCreditLimit)
    : new Decimal(0);
  const userCreditUsed = user.userCreditUsed; // Keep the actual total usage for reference
  const userCreditAvailable = hasUserLimit
    ? userCreditLimit.minus(currentUsage)
    : new Decimal(999999999); // Effectively unlimited

  return {
    userId: user.id,
    userCreditLimit,
    userCreditUsed,
    userCreditAvailable,
    hasUserLimit,
  };
}

/**
 * Calculate tiered credit availability for both company and user
 */
export async function calculateTieredCreditAvailability(
  companyId: string,
  userId: string,
  excludeOrderId?: string,
): Promise<TieredCreditAvailability | null> {
  // Get company credit info (can be either internal ID or Shopify GID)
  let company = await prisma.companyAccount.findUnique({
    where: { id: companyId },
    select: { id: true, creditLimit: true },
  });

  if (!company) {
    company = await prisma.companyAccount.findFirst({
      where: { shopifyCompanyId: companyId },
      select: { id: true, creditLimit: true },
    });
  }

  if (!company) {
    return null;
  }

  const internalCompanyId = company.id;

  // Calculate company credit usage
  const ordersWithBalance = await prisma.b2BOrder.aggregate({
    where: {
      companyId: internalCompanyId,
      paymentStatus: { in: ["pending", "partial"] },
      orderStatus: { notIn: ["cancelled"] },
      NOT: excludeOrderId ? { id: excludeOrderId } : undefined,
      shopifyOrderId: excludeOrderId ? { not: excludeOrderId } : undefined,
    },
    _sum: {
      remainingBalance: true,
    },
  });

  const companyUsedCredit = ordersWithBalance._sum.remainingBalance
    ? new Decimal(ordersWithBalance._sum.remainingBalance)
    : new Decimal(0);

  // We'll keep pending credit calculation for information, but NOT subtract it twice
  const pendingOrders = await prisma.b2BOrder.aggregate({
    where: {
      companyId: internalCompanyId,
      paymentStatus: { in: ["pending", "partial"] },
      orderStatus: { in: ["draft", "submitted", "processing"] },
      NOT: excludeOrderId ? { id: excludeOrderId } : undefined,
      shopifyOrderId: excludeOrderId ? { not: excludeOrderId } : undefined,
    },
    _sum: {
      remainingBalance: true,
    },
  });

  const companyPendingCredit = pendingOrders._sum.remainingBalance
    ? new Decimal(pendingOrders._sum.remainingBalance)
    : new Decimal(0);

  // CORRECT FORMULA: Limit - Used (Used already includes Pending)
  const companyAvailableCredit = company.creditLimit.minus(companyUsedCredit);

  // Get user credit info
  const userCreditInfo = await calculateUserCredit(userId, excludeOrderId);
  if (!userCreditInfo) {
    return null;
  }

  return {
    company: {
      creditLimit: company.creditLimit,
      usedCredit: companyUsedCredit,
      pendingCredit: companyPendingCredit,
      availableCredit: companyAvailableCredit,
    },
    user: userCreditInfo,
    canCreateOrder: true,
    limitingFactor: "none",
  };
}

/**
 * Validate if an order can be created with tiered credit checking
 */
export async function validateTieredCreditForOrder(
  companyId: string,
  userId: string,
  orderAmount: number | Decimal,
  excludeOrderId?: string,
): Promise<{
  canCreate: boolean;
  limitingFactor: "company" | "user" | "none";
  message?: string;
  creditInfo?: TieredCreditAvailability;
}> {
  const orderAmountDecimal = new Decimal(orderAmount);
  const creditInfo = await calculateTieredCreditAvailability(
    companyId,
    userId,
    excludeOrderId,
  );

  if (!creditInfo) {
    return {
      canCreate: false,
      limitingFactor: "company",
      message: "Company or user not found",
    };
  }

  // 1. Check company credit (STRICT LIMIT)
  if (creditInfo.company.availableCredit.lessThan(orderAmountDecimal)) {
    return {
      canCreate: false,
      limitingFactor: "company",
      message: `Insufficient company credit. Available: $${creditInfo.company.availableCredit.toFixed(2)}, Required: $${orderAmountDecimal.toFixed(2)}`,
      creditInfo,
    };
  }

  // 2. Check user credit (SOFT LIMIT - We allow it if company credit is OK)
  if (
    creditInfo.user.hasUserLimit &&
    creditInfo.user.userCreditAvailable.lessThan(orderAmountDecimal)
  ) {
    console.warn(`⚠️ Personal credit limit exceeded: Available: $${creditInfo.user.userCreditAvailable.toFixed(2)}, Required: $${orderAmountDecimal.toFixed(2)}`);
    
    return {
      canCreate: true, // Non-blocking
      limitingFactor: "user",
      message: `Note: Order exceeds personal credit limit. Available: $${creditInfo.user.userCreditAvailable.toFixed(2)}, Required: $${orderAmountDecimal.toFixed(2)}`,
      creditInfo,
    };
  }

  return {
    canCreate: true,
    limitingFactor: "none",
    message: "Credit validation passed",
    creditInfo,
  };
}

/**
 * Deduct credit from both company and user when order is created
 */
export async function deductTieredCredit(
  companyId: string,
  userId: string,
  orderId: string,
  amount: number | Decimal,
  transactionType: string = "order_created",
): Promise<void> {
  const amountDecimal = new Decimal(amount);

  // Get credit info BEFORE deduction, excluding THIS order if it exists
  const creditInfo = await calculateTieredCreditAvailability(
    companyId,
    userId,
    orderId,
  );
  if (!creditInfo) {
    throw new Error("Company or user not found");
  }

  // Use the resolved internal company ID for transactions and orders
  // We need to fetch the company record again or get it from calculateTieredCreditAvailability
  // Let's fetch it to be sure we have the internal ID
  let company = await prisma.companyAccount.findUnique({
    where: { id: companyId },
    select: { id: true },
  });

  if (!company) {
    company = await prisma.companyAccount.findFirst({
      where: { shopifyCompanyId: companyId },
      select: { id: true },
    });
  }

  if (!company) {
    throw new Error("Company not found for credit deduction");
  }

  const internalCompanyId = company.id;
  const previousBalance = creditInfo.company.availableCredit;
  const newBalance = previousBalance.minus(amountDecimal);

  // Find order to get both possible IDs (internal and Shopify GID)
  let order = await prisma.b2BOrder.findUnique({
    where: { id: orderId },
  });

  if (!order) {
    order = await prisma.b2BOrder.findUnique({
      where: { shopifyOrderId: orderId },
    });
  }

  // Create company credit transaction
  const orderTransactions = await prisma.creditTransaction.findFirst({
    where: {
      companyId: internalCompanyId,
      OR: [
        { orderId: orderId },
        order ? { orderId: order.id } : {},
        order?.shopifyOrderId ? { orderId: order.shopifyOrderId } : {}
      ].filter(item => Object.keys(item).length > 0) as any,
    },
  });

  if (orderTransactions) {
    const updatedTx = await prisma.creditTransaction.update({
      where: { id: orderTransactions.id },
      data: {
        companyId: internalCompanyId,
        userId,
        orderId,
        transactionType: "order_updated",
        creditAmount: amountDecimal.negated(), // Negative for deduction
        previousBalance: previousBalance,
        newBalance: newBalance,
        notes: `Credit updated for order ${orderId} by user ${userId}`,
        createdBy: userId,
      },
    });
    console.log(`✅ CreditTransaction updated:`, {
      id: updatedTx.id,
      type: updatedTx.transactionType,
      amount: updatedTx.creditAmount.toString(),
      newBalance: updatedTx.newBalance.toString()
    });
  } else {
    const orderTransaction = await prisma.creditTransaction.create({
      data: {
        companyId: internalCompanyId,
        userId,
        orderId,
        transactionType,
        creditAmount: amountDecimal.negated(), // Negative for deduction
        previousBalance: previousBalance,
        newBalance: newBalance,
        notes: `Credit deducted for order ${orderId} by user ${userId}`,
        createdBy: userId,
      },
    });
    console.log(`✅ CreditTransaction stored:`, {
      id: orderTransaction.id,
      type: orderTransaction.transactionType,
      amount: orderTransaction.creditAmount.toString(),
      newBalance: orderTransaction.newBalance.toString()
    });
  }
 

  // Update user credit usage if they have a limit
  if (creditInfo.user.hasUserLimit) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        userCreditUsed: {
          increment: amountDecimal,
        },
      },
    });
  }

  // Update order with credit tracking
  // Reuse the order object we fetched earlier for ID robustness
  if (!order) {
    order = await prisma.b2BOrder.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      order = await prisma.b2BOrder.findUnique({
        where: { shopifyOrderId: orderId },
      });
    }
  }

  if (order) {
    await prisma.b2BOrder.update({
      where: { id: order.id },
      data: {
        creditUsed: amountDecimal,
        userCreditUsed: creditInfo.user.hasUserLimit
          ? amountDecimal
          : new Decimal(0),
        remainingBalance: amountDecimal,
      },
    });
  }

  // **Auto-sync metafields for checkout extension**
  // Run in background to avoid blocking the main transaction
  autoSyncCreditMetafields(internalCompanyId, userId).catch((syncError) => {
    console.warn(
      "Failed to sync credit metafields after deduction (background):",
      syncError,
    );
  });
}

/**
 * Restore credit when order is cancelled or refunded
 */
export async function restoreTieredCredit(
  companyId: string,
  userId: string,
  orderId: string,
  amount: number | Decimal,
  reason: "cancelled" | "refunded" = "cancelled",
): Promise<void> {
  const amountDecimal = new Decimal(amount);

  // Get the original order to see how much user credit was used
  const order = await prisma.b2BOrder.findUnique({
    where: { id: orderId },
    select: { userCreditUsed: true },
  });

  if (!order) {
    throw new Error("Order not found");
  }

  // Get current credit info
  const creditInfo = await calculateTieredCreditAvailability(companyId, userId);
  if (!creditInfo) {
    throw new Error("Company or user not found");
  }

  // Create credit transaction for restoration
  await prisma.creditTransaction.create({
    data: {
      companyId,
      userId,
      orderId,
      transactionType:
        reason === "cancelled" ? "order_cancelled" : "payment_received",
      creditAmount: amountDecimal, // Positive for restoration
      previousBalance: creditInfo.company.availableCredit,
      newBalance: creditInfo.company.availableCredit.plus(amountDecimal),
      notes: `Credit restored for ${reason} order ${orderId}`,
      createdBy: userId,
    },
  });

  // Restore user credit if it was originally deducted
  if (order.userCreditUsed.greaterThan(0)) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        userCreditUsed: {
          decrement: order.userCreditUsed,
        },
      },
    });
  }
}

/**
 * Get comprehensive credit summary for a user
 */
export async function getUserCreditSummary(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      company: {
        select: {
          id: true,
          name: true,
          creditLimit: true,
        },
      },
    },
  });

  if (!user || !user.company) {
    return null;
  }

  const tieredCreditInfo = await calculateTieredCreditAvailability(
    user.companyId!,
    user.id,
  );

  if (!tieredCreditInfo) {
    return null;
  }

  // Get user's recent orders
  const recentOrders = await prisma.b2BOrder.findMany({
    where: {
      createdByUserId: userId,
      companyId: user.companyId!,
    },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true,
      orderTotal: true,
      userCreditUsed: true,
      orderStatus: true,
      paymentStatus: true,
      createdAt: true,
    },
  });

  return {
    user: {
      id: user.id,
      name: `${user.firstName} ${user.lastName}`.trim(),
      email: user.email,
      userCreditLimit: user.userCreditLimit,
      userCreditUsed: user.userCreditUsed,
      hasUserLimit: user.userCreditLimit !== null,
    },
    company: {
      id: user.company.id,
      name: user.company.name,
      creditLimit: user.company.creditLimit,
    },
    creditInfo: tieredCreditInfo,
    recentOrders,
  };
}

/**
 * Set or update user credit limit
 */
export async function setUserCreditLimit(
  userId: string,
  creditLimit: number | Decimal | null,
  setByUserId: string,
): Promise<{ success: boolean; message: string }> {
  const limitDecimal = creditLimit !== null ? new Decimal(creditLimit) : null;

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        companyId: true,
        userCreditLimit: true,
        userCreditUsed: true,
      },
    });

    if (!user) {
      return { success: false, message: "User not found" };
    }

    // If setting a limit lower than current usage, reject
    if (limitDecimal && user.userCreditUsed.greaterThan(limitDecimal)) {
      return {
        success: false,
        message: `Cannot set limit below current usage. Current usage: $${user.userCreditUsed.toFixed(2)}`,
      };
    }

    await prisma.user.update({
      where: { id: userId },
      data: { userCreditLimit: limitDecimal },
    });

    // Log the change
    const changeMessage = limitDecimal
      ? `Credit limit set to $${limitDecimal.toFixed(2)}`
      : "Credit limit removed (unlimited)";

    if (user.companyId) {
      await prisma.creditTransaction.create({
        data: {
          companyId: user.companyId,
          userId: userId,
          transactionType: "credit_adjustment",
          creditAmount: new Decimal(0), // No actual credit change, just limit adjustment
          previousBalance: new Decimal(0),
          newBalance: new Decimal(0),
          notes: changeMessage,
          createdBy: setByUserId,
        },
      });
    }

    return { success: true, message: changeMessage };
  } catch (error) {
    console.error("Error setting user credit limit:", error);
    return { success: false, message: "Failed to update credit limit" };
  }
}

// Re-export existing functions for backwards compatibility
export {
  calculateAvailableCredit,
  canCreateOrder,
  deductCredit,
  restoreCredit,
  getCreditSummary,
} from "./creditService";
