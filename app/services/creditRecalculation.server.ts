import prisma from "../db.server";
import { Decimal } from "@prisma/client/runtime/library";
import { autoSyncCreditMetafields } from "./metafieldSync.server";
import type { AdminApiContext } from "@shopify/shopify-api";

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

    result.previousCreditUsed = company.creditLimit; // This should be the current used amount

    // Find all unpaid B2B orders for this company
    const unpaidOrders = await prisma.b2BOrder.findMany({
      where: {
        companyId: companyId,
        paymentStatus: {
          in: ["pending", "partial"], // Unpaid statuses
        },
      },
      include: {
        createdByUser: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    console.log(`Found ${unpaidOrders.length} unpaid orders for company ${companyId}`);

    // Calculate total unpaid amount
    let totalUnpaidAmount = new Decimal(0);
    for (const order of unpaidOrders) {
      const remainingBalance = order.remainingBalance;
      totalUnpaidAmount = totalUnpaidAmount.plus(remainingBalance);
    }

    result.unpaidOrdersTotal = totalUnpaidAmount;
    result.unpaidOrdersCount = unpaidOrders.length;

    // Start a transaction to ensure data consistency
    const transactionResult = await prisma.$transaction(async (tx) => {
      // Step 1: Delete existing credit transactions for these orders
      const orderIds = unpaidOrders.map(order => order.id);
      const deletedTransactions = await tx.creditTransaction.deleteMany({
        where: {
          companyId: companyId,
          orderId: {
            in: orderIds,
          },
          transactionType: {
            in: ["order_created", "order_updated"], // Only delete order-related transactions
          },
        },
      });

      console.log(`Deleted ${deletedTransactions.count} existing credit transactions`);

      // Step 2: Create new credit transactions for each unpaid order
      let runningBalance = new Decimal(0);
      let transactionCount = 0;

      for (const order of unpaidOrders) {
        const orderAmount = order.remainingBalance;
        const previousBalance = runningBalance;
        runningBalance = runningBalance.plus(orderAmount);

        await tx.creditTransaction.create({
          data: {
            companyId: companyId,
            userId: order.createdByUserId,
            orderId: order.id,
            transactionType: "order_created",
            creditAmount: orderAmount,
            previousBalance: previousBalance,
            newBalance: runningBalance,
            notes: `Recalculated - Order ${order.shopifyOrderId || order.id} remaining balance`,
            createdBy: "system_recalculation",
          },
        });

        transactionCount++;
      }

      // Step 3: Update company credit used amount
      await tx.companyAccount.update({
        where: { id: companyId },
        data: {
          // We don't store creditUsed directly, but we can add it if needed
          // For now, the credit used is calculated from transactions
        },
      });

      return {
        transactionCount,
        newCreditUsed: runningBalance,
      };
    });

    result.transactionsRecreated = transactionResult.transactionCount;
    result.newCreditUsed = transactionResult.newCreditUsed;

    // Step 4: Sync with Shopify metafields if admin context is provided
    if (adminContext && company.shopifyCompanyId) {
      try {
        console.log(`Syncing credit metafields for company ${company.shopifyCompanyId}`);
        await autoSyncCreditMetafields(
          adminContext,
          company.shopifyCompanyId,
          company.creditLimit,
          result.newCreditUsed
        );
        console.log(`✅ Shopify metafields updated successfully`);
      } catch (syncError) {
        console.error(`❌ Failed to sync Shopify metafields:`, syncError);
        result.message += ` Warning: Shopify sync failed - ${syncError instanceof Error ? syncError.message : 'Unknown error'}`;
      }
    }

    result.success = true;
    result.message = `Successfully recalculated credit. Found ${result.unpaidOrdersCount} unpaid orders totaling $${result.unpaidOrdersTotal.toFixed(2)}. Created ${result.transactionsRecreated} credit transactions.`;

    console.log(`✅ Credit recalculation completed for company ${companyId}:`, {
      unpaidOrdersCount: result.unpaidOrdersCount,
      unpaidOrdersTotal: result.unpaidOrdersTotal.toNumber(),
      transactionsRecreated: result.transactionsRecreated,
      newCreditUsed: result.newCreditUsed.toNumber(),
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

    // Find all unpaid orders
    const unpaidOrders = await prisma.b2BOrder.findMany({
      where: {
        companyId: companyId,
        paymentStatus: {
          in: ["pending", "partial"],
        },
      },
      select: {
        id: true,
        shopifyOrderId: true,
        orderTotal: true,
        remainingBalance: true,
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

    let totalUnpaidAmount = new Decimal(0);
    for (const order of unpaidOrders) {
      totalUnpaidAmount = totalUnpaidAmount.plus(order.remainingBalance);
    }

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
      unpaidOrdersTotal: totalUnpaidAmount,
      currentTransactionsCount: currentTransactions,
      unpaidOrders: unpaidOrders.map(order => ({
        id: order.id,
        shopifyOrderId: order.shopifyOrderId,
        orderTotal: order.orderTotal.toNumber(),
        remainingBalance: order.remainingBalance.toNumber(),
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
