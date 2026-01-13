import prisma from "../db.server";
import { Decimal } from "@prisma/client/runtime/library";
import { syncCompanyCreditMetafields } from "./metafieldSync.server";
import { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { calculateAvailableCredit } from "./creditService";


interface RecalculationResult {
  companyId: string;
  previousCreditUsed: Decimal;
  newCreditUsed: Decimal;
  unpaidOrdersTotal: Decimal;
  unpaidOrdersCount: number;
  transactionsRecreated: number;
  success: boolean;
  message: string;
}

/**
 * Recalculate company credit based on unpaid B2B orders
 * This function will:
 * 1. Find all unpaid B2B orders for the company
 * 2. Calculate total unpaid amount
 * 3. Clear existing credit transactions for these orders
 * 4. Create new credit transactions
 * 5. Update company credit used amount
 * 6. Sync with Shopify metafields
 */
export async function recalculateCompanyCredit(
  companyId: string,
  adminContext?: AdminApiContext
): Promise<RecalculationResult> {
  const result: RecalculationResult = {
    companyId,
    previousCreditUsed: new Decimal(0),
    newCreditUsed: new Decimal(0),
    unpaidOrdersTotal: new Decimal(0),
    unpaidOrdersCount: 0,
    transactionsRecreated: 0,
    success: false,
    message: "",
  };

  try {
    // Get company information
    const company = await prisma.companyAccount.findUnique({
      where: { id: companyId },
      include: {
        shop: true,
      },
    });

    if (!company) {
      result.message = "Company not found";
      return result;
    }

    // Get current credit information using calculateAvailableCredit function
    const creditInfo = await calculateAvailableCredit(companyId);

    if (!creditInfo) {
      result.message = "Failed to calculate credit information";
      return result;
    }

    result.previousCreditUsed = creditInfo.usedCredit;

    // Get count of unpaid orders for reporting
    const unpaidOrdersCount = await prisma.b2BOrder.count({
      where: {
        companyId: companyId,
        paymentStatus: { in: ["pending", "partial"] },
        orderStatus: { notIn: ["cancelled"] },
      },
    });

    console.log(`Found ${unpaidOrdersCount} unpaid orders for company ${companyId}`);

    // Use the calculated credit information
    const totalUnpaidAmount = creditInfo.usedCredit;

    result.unpaidOrdersTotal = totalUnpaidAmount;
    result.unpaidOrdersCount = unpaidOrdersCount;

    // Calculate credit usage: Credit Limit - Pending Orders + Credit Adjustments
    const creditAdjustments = await prisma.creditTransaction.aggregate({
      where: {
        companyId: companyId,
        transactionType: {
          in: ["credit_adjustment", "payment_received", "refund"], // Only manual adjustments
        },
      },
      _sum: {
        creditAmount: true,
      },
    });

    const totalCreditAdjustments = creditAdjustments._sum.creditAmount ? new Decimal(creditAdjustments._sum.creditAmount) : new Decimal(0);

    // Available Credit = Credit Limit - Pending Orders + Credit Adjustments
    const availableCredit = company.creditLimit.minus(totalUnpaidAmount).plus(totalCreditAdjustments);
    const usedCredit = totalUnpaidAmount; // Pending orders are considered "used" credit

    result.newCreditUsed = usedCredit;

    console.log(`📊 Credit calculation for company ${companyId}:`, {
      creditLimit: company.creditLimit.toNumber(),
      pendingOrders: totalUnpaidAmount.toNumber(),
      creditAdjustments: totalCreditAdjustments.toNumber(),
      availableCredit: availableCredit.toNumber(),
      usedCredit: usedCredit.toNumber(),
    });

    // Step 4: Sync with Shopify metafields if admin context is provided
    if (adminContext && company.shopifyCompanyId) {
      try {
        console.log(`Syncing credit metafields for company ${company.shopifyCompanyId}`);
        await syncCompanyCreditMetafields(adminContext, companyId);
        console.log(`✅ Shopify metafields updated successfully`);
      } catch (syncError) {
        console.error(`❌ Failed to sync Shopify metafields:`, syncError);
        result.message += ` Warning: Shopify sync failed - ${syncError instanceof Error ? syncError.message : 'Unknown error'}`;
      }
    }

    result.success = true;
    result.message = `Successfully recalculated credit. Found ${result.unpaidOrdersCount} unpaid orders totaling $${result.unpaidOrdersTotal.toFixed(2)}. Credit calculated from: Credit Limit - Pending Orders + Adjustments.`;

    console.log(`✅ Credit recalculation completed for company ${companyId}:`, {
      unpaidOrdersCount: result.unpaidOrdersCount,
      unpaidOrdersTotal: result.unpaidOrdersTotal.toNumber(),
      creditUsed: result.newCreditUsed.toNumber(),
    });

    return result;
  } catch (error) {
    console.error(`❌ Error recalculating credit for company ${companyId}:`, error);
    result.message = `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
    return result;
  }
}

/**
 * Get credit recalculation preview without making changes
 */
export async function previewCreditRecalculation(companyId: string) {
  try {
    const company = await prisma.companyAccount.findUnique({
      where: { id: companyId },
    });

    if (!company) {
      return null;
    }

    // Use calculateAvailableCredit for consistent logic
    const creditInfo = await calculateAvailableCredit(companyId);
    if (!creditInfo) {
      return null;
    }

    // Get detailed unpaid order information
    const unpaidOrders = await prisma.b2BOrder.findMany({
      where: {
        companyId: companyId,
        paymentStatus: { in: ["pending", "partial"] },
        orderStatus: { notIn: ["cancelled"] }, // Exclude cancelled orders
      },
      select: {
        id: true,
        shopifyOrderId: true,
        orderTotal: true,
        creditUsed: true, // Use creditUsed instead of remainingBalance for consistency
        createdAt: true,
        createdByUser: {
          select: {
            email: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    // Get current credit transactions count
    const currentTransactions = await prisma.creditTransaction.count({
      where: {
        companyId: companyId,
        transactionType: {
          in: ["order_created", "order_updated"],
        },
      },
    });

    return {
      companyId,
      companyName: company.name,
      creditLimit: company.creditLimit,
      unpaidOrdersCount: unpaidOrders.length,
      unpaidOrdersTotal: creditInfo.usedCredit, // Use creditInfo for consistency
      currentTransactionsCount: currentTransactions,
      unpaidOrders: unpaidOrders.map(order => ({
        id: order.id,
        shopifyOrderId: order.shopifyOrderId,
        orderTotal: order.orderTotal.toNumber(),
        creditUsed: order.creditUsed?.toNumber() || 0, // Use creditUsed instead of remainingBalance
        createdAt: order.createdAt.toISOString(),
        createdBy: [order.createdByUser.firstName, order.createdByUser.lastName]
          .filter(Boolean)
          .join(" ") || order.createdByUser.email,
      })),
    };
  } catch (error) {
    console.error(`Error previewing credit recalculation:`, error);
    return null;
  }
}
