import type { ActionFunctionArgs } from "react-router";
import {
  getAdvancedCompanyOrders
} from "../../utils/b2b-customer.server";
import {
  getCachedCustomerCompanyInfo,
  getCachedProxyStore,
  getProxyParams,
} from "app/utils/proxy.server";
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
  sourceType?: "NORMAL" | "QUICK_ORDER" | "SALES_PORTAL" | "NETSUITE";
  source?: string;
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

interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  endCursor: string | null;
  startCursor: string | null;
  first?: number;
}

// ============================================================
// 🛠️  HELPERS
// ============================================================

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

// ============================================================
// ✏️  ACTION — POST request
// ============================================================

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const startTime = Date.now();

  const { shop, loggedInCustomerId: customerId } = getProxyParams(request);

  const {
    filters,
    pagination,
  }: {
    customerId: string;
    shop: string;
    filters?: OrderRequestFilters;
    pagination?: { page?: number; limit?: number };
  } = await request.json();

  if (!customerId || !shop) {
    return Response.json(
      { error: !customerId ? "Customer ID required" : "Shop required" },
      { status: 400 },
    );
  }

  // ── STEP 1: Get store (DB — fast) ───────────────────────
  const store = await getCachedProxyStore(shop);
  if (!store || !store.accessToken) {
    return Response.json({ error: "Store not found" }, { status: 404 });
  }

  // ── STEP 2: Get Company Info ───────────────────────────
  const companyInfo = await getCachedCustomerCompanyInfo(
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
  let accessLevel: "main_contact" | "company_admin" | "location_admin" | "location_user" =
    "location_user";

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

  const userLocationAssignments = company.roleAssignments.filter(
    (ra: { locationId?: string }) => ra.locationId,
  );
  const userAssignedLocationIds =
    userLocationAssignments.length > 0
      ? ([
          ...new Set(
            userLocationAssignments.map((ra: { locationId: string }) => ra.locationId),
          ),
        ] as string[])
      : [];

  if (isMainContact) {
    accessLevel = "main_contact";
    allowedLocationIds = undefined;
    console.log(`✅ MAIN CONTACT: Full company access`);
  } else if (isCompanyAdmin) {
    accessLevel = "company_admin";
    allowedLocationIds = undefined;
    console.log(`✅ COMPANY ADMIN: Full company access`);
  } else if (isLocationAdmin) {
    accessLevel = "location_admin";
    allowedLocationIds =
      userAssignedLocationIds.length > 0 ? userAssignedLocationIds : undefined;
    console.log(
      allowedLocationIds
        ? `🏢 LOCATION ADMIN: Restricted to ${allowedLocationIds.length} locations`
        : `🏢 LOCATION ADMIN: Default company access`,
    );
  } else {
    accessLevel = "location_user";
    allowedLocationIds =
      userAssignedLocationIds.length > 0 ? userAssignedLocationIds : undefined;
    console.log(
      allowedLocationIds
        ? `👤 LOCATION USER: Assigned to ${allowedLocationIds.length} locations`
        : `👤 LOCATION USER: Default customer access`,
    );
  }

  // ── STEP 4: Build query filters ──────────────────────────
  const queryFilters = {
    locationId: filters?.locationId,
    customerId: accessLevel === "location_user" ? customerId : filters?.customerId,
    dateRange: filters?.dateRange
      ? { preset: filters.dateRange.preset, start: filters.dateRange.start, end: filters.dateRange.end }
      : undefined,
    financialStatus:    filters?.financialStatus,
    fulfillmentStatus:  filters?.fulfillmentStatus,
    query:              filters?.query,
    sortKey:            filters?.sortKey,
    reverse:            filters?.reverse,
  };

  if (allowedLocationIds?.length && queryFilters.locationId) {
    const hasAccess = allowedLocationIds.some(
      (id) => extractId(id) === extractId(queryFilters.locationId!),
    );
    if (!hasAccess) {
      return Response.json({
        orders: [], totalCount: 0, accessLevel,
        error: "You do not have access to orders from the specified location",
        pagination: { page: 1, limit: 20, totalPages: 0 },
      });
    }
  }

  const companyData = await prisma.companyAccount.findFirst({
    where: { shopifyCompanyId: company.companyId },
  });

  if (!companyData) {
    return Response.json(
      { error: "Company account not found in B2B portal" },
      { status: 404 },
    );
  }

  // ── STEP 5: Fetch orders from Shopify ───────────────────
  const fetchAndFilterOrders = async (f: OrderRequestFilters) => {
    const result = await getAdvancedCompanyOrders(shop, store.accessToken, {
      companyId: company.companyId,
      allowedLocationIds,
      filters: f,
    });
    return {
      result,
      filteredOrders: result.orders || [],
      count: result.orders?.length || 0,
    };
  };

  // Run main orders + month counts in parallel
  const [
    { result, filteredOrders: allOrders },
    { count: ordersCurrentMonth },
    { count: ordersPreviousMonth },
  ] = await Promise.all([
    fetchAndFilterOrders(queryFilters),
    fetchAndFilterOrders({ ...queryFilters, dateRange: { preset: "current_month" } }),
    fetchAndFilterOrders({ ...queryFilters, dateRange: { preset: "last_month" } }),
  ]);

  if ((allOrders as any).error) {
    return Response.json(
      { error: (allOrders as any).error, accessLevel },
      { status: 500 },
    );
  }

  // ── STEP 5.5: Post-filter by sourceType / source if specified ───────
  let finalOrders = allOrders;
  if (filters?.sourceType) {
    const targetType = filters.sourceType.toUpperCase();
    finalOrders = finalOrders.filter(
      (o: any) => (o.sourceType || "NORMAL").toUpperCase() === targetType,
    );
  } else if (filters?.source) {
    const targetSource = filters.source.toLowerCase();
    finalOrders = finalOrders.filter(
      (o: any) => (o.source || "").toLowerCase() === targetSource,
    );
  }

  // ── STEP 6: Paginate ────────────────────────────────────
  const page       = pagination?.page  || 1;
  const limit      = pagination?.limit || 20;
  const startIndex = (page - 1) * limit;
  const totalCount = finalOrders.length;
  const totalPages = Math.ceil(totalCount / limit);

  const paginatedOrders = finalOrders.slice(startIndex, startIndex + limit);

  // ── STEP 7: Enrich with B2B Portal DB records ────────────
  const shopifyOrderIds = paginatedOrders
    .map((o: any) => o.id)
    .filter(Boolean);

  const dbOrders =
    shopifyOrderIds.length > 0
      ? await prisma.b2BOrder.findMany({
          where: {
            shopifyOrderId: { in: shopifyOrderIds },
          },
          select: {
            shopifyOrderId: true,
            creditUsed: true,
            userCreditUsed: true,
            paidAmount: true,
            remainingBalance: true,
            paymentStatus: true,
            orderStatus: true,
            source: true,
            poNumber: true,
          },
        })
      : [];

  const dbOrdersMap = new Map(
    dbOrders.map((dbo) => [dbo.shopifyOrderId, dbo]),
  );

  const enrichedOrders = paginatedOrders.map((order: any) => {
    const dbMatch = dbOrdersMap.get(order.id);
    const sourceType =
      order.sourceType ||
      (dbMatch?.source ? dbMatch.source.toUpperCase() : "NORMAL");

    return {
      ...order,
      sourceType,
      source: order.source || dbMatch?.source || sourceType.toLowerCase(),
      poNumber: order.poNumber || dbMatch?.poNumber || null,
      b2bCreditInfo: dbMatch
        ? {
            creditUsed: dbMatch.creditUsed.toNumber(),
            userCreditUsed: dbMatch.userCreditUsed.toNumber(),
            paidAmount: dbMatch.paidAmount.toNumber(),
            remainingBalance: dbMatch.remainingBalance.toNumber(),
            paymentStatus: dbMatch.paymentStatus,
            orderStatus: dbMatch.orderStatus,
          }
        : null,
    };
  });

  const responseData = {
    orders: enrichedOrders,
    totalCount,
    accessLevel,
    allowedLocationIds: allowedLocationIds?.length || "all",
    userRoles:    company.roles,
    isMainContact,
    currentMonthOrderCount:  ordersCurrentMonth,
    previousMonthOrderCount: ordersPreviousMonth,
    monthlyChangePercentage:
      ordersPreviousMonth > 0
        ? Math.round(
            ((ordersCurrentMonth - ordersPreviousMonth) / ordersPreviousMonth) * 100,
          )
        : 0,
    pagination: {
      page,
      limit,
      totalPages,
      hasNextPage:     page < totalPages,
      hasPreviousPage: page > 1,
    },
  };

  console.log(`🚀 API Time: ${Date.now() - startTime}ms`);

  return Response.json(responseData);
};
