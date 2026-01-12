import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../../shopify.server";
import { getStoreByDomain } from "../../services/store.server";
import {
  getCustomerCompanyInfo,
  getAdvancedCompanyOrders,
  getCompanyOrdersCount,
} from "../../utils/b2b-customer.server";

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
  endDate: Date
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
    await authenticate.public.appProxy(request);

    const {
      customerId,
      shop,
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

    // 📊 Fetch main orders
    const result = await getAdvancedCompanyOrders(shop, store.accessToken, {
      companyId: company.companyId,
      allowedLocationIds,
      filters: queryFilters,
      pagination: pagination || { first: 20 },
    });

    if (result.error) {
      return Response.json(
        { error: result.error, accessLevel },
        { status: 500 },
      );
    }

    // 📅 Calculate current and previous month date ranges
    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const currentMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    const previousMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const previousMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

    console.log("🔍 DEBUG - Date Ranges:", {
      currentMonth: {
        start: currentMonthStart.toISOString(),
        end: currentMonthEnd.toISOString(),
      },
      previousMonth: {
        start: previousMonthStart.toISOString(),
        end: previousMonthEnd.toISOString(),
      },
      now: now.toISOString(),
    });

    // ✅ OPTION 1: Try without location filter first (for debugging)
    const simpleCurrentQuery = `company_id:${extractId(company.companyId)}${
      accessLevel === "location_user" ? ` AND customer_id:${customerId}` : ""
    } AND created_at:>='${currentMonthStart.toISOString().split('T')[0]}'`;

    console.log("🔍 Simple Query Test:", simpleCurrentQuery);

    const simpleCount = await getCompanyOrdersCount(
      shop,
      store.accessToken,
      simpleCurrentQuery,
    );

    console.log("🔍 Simple Count Result:", simpleCount);

    // ✅ OPTION 2: Try with proper formatting
    const formatDateForShopify = (date: Date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    // Build queries without location filter first
    const baseQuery = `company_id:${extractId(company.companyId)}${
      accessLevel === "location_user" ? ` AND customer_id:${customerId}` : ""
    }`;

    const currentMonthQueryNoLocation = `${baseQuery} AND created_at:>='${formatDateForShopify(currentMonthStart)}' AND created_at:<='${formatDateForShopify(currentMonthEnd)}'`;
    
    const previousMonthQueryNoLocation = `${baseQuery} AND created_at:>='${formatDateForShopify(previousMonthStart)}' AND created_at:<='${formatDateForShopify(previousMonthEnd)}'`;

    console.log("📊 Queries WITHOUT location filter:", {
      current: currentMonthQueryNoLocation,
      previous: previousMonthQueryNoLocation,
    });

    const currentMonthCountNoLocation = await getCompanyOrdersCount(
      shop,
      store.accessToken,
      currentMonthQueryNoLocation,
    );

    const previousMonthCountNoLocation = await getCompanyOrdersCount(
      shop,
      store.accessToken,
      previousMonthQueryNoLocation,
    );

    console.log("📊 Counts WITHOUT location filter:", {
      current: currentMonthCountNoLocation,
      previous: previousMonthCountNoLocation,
    });

    // Now try WITH location filter
    let currentMonthCount = currentMonthCountNoLocation;
    let previousMonthCount = previousMonthCountNoLocation;

    if (allowedLocationIds && allowedLocationIds.length > 0) {
      const locationFilter = allowedLocationIds
        .map((id) => `location_id:${extractId(id)}`)
        .join(" OR ");

      const currentMonthQueryWithLocation = `${baseQuery} AND (${locationFilter}) AND created_at:>='${formatDateForShopify(currentMonthStart)}' AND created_at:<='${formatDateForShopify(currentMonthEnd)}'`;
      
      const previousMonthQueryWithLocation = `${baseQuery} AND (${locationFilter}) AND created_at:>='${formatDateForShopify(previousMonthStart)}' AND created_at:<='${formatDateForShopify(previousMonthEnd)}'`;

      console.log("📊 Queries WITH location filter:", {
        current: currentMonthQueryWithLocation,
        previous: previousMonthQueryWithLocation,
        locationIds: allowedLocationIds.map(id => extractId(id)),
      });

      currentMonthCount = await getCompanyOrdersCount(
        shop,
        store.accessToken,
        currentMonthQueryWithLocation,
      );

      previousMonthCount = await getCompanyOrdersCount(
        shop,
        store.accessToken,
        previousMonthQueryWithLocation,
      );

      console.log("📊 Counts WITH location filter:", {
        current: currentMonthCount,
        previous: previousMonthCount,
      });
    }

    // ✅ OPTION 3: Fallback - count from actual orders in result
    const ordersCurrentMonth = result.orders.filter((order: any) => {
      const orderDate = new Date(order.createdAt);
      return orderDate >= currentMonthStart && orderDate <= currentMonthEnd;
    }).length;

    console.log("📊 Count from result.orders:", ordersCurrentMonth);

    let changePercentage = 0;

    if (previousMonthCount > 0) {
      changePercentage =
        ((currentMonthCount - previousMonthCount) / previousMonthCount) * 100;
    } else if (currentMonthCount > 0) {
      changePercentage = 100;
    }

    return Response.json({
      orders: result.orders,
      pageInfo: result.pageInfo,
      totalCount: result.totalCount,
      accessLevel,
      allowedLocationIds: allowedLocationIds?.length || "all",
      userRoles: company.roles,
      isMainContact,
      currentMonthOrderCount: ordersCurrentMonth,
      monthlyChangePercentage: Math.round(ordersCurrentMonth * 100) / 100,
      debug: {
        ...result._debug,
        restrictedToLocations: allowedLocationIds || "none",
        restrictedToCustomer: accessLevel === "location_user" ? customerId : "none",
        userAssignedLocations: userAssignedLocationIds.length,
      },
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