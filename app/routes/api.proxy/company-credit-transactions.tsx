import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../../shopify.server";
import { getStoreByDomain } from "../../services/store.server";
import prisma from "../../db.server";
import type { Prisma } from "@prisma/client";

interface CreditTransactionsRequest {
  companyId: string;
  shop: string;
  filters?: {
    transactionType?: "order_created" | "order_paid" | "order_cancelled" | "credit_adjustment" | "payment_received";
    dateFrom?: string;
    dateTo?: string;
    orderId?: string;
  };
  limit?: number;
  offset?: number;
  export?: "csv" | "json";
}

/**
 * Convert transactions to CSV format
 */
function convertToCSV(transactions: any[]): string {
  if (transactions.length === 0) {
    return "No data available";
  }

  // Headers
  const headers = [
    "Transaction ID",
    "Date",
    "Type",
    "Credit Amount",
    "Previous Balance",
    "New Balance",
    "Order ID",
    "Notes",
    "Created By",
  ];

  // Rows
  const rows = transactions.map((tx) => [
    tx.id,
    new Date(tx.createdAt).toISOString(),
    tx.transactionType,
    tx.creditAmount,
    tx.previousBalance,
    tx.newBalance,
    tx.orderId || "N/A",
    tx.notes ? `"${tx.notes.replace(/"/g, '""')}"` : "N/A",
    tx.createdBy,
  ]);

  // Combine headers and rows
  const csvContent = [headers.join(","), ...rows.map((row) => row.join(","))].join("\n");

  return csvContent;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    await authenticate.public.appProxy(request);

    const requestData: CreditTransactionsRequest = await request.json();
    const {
      companyId,
      shop,
      filters = {},
      limit = 50,
      offset = 0,
      export: exportFormat,
    } = requestData;

    // Validate required fields
    if (!companyId || !shop) {
      return Response.json(
        {
          error: "Missing required fields: companyId, shop",
        },
        { status: 400 }
      );
    }

    // Validate limit and offset
    const validLimit = exportFormat ? 10000 : Math.min(Math.max(1, limit), 100); // Max 100 for regular, 10000 for export
    const validOffset = Math.max(0, offset);

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

    // Build where clause
    const whereClause: Prisma.CreditTransactionWhereInput = {
      companyId,
    };

    if (filters.transactionType) {
      whereClause.transactionType = filters.transactionType;
    }

    if (filters.orderId) {
      whereClause.orderId = filters.orderId;
    }

    if (filters.dateFrom || filters.dateTo) {
      whereClause.createdAt = {};
      if (filters.dateFrom) {
        whereClause.createdAt.gte = new Date(filters.dateFrom);
      }
      if (filters.dateTo) {
        const dateTo = new Date(filters.dateTo);
        dateTo.setHours(23, 59, 59, 999); // End of day
        whereClause.createdAt.lte = dateTo;
      }
    }

    // Get total count
    const totalCount = await prisma.creditTransaction.count({
      where: whereClause,
    });

    // Get transactions
    const transactions = await prisma.creditTransaction.findMany({
      where: whereClause,
      orderBy: {
        createdAt: "desc",
      },
      take: validLimit,
      skip: validOffset,
      select: {
        id: true,
        transactionType: true,
        creditAmount: true,
        previousBalance: true,
        newBalance: true,
        notes: true,
        createdBy: true,
        createdAt: true,
        orderId: true,
      },
    });

    // Format transactions for response
    const formattedTransactions = transactions.map((tx) => ({
      id: tx.id,
      transactionType: tx.transactionType,
      creditAmount: tx.creditAmount.toNumber(),
      previousBalance: tx.previousBalance.toNumber(),
      newBalance: tx.newBalance.toNumber(),
      notes: tx.notes,
      createdBy: tx.createdBy,
      createdAt: tx.createdAt,
      orderId: tx.orderId,
    }));

    // Handle export formats
    if (exportFormat === "csv") {
      const csvContent = convertToCSV(formattedTransactions);
      return new Response(csvContent, {
        status: 200,
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="credit-transactions-${companyId}-${new Date().toISOString().split("T")[0]}.csv"`,
        },
      });
    }

    if (exportFormat === "json") {
      return new Response(JSON.stringify(formattedTransactions, null, 2), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="credit-transactions-${companyId}-${new Date().toISOString().split("T")[0]}.json"`,
        },
      });
    }

    // Calculate summary statistics
    const summary = {
      totalTransactions: totalCount,
      totalCreditAdded: formattedTransactions
        .filter((tx) => tx.creditAmount > 0)
        .reduce((sum, tx) => sum + tx.creditAmount, 0),
      totalCreditDeducted: Math.abs(
        formattedTransactions
          .filter((tx) => tx.creditAmount < 0)
          .reduce((sum, tx) => sum + tx.creditAmount, 0)
      ),
    };

    return Response.json(
      {
        success: true,
        company: {
          id: company.id,
          name: company.name,
        },
        transactions: formattedTransactions,
        summary,
        pagination: {
          total: totalCount,
          limit: validLimit,
          offset: validOffset,
          hasMore: validOffset + validLimit < totalCount,
          totalPages: Math.ceil(totalCount / validLimit),
          currentPage: Math.floor(validOffset / validLimit) + 1,
        },
        filters: {
          transactionType: filters.transactionType,
          dateFrom: filters.dateFrom,
          dateTo: filters.dateTo,
          orderId: filters.orderId,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Error fetching credit transactions:", error);
    return Response.json(
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
};
