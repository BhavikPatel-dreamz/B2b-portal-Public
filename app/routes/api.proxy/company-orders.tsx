import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../../shopify.server";
import { getStoreByDomain } from "../../services/store.server";
import prisma from "../../db.server";
import type { Prisma } from "@prisma/client";

interface CompanyOrdersRequest {
  companyId: string;
  shop: string;
  filters?: {
    paymentStatus?: "pending" | "partial" | "paid" | "cancelled";
    orderStatus?: "draft" | "submitted" | "processing" | "shipped" | "delivered" | "cancelled";
    dateFrom?: string;
    dateTo?: string;
  };
  sortBy?: "newest" | "oldest" | "amount_high" | "amount_low";
  limit?: number;
  offset?: number;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    await authenticate.public.appProxy(request);

    const requestData: CompanyOrdersRequest = await request.json();
    const {
      companyId,
      shop,
      filters = {},
      sortBy = "newest",
      limit = 20,
      offset = 0,
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
    const validLimit = Math.min(Math.max(1, limit), 100); // Max 100 items per page
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
    const whereClause: Prisma.B2BOrderWhereInput = {
      companyId,
    };

    if (filters.paymentStatus) {
      whereClause.paymentStatus = filters.paymentStatus;
    }

    if (filters.orderStatus) {
      whereClause.orderStatus = filters.orderStatus;
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

    // Build orderBy clause
    let orderBy: Prisma.B2BOrderOrderByWithRelationInput = {};
    switch (sortBy) {
      case "newest":
        orderBy = { createdAt: "desc" };
        break;
      case "oldest":
        orderBy = { createdAt: "asc" };
        break;
      case "amount_high":
        orderBy = { orderTotal: "desc" };
        break;
      case "amount_low":
        orderBy = { orderTotal: "asc" };
        break;
      default:
        orderBy = { createdAt: "desc" };
    }

    // Get total count
    const totalCount = await prisma.b2BOrder.count({
      where: whereClause,
    });

    // Get orders
    const orders = await prisma.b2BOrder.findMany({
      where: whereClause,
      orderBy,
      take: validLimit,
      skip: validOffset,
      include: {
        createdByUser: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        },
        payments: {
          select: {
            id: true,
            amount: true,
            method: true,
            status: true,
            receivedAt: true,
            createdAt: true,
          },
          orderBy: {
            createdAt: "desc",
          },
        },
      },
    });

    // Format orders for response
    const formattedOrders = orders.map((order) => ({
      id: order.id,
      shopifyOrderId: order.shopifyOrderId,
      orderTotal: order.orderTotal.toNumber(),
      creditUsed: order.creditUsed.toNumber(),
      paidAmount: order.paidAmount.toNumber(),
      remainingBalance: order.remainingBalance.toNumber(),
      paymentStatus: order.paymentStatus,
      orderStatus: order.orderStatus,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      paidAt: order.paidAt,
      createdBy: {
        id: order.createdByUser.id,
        email: order.createdByUser.email,
        name: [order.createdByUser.firstName, order.createdByUser.lastName]
          .filter(Boolean)
          .join(" "),
      },
      payments: order.payments.map((payment) => ({
        id: payment.id,
        amount: payment.amount.toNumber(),
        method: payment.method,
        status: payment.status,
        receivedAt: payment.receivedAt,
        createdAt: payment.createdAt,
      })),
      paymentCount: order.payments.length,
    }));

    return Response.json(
      {
        success: true,
        company: {
          id: company.id,
          name: company.name,
        },
        orders: formattedOrders,
        pagination: {
          total: totalCount,
          limit: validLimit,
          offset: validOffset,
          hasMore: validOffset + validLimit < totalCount,
          totalPages: Math.ceil(totalCount / validLimit),
          currentPage: Math.floor(validOffset / validLimit) + 1,
        },
        filters: {
          paymentStatus: filters.paymentStatus,
          orderStatus: filters.orderStatus,
          dateFrom: filters.dateFrom,
          dateTo: filters.dateTo,
          sortBy,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Error fetching company orders:", error);
    return Response.json(
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
};
