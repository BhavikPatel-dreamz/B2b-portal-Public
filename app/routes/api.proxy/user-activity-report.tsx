import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../../shopify.server";
import { getStoreByDomain } from "../../services/store.server";
import prisma from "../../db.server";
import { Decimal } from "@prisma/client/runtime/library";

interface UserActivityRequest {
  companyId: string;
  userId: string;
  shop: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  offset?: number;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    await authenticate.public.appProxy(request);

    const requestData: UserActivityRequest = await request.json();
    const { companyId, userId, shop, dateFrom, dateTo, limit = 20, offset = 0 } = requestData;

    // Validate required fields
    if (!companyId || !userId || !shop) {
      return Response.json(
        {
          error: "Missing required fields: companyId, userId, shop",
        },
        { status: 400 }
      );
    }

    // Validate limit and offset
    const validLimit = Math.min(Math.max(1, limit), 100);
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

    // Get user and verify they belong to the company
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        companyId: true,
        companyRole: true,
        createdAt: true,
      },
    });

    if (!user) {
      return Response.json({ error: "User not found" }, { status: 404 });
    }

    if (user.companyId !== companyId) {
      return Response.json(
        { error: "User does not belong to this company" },
        { status: 403 }
      );
    }

    // Build where clause for orders
    const whereClause: any = {
      companyId,
      createdByUserId: userId,
    };

    if (dateFrom || dateTo) {
      whereClause.createdAt = {};
      if (dateFrom) {
        whereClause.createdAt.gte = new Date(dateFrom);
      }
      if (dateTo) {
        const dateToEnd = new Date(dateTo);
        dateToEnd.setHours(23, 59, 59, 999);
        whereClause.createdAt.lte = dateToEnd;
      }
    }

    // Get total count
    const totalCount = await prisma.b2BOrder.count({
      where: whereClause,
    });

    // Get orders created by this user
    const orders = await prisma.b2BOrder.findMany({
      where: whereClause,
      orderBy: {
        createdAt: "desc",
      },
      take: validLimit,
      skip: validOffset,
      select: {
        id: true,
        shopifyOrderId: true,
        orderTotal: true,
        creditUsed: true,
        paidAmount: true,
        remainingBalance: true,
        paymentStatus: true,
        orderStatus: true,
        createdAt: true,
        updatedAt: true,
        paidAt: true,
      },
    });

    // Calculate user credit usage statistics
    const allUserOrders = await prisma.b2BOrder.findMany({
      where: {
        companyId,
        createdByUserId: userId,
      },
      select: {
        orderTotal: true,
        creditUsed: true,
        paidAmount: true,
        remainingBalance: true,
        paymentStatus: true,
        orderStatus: true,
      },
    });

    const stats = {
      totalOrders: allUserOrders.length,
      totalOrderValue: allUserOrders.reduce(
        (sum, order) => sum.plus(order.orderTotal),
        new Decimal(0)
      ),
      totalCreditUsed: allUserOrders.reduce(
        (sum, order) => sum.plus(order.creditUsed),
        new Decimal(0)
      ),
      totalPaid: allUserOrders.reduce((sum, order) => sum.plus(order.paidAmount), new Decimal(0)),
      outstandingBalance: allUserOrders.reduce(
        (sum, order) => sum.plus(order.remainingBalance),
        new Decimal(0)
      ),
      ordersByStatus: {
        draft: allUserOrders.filter((o) => o.orderStatus === "draft").length,
        submitted: allUserOrders.filter((o) => o.orderStatus === "submitted").length,
        processing: allUserOrders.filter((o) => o.orderStatus === "processing").length,
        shipped: allUserOrders.filter((o) => o.orderStatus === "shipped").length,
        delivered: allUserOrders.filter((o) => o.orderStatus === "delivered").length,
        cancelled: allUserOrders.filter((o) => o.orderStatus === "cancelled").length,
      },
      ordersByPaymentStatus: {
        pending: allUserOrders.filter((o) => o.paymentStatus === "pending").length,
        partial: allUserOrders.filter((o) => o.paymentStatus === "partial").length,
        paid: allUserOrders.filter((o) => o.paymentStatus === "paid").length,
        cancelled: allUserOrders.filter((o) => o.paymentStatus === "cancelled").length,
      },
    };

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
    }));

    return Response.json(
      {
        success: true,
        company: {
          id: company.id,
          name: company.name,
        },
        user: {
          id: user.id,
          email: user.email,
          name: [user.firstName, user.lastName].filter(Boolean).join(" "),
          companyRole: user.companyRole,
          memberSince: user.createdAt,
        },
        statistics: {
          totalOrders: stats.totalOrders,
          totalOrderValue: stats.totalOrderValue.toNumber(),
          totalCreditUsed: stats.totalCreditUsed.toNumber(),
          totalPaid: stats.totalPaid.toNumber(),
          outstandingBalance: stats.outstandingBalance.toNumber(),
          ordersByStatus: stats.ordersByStatus,
          ordersByPaymentStatus: stats.ordersByPaymentStatus,
          averageOrderValue:
            stats.totalOrders > 0
              ? stats.totalOrderValue.dividedBy(stats.totalOrders).toNumber()
              : 0,
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
          dateFrom,
          dateTo,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Error fetching user activity report:", error);
    return Response.json(
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
};
