import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../../shopify.server";
import { getStoreByDomain } from "../../services/store.server";
import {
  getCustomerCompanyInfo,
  getAdvancedCompanyOrders,
  getCompanyOrdersCount,
} from "../../utils/b2b-customer.server";
import { getProxyParams } from "app/utils/proxy.server";
import prisma from "app/db.server";

interface OrderRequestFilters {
  query?: string;
  dateRange?: {
    preset?:
      | "last_week"
      | "current_month"
      | "last_month"
      | "last_3_months"
      | "custom"
      | "all";
    start?: string;
    end?: string;
  };
  financialStatus?: string;
  fulfillmentStatus?: string;
  locationId?: string;
  customerId?: string;
  sortKey?:
    | "CREATED_AT"
    | "UPDATED_AT"
    | "ORDER_NUMBER"
    | "TOTAL_PRICE"
    | "FINANCIAL_STATUS";
  reverse?: boolean;
}

interface OrderRequestPagination {
  first?: number;
  after?: string;
  last?: number;
  before?: string;
}

export function buildDateRangeQuery(
  baseQueryParts: string[],
  startDate: Date,
  endDate: Date,
): string {
  return [
    ...baseQueryParts,
    `created_at:>=${startDate.toISOString()}`,
    `created_at:<=${endDate.toISOString()}`,
  ].join(" AND ");
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const { shop, loggedInCustomerId: customerId } = getProxyParams(request);

    const {
      filters,
      pagination,
    }: {
      customerId: string;
      shop: string;
      filters?: OrderRequestFilters;
      pagination?: OrderRequestPagination;
    } = await request.json();

    if (!customerId || !shop) {
      return Response.json(
        {
          error: !customerId ? "Customer ID required" : "Shop required",
        },
        { status: 400 },
      );
    }

    const store = await getStoreByDomain(shop);
    if (!store || !store.accessToken) {
      return Response.json({ error: "Store not found" }, { status: 404 });
    }

    const companyInfo = await getCustomerCompanyInfo(
      customerId,
      shop,
      store.accessToken,
    );
    if (!companyInfo.hasCompany || !companyInfo.companies?.length) {
      return Response.json(
        { error: "Customer not associated with company" },
        { status: 403 },
      );
    }

    const company = companyInfo.companies[0];
    const extractId = (id: string) => id.split("/").pop() || id;

    let allowedLocationIds: string[] | undefined = undefined;
    let accessLevel:
      | "main_contact"
      | "company_admin"
      | "location_admin"
      | "location_user" = "location_user";

    const isMainContact =
      company.mainContact?.id === `gid://shopify/Customer/${customerId}`;
    const isCompanyAdmin = company.roles.some((r: string) => {
      const roleLower = r.toLowerCase();
      return (
        roleLower === "admin" ||
        roleLower === "company admin" ||
        (roleLower.includes("admin") && !roleLower.includes("location"))
      );
    });
    const isLocationAdmin = company.roles.some(
      (r: string) => r.toLowerCase() === "location admin",
    );

    // 🔍 Get user's location assignments
    const userLocationAssignments = company.roleAssignments.filter(
      (ra: any) => ra.locationId,
    );
    const userAssignedLocationIds =
      userLocationAssignments.length > 0
        ? ([
            ...new Set(userLocationAssignments.map((ra: any) => ra.locationId)),
          ] as string[])
        : [];

    // ✅ MODIFIED: Main contact access based on location assignments
    if (isMainContact) {
      accessLevel = "main_contact";

      if (userAssignedLocationIds.length > 0) {
        allowedLocationIds = userAssignedLocationIds;
        console.log(
          `✅ MAIN CONTACT (with locations): Restricted to ${allowedLocationIds.length} assigned locations`,
        );
      } else {
        allowedLocationIds = undefined;
        console.log(`✅ MAIN CONTACT (no locations): Full company access`);
      }
    } else if (isCompanyAdmin) {
      accessLevel = "company_admin";

      if (userAssignedLocationIds.length > 0) {
        allowedLocationIds = userAssignedLocationIds;
        console.log(
          `✅ COMPANY ADMIN (with locations): Restricted to ${allowedLocationIds.length} assigned locations`,
        );
      } else {
        allowedLocationIds = undefined;
        console.log(`✅ COMPANY ADMIN (no locations): Full company access`);
      }
    } else if (isLocationAdmin) {
      accessLevel = "location_admin";

      if (userAssignedLocationIds.length > 0) {
        allowedLocationIds = userAssignedLocationIds;
        console.log(
          `🏢 LOCATION ADMIN: Restricted to ${allowedLocationIds.length} locations`,
        );
      } else {
        return Response.json({
          orders: [],
          pageInfo: {
            hasNextPage: false,
            hasPreviousPage: false,
            endCursor: null,
            startCursor: null,
          },
          totalCount: 0,
          accessLevel,
          message: "No location assignments found",
        });
      }
    } else {
      accessLevel = "location_user";

      if (userAssignedLocationIds.length > 0) {
        allowedLocationIds = userAssignedLocationIds;
        console.log(
          `👤 LOCATION USER: Own orders only in ${allowedLocationIds.length} locations`,
        );
      } else {
        return Response.json({
          orders: [],
          pageInfo: {
            hasNextPage: false,
            hasPreviousPage: false,
            endCursor: null,
            startCursor: null,
          },
          totalCount: 0,
          accessLevel,
          message: "No location assignments found",
        });
      }
    }

    const queryFilters = {
      locationId: filters?.locationId,
      customerId:
        accessLevel === "location_user" ? customerId : filters?.customerId,
      dateRange: filters?.dateRange
        ? {
            preset: filters.dateRange.preset,
            start: filters.dateRange.start,
            end: filters.dateRange.end,
          }
        : undefined,
      financialStatus: filters?.financialStatus,
      fulfillmentStatus: filters?.fulfillmentStatus,
      query: filters?.query,
      sortKey: filters?.sortKey,
      reverse: filters?.reverse,
    };

    if (allowedLocationIds?.length && queryFilters.locationId) {
      const hasAccess = allowedLocationIds.some(
        (id) => extractId(id) === extractId(queryFilters.locationId!),
      );

      if (!hasAccess) {
        return Response.json({
          orders: [],
          pageInfo: {
            hasNextPage: false,
            hasPreviousPage: false,
            endCursor: null,
            startCursor: null,
          },
          totalCount: 0,
          accessLevel,
          error: "You do not have access to orders from the specified location",
        });
      }
    }

    const companyData = await prisma.companyAccount.findFirst({
      where: {
        shopifyCompanyId: company.companyId,
      },
    });
    
    const userData = await prisma.user.findFirst({
      where: {
        companyId: companyData.id,
        role: "STORE_ADMIN",
      },
    });

    // Helper function to determine location filtering
    const getEffectiveLocationIds = () => 
      userData?.role === "STORE_ADMIN" ? undefined : allowedLocationIds;

    // ✅ FIXED: Helper function to fetch and filter orders
    const fetchAndFilterOrders = async (
      filters: any,
      pagination: any
    ) => {
      // Fetch orders from Shopify (already filtered by location in getAdvancedCompanyOrders)
      const result = await getAdvancedCompanyOrders(shop, store.accessToken, {
        companyId: company.companyId,
        allowedLocationIds: getEffectiveLocationIds(),
        filters,
        pagination,
      });

      const groupedOrders = await prisma.b2BOrder.groupBy({
        by: ["shopifyOrderId"],
        where: {
          orderStatus: {
            not: "cancelled",
          },
          companyId: companyData.id,
          shopifyOrderId: {
            in: result.orders?.map((order: any) => order.id) || [],
          },
        },
      });

      const uniqueShopifyOrderIds = groupedOrders.map((order) => order.shopifyOrderId);
      const filteredOrders = result.orders?.filter((order: any) =>
        uniqueShopifyOrderIds.includes(order.id)
      );


      return { result, filteredOrders, count: groupedOrders.length };
    };

    // Fetch main orders
    const { result, filteredOrders: orders } = await fetchAndFilterOrders(
      queryFilters,
      pagination || { first: 10 }
    );

    if (orders.error) {
      return Response.json(
        { error: orders.error, accessLevel },
        { status: 500 },
      );
    }

    // 🔢 Fetch SEPARATE queries for month counts (without pagination limit)
    const { count: ordersCurrentMonth } = await fetchAndFilterOrders(
      {
        ...queryFilters,
        dateRange: { preset: "current_month" },
      },
      { first: 250 }
    );

    const { count: ordersPreviousMonth } = await fetchAndFilterOrders(
      {
        ...queryFilters,
        dateRange: { preset: "last_month" },
      },
      { first: 250 }
    );

    return Response.json({
      orders: orders,
      pageInfo: result.pageInfo,
      totalCount: orders.length,
      accessLevel,
      allowedLocationIds: allowedLocationIds?.length || "all",
      userRoles: company.roles,
      isMainContact,
      currentMonthOrderCount: ordersCurrentMonth,
      previousMonthOrderCount: ordersPreviousMonth,
      monthlyChangePercentage: ordersPreviousMonth > 0 
        ? Math.round(
            ((ordersCurrentMonth - ordersPreviousMonth) / ordersPreviousMonth) * 100
          )
        : 0,
    });
  } catch (error) {
    console.error("Proxy error:", error);
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
        accessLevel: "unknown",
      },
      { status: 500 },
    );
  }
};
