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
        // Main contact has location assignments - restrict to those locations
        allowedLocationIds = userAssignedLocationIds;
        console.log(
          `✅ MAIN CONTACT (with locations): Restricted to ${allowedLocationIds.length} assigned locations`,
        );
      } else {
        // Main contact without location assignments - full access
        allowedLocationIds = undefined;
        console.log(`✅ MAIN CONTACT (no locations): Full company access`);
      }
    } else if (isCompanyAdmin) {
      accessLevel = "company_admin";

      if (userAssignedLocationIds.length > 0) {
        // Company admin has location assignments - restrict to those locations
        allowedLocationIds = userAssignedLocationIds;
        console.log(
          `✅ COMPANY ADMIN (with locations): Restricted to ${allowedLocationIds.length} assigned locations`,
        );
      } else {
        // Company admin without location assignments - full access
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

    // ✅ FIXED: Proper filter mapping without changing preset values
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

    // Validate location access
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

    const currentMonthStartUTC = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
    );

    const currentMonthEndUTC = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999),
    );

    const previousMonthStartUTC = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 0, 0, 0, 0),
    );

    const previousMonthEndUTC = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 59, 999),
    );

    // 📊 Fetch current month orders count
    // 🔑 Base query (company + RBAC)
   // 🔑 Base query (company + RBAC)
const baseQueryParts = [`company_id:${extractId(company.companyId)}`];

// ✅ Logged-in location user → own orders only
if (accessLevel === "location_user") {
  baseQueryParts.push(`customer_id:${customerId}`);
}

const currentMonthQuery = buildDateRangeQuery(
  baseQueryParts,
  currentMonthStartUTC,
  currentMonthEndUTC,
);
console.log(currentMonthQuery);

const currentMonthCount = await getCompanyOrdersCount(
  shop,
  store.accessToken,
  currentMonthQuery,
);


    // 📅 Previous Month
    const previousMonthQuery = buildDateRangeQuery(
      baseQueryParts,
      previousMonthStartUTC,
      previousMonthEndUTC,
    );
    

    const previousMonthCount = await getCompanyOrdersCount(
      shop,
      store.accessToken,
      previousMonthQuery,
    );

    console.log({
      currentMonthCount,
      previousMonthCount,
    });

    let changePercentage = 0;

    if (previousMonthCount > 0) {
      changePercentage =
        ((currentMonthCount - previousMonthCount) / previousMonthCount) * 100;
    } else if (currentMonthCount > 0) {
      changePercentage = 100; // growth from zero
    }

    return Response.json({
      orders: result.orders,
      pageInfo: result.pageInfo,
      totalCount: result.totalCount,
      accessLevel,
      allowedLocationIds: allowedLocationIds?.length || "all",
      userRoles: company.roles,
      isMainContact,
      // 📊 Monthly Statistics
      currentMonthOrderCount: currentMonthCount,
      monthlyChangePercentage: Math.round(changePercentage * 100) / 100,
      debug: {
        ...result._debug,
        restrictedToLocations: allowedLocationIds || "none",
        restrictedToCustomer:
          accessLevel === "location_user" ? customerId : "none",
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
