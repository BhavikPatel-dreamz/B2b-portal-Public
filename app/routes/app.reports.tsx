import { useState, useCallback } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, Link, useNavigate, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { Prisma } from "@prisma/client";
import { formatCredit } from "../utils/company.utils";
import { Popover, DatePicker, Icon, Button, Spinner, InlineStack, Box } from "@shopify/polaris";
import { CalendarIcon } from "@shopify/polaris-icons";

interface CompanyStats {
// ... (rest of interfaces)
  companyId: string;
  companyName: string;
  orderCount: number;
  totalRevenue: number;
}

interface ProductStats {
  productId: string;
  title: string;
  variantTitle: string;
  sku: string;
  quantity: number;
  revenue: number;
  currencyCode: string;
}

interface LoaderData {
  totalB2BOrders: number;
  totalB2BRevenue: number;
  quickOrderCount: number;
  quickOrderRevenue: number;
  companyStats: CompanyStats[];
  topProducts: ProductStats[];
  currencyCode: string;
  currentFilter: string;
  startDate?: string;
  endDate?: string;
  companyPagination: {
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
  };
}

const getDateRange = (filter: string, start?: string | null, end?: string | null) => {
  if (filter === "custom" && start) {
    // Parsing YYYY-MM-DD as UTC explicitly
    const startDate = new Date(`${start}T00:00:00Z`);
    const endDate = new Date(`${end || start}T23:59:59Z`);
    
    if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
      return { gte: startDate, lte: endDate };
    }
  }

  const now = new Date();
  let startDate: Date | undefined;

  switch (filter) {
    case "week":
      // Start of current week (Sunday)
      startDate = new Date(now);
      startDate.setDate(now.getDate() - now.getDay());
      startDate.setHours(0, 0, 0, 0);
      break;
    case "month":
      // Start of current month
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      startDate.setHours(0, 0, 0, 0);
      break;
    case "year":
      // Start of current year
      startDate = new Date(now.getFullYear(), 0, 1);
      startDate.setHours(0, 0, 0, 0);
      break;
    default:
      startDate = undefined;
  }

  return startDate ? { gte: startDate } : undefined;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const filter = url.searchParams.get("filter") || "month";
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const pageSize = 10;

  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!store) {
    throw new Error("Store not found");
  }

  const dateFilter = getDateRange(filter, start, end);

  const whereClause: Prisma.B2BOrderWhereInput = {
    shopId: store.id,
    orderStatus: { notIn: ["draft", "cancelled", "converted", "archived"] },
    shopifyOrderId: { not: null },
    ...(dateFilter ? { createdAt: dateFilter } : {}),
  };

  // 1. General B2B Stats & Quick Order Stats
  const [generalStats, quickOrderStats] = await Promise.all([
    prisma.b2BOrder.aggregate({
      _count: { id: true },
      _sum: { orderTotal: true },
      where: whereClause,
    }),
    prisma.b2BOrder.aggregate({
      _count: { id: true },
      _sum: { orderTotal: true },
      where: {
        ...whereClause,
        source: "quick_order",
      },
    }),
  ]);

  // 2. Company-wise breakdown
  // First, get the total count of unique companies for this whereClause
  const totalCompaniesCountResult = await prisma.b2BOrder.groupBy({
    by: ["companyId"],
    where: whereClause,
  });
  const totalCompaniesCount = totalCompaniesCountResult.length;
  const totalPages = Math.ceil(totalCompaniesCount / pageSize);

  const companyGrouped = await prisma.b2BOrder.groupBy({
    by: ["companyId"],
    _count: { id: true },
    _sum: { orderTotal: true },
    where: whereClause,
    orderBy: {
      _sum: {
        orderTotal: "desc",
      },
    },
    skip: (page - 1) * pageSize,
    take: pageSize,
  });

  const companyIds = companyGrouped.map((c) => c.companyId);
  const companies = await prisma.companyAccount.findMany({
    where: { id: { in: companyIds } },
    select: { id: true, name: true },
  });

  const companyStats: CompanyStats[] = companyGrouped.map((group) => {
    const company = companies.find((c) => c.id === group.companyId);
    return {
      companyId: group.companyId,
      companyName: company?.name || "Unknown Company",
      orderCount: group._count.id,
      totalRevenue: Number(group._sum.orderTotal || 0),
    };
  });

  // 3. Top Products (Aggregated from recent Shopify orders)
  // We'll fetch the last 100 orders that are recorded in our B2BOrder table
  const recentB2BOrders = await prisma.b2BOrder.findMany({
    where: whereClause,
    select: { shopifyOrderId: true, orderStatus: true },
    orderBy: { createdAt: "desc" },
    take: 50, // Limit to recent 50 for performance
  });

  const b2bShopifyIds = recentB2BOrders
    .map((o) => {
      if (!o.shopifyOrderId) return null;
      if (o.shopifyOrderId.startsWith("gid://")) return o.shopifyOrderId;
      
      const type = o.orderStatus === "draft" ? "DraftOrder" : "Order";
      return `gid://shopify/${type}/${o.shopifyOrderId}`;
    })
    .filter(Boolean) as string[];

  const topProducts: ProductStats[] = [];

  if (b2bShopifyIds.length > 0) {
    // Construct GraphQL query to fetch line items for these orders
    // Using a simple loop or one big query with aliases. 
    // For simplicity and robustness, let's use a loop or fetch a batch of orders.
    
    const productAggregation = new Map<string, ProductStats>();

    // Fetch details in batches of 10
    for (let i = 0; i < b2bShopifyIds.length; i += 10) {
      const batch = b2bShopifyIds.slice(i, i + 10);
      const query = `
        query getOrders($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Order {
              id
              lineItems(first: 50) {
                edges {
                  node {
                    title
                    variantTitle
                    sku
                    quantity
                    originalUnitPriceSet {
                      shopMoney {
                        amount
                        currencyCode
                      }
                    }
                    product {
                      id
                    }
                  }
                }
              }
            }
            ... on DraftOrder {
              id
              lineItems(first: 50) {
                edges {
                  node {
                    title
                    variantTitle
                    sku
                    quantity
                    originalUnitPriceSet {
                      shopMoney {
                        amount
                        currencyCode
                      }
                    }
                    product {
                      id
                    }
                  }
                }
              }
            }
          }
        }
      `;

      const response = await admin.graphql(query, { variables: { ids: batch } });
      const responseJson: any = await response.json();
      const nodes = responseJson.data?.nodes || [];

      for (const order of nodes) {
        if (!order?.lineItems?.edges) continue;

        for (const edge of order.lineItems.edges) {
          const item = edge.node;
          const productId = item.product?.id || "unknown";
          const sku = item.sku || "no-sku";
          const key = `${productId}-${sku}`;

          const existing = productAggregation.get(key);
          const price = Number(item.originalUnitPriceSet?.shopMoney?.amount || 0);
          const qty = Number(item.quantity || 0);

          if (existing) {
            existing.quantity += qty;
            existing.revenue += price * qty;
          } else {
            productAggregation.set(key, {
              productId,
              title: item.title,
              variantTitle: item.variantTitle,
              sku,
              quantity: qty,
              revenue: price * qty,
              currencyCode: item.originalUnitPriceSet?.shopMoney?.currencyCode || store.currencyCode || "USD",
            });
          }
        }
      }
    }

    topProducts.push(...Array.from(productAggregation.values())
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 10));
  }

  return Response.json({
    totalB2BOrders: generalStats?._count?.id || 0,
    totalB2BRevenue: Number(generalStats?._sum?.orderTotal || 0),
    quickOrderCount: quickOrderStats?._count?.id || 0,
    quickOrderRevenue: Number(quickOrderStats?._sum?.orderTotal || 0),
    companyStats,
    topProducts,
    currencyCode: store.currencyCode || "USD",
    currentFilter: filter,
    startDate: start || undefined,
    endDate: end || undefined,
    companyPagination: {
      page,
      pageSize,
      totalCount: totalCompaniesCount,
      totalPages,
    },
  });
};

export default function Reports() {
  const data = useLoaderData<LoaderData>();

  const pageShellStyle = {
    background: "#f1f2f4",
    minHeight: "100vh",
    padding: "24px",
    fontFamily: '-apple-system, BlinkMacSystemFont, "San Francisco", "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
  } as const;

  const cardStyle = {
    background: "white",
    borderRadius: "12px",
    padding: "20px",
    boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
    marginBottom: "20px",
  } as const;

  const titleStyle = {
    fontSize: "20px",
    fontWeight: "700",
    color: "#202223",
    marginBottom: "20px",
  } as const;

  const statGridStyle = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
    gap: "16px",
    marginBottom: "24px",
  } as const;

  const statCardStyle = {
    background: "white",
    borderRadius: "10px",
    padding: "20px",
    border: "1px solid #dfe3e8",
    boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
  } as const;

  const statValueStyle = {
    fontSize: "28px",
    fontWeight: "700",
    color: "#202223",
    margin: "8px 0",
  } as const;

  const tableHeaderStyle = {
    background: "#f6f6f7",
    padding: "12px",
    textAlign: "left" as const,
    fontSize: "12px",
    fontWeight: "600",
    color: "#6d7175",
    textTransform: "uppercase" as const,
    borderBottom: "1px solid #dfe3e8",
  };

  const tableCellStyle = {
    padding: "14px 12px",
    fontSize: "14px",
    color: "#202223",
    borderBottom: "1px solid #f1f2f4",
  };

  const paginationContainerStyle = {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    gap: "12px",
    marginTop: "20px",
    paddingTop: "20px",
    borderTop: "1px solid #dfe3e8",
  } as const;

  const paginationButtonStyle = (isDisabled: boolean) => ({
    padding: "6px 12px",
    borderRadius: "6px",
    border: "1px solid #dfe3e8",
    background: isDisabled ? "#f6f6f7" : "white",
    color: isDisabled ? "#8c9196" : "#202223",
    fontSize: "13px",
    fontWeight: "600",
    cursor: isDisabled ? "not-allowed" : "pointer",
    textDecoration: "none",
    pointerEvents: isDisabled ? "none" as const : "auto" as const,
  } as const);

  const filterBarStyle = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    background: "white",
    padding: "8px",
    borderRadius: "8px",
    width: "fit-content",
    border: "1px solid #dfe3e8",
    marginBottom: "24px",
  } as const;

  const getPaginationUrl = (page: number) => {
    const params = new URLSearchParams();
    params.set("filter", data.currentFilter);
    if (data.startDate) params.set("start", data.startDate);
    if (data.endDate) params.set("end", data.endDate);
    params.set("page", page.toString());
    return `?${params.toString()}`;
  };

  const navigate = useNavigate();
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";
  const pendingFilter = navigation.location ? new URLSearchParams(navigation.location.search).get("filter") : null;

  const [popoverActive, setPopoverActive] = useState(false);
  const [{ month, year }, setMonthYear] = useState({
    month: data.startDate ? new Date(data.startDate).getMonth() : new Date().getMonth(),
    year: data.startDate ? new Date(data.startDate).getFullYear() : new Date().getFullYear()
  });
  
  const [selectedDates, setSelectedDates] = useState({
    start: data.startDate ? new Date(data.startDate) : new Date(),
    end: data.endDate ? new Date(data.endDate) : new Date(),
  });

  const handleMonthChange = useCallback(
    (month: number, year: number) => setMonthYear({ month, year }),
    [],
  );

  const togglePopoverActive = useCallback(
    () => setPopoverActive((active) => !active),
    [],
  );

  const handleDateSelection = useCallback(({ start, end }: { start: Date, end: Date }) => {
    setSelectedDates({ start, end });
    if (start) {
        const formatDate = (date: Date) => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        };

        const params = new URLSearchParams();
        params.set("filter", "custom");
        params.set("start", formatDate(start));
        const endDate = end || start;
        params.set("end", formatDate(endDate));
        navigate(`?${params.toString()}`);
        
        // If it's a single date selection (start and end are same), close the popover
        if (start.getTime() === endDate.getTime()) {
            setPopoverActive(false);
        }
    }
  }, [navigate]);

  const activator = (
    <Button
        onClick={togglePopoverActive}
        icon={CalendarIcon}
        pressed={popoverActive}
        loading={isLoading && pendingFilter === "custom"}
        variant={data.currentFilter === "custom" ? "primary" : undefined}
    >
        {data.currentFilter === "custom" && data.startDate ? (
            data.startDate === data.endDate || !data.endDate 
                ? `Date: ${data.startDate}` 
                : `${data.startDate} - ${data.endDate}`
        ) : (
            "Specific Date"
        )}
    </Button>
  );

  return (
    <div style={pageShellStyle}>
      <div style={{ maxWidth: "1200px", margin: "0 auto" }}>
        {/* Header */}
        <div style={{ marginBottom: "24px" }}>
            <Link
                to="/app"
                style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "8px",
                    color: "#2c6ecb",
                    textDecoration: "none",
                    fontSize: "14px",
                    fontWeight: 600,
                    marginBottom: "12px"
                }}
            >
                <svg viewBox="0 0 20 20" style={{ width: "16px", height: "16px" }} fill="currentColor">
                    <path fillRule="evenodd" d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z" clipRule="evenodd" />
                </svg>
                Back to Dashboard
            </Link>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: "16px", marginBottom: "24px" }}>
                <div>
                    <h1 style={{ fontSize: "24px", fontWeight: "700", color: "#202223" }}>Admin Reports</h1>
                    <p style={{ color: "#5c5f62", marginTop: "4px" }}>Comprehensive overview of your B2B sales and activity.</p>
                </div>
                
                {/* Filters */}
                <div style={filterBarStyle}>
                    <InlineStack gap="200" align="start" blockAlign="center">
                        <Popover
                            active={popoverActive}
                            activator={activator}
                            onClose={() => setPopoverActive(false)}
                            preferredAlignment="left"
                        >
                            <Box padding="400">
                                <DatePicker
                                    month={month}
                                    year={year}
                                    onChange={handleDateSelection}
                                    onMonthChange={handleMonthChange}
                                    selected={selectedDates}
                                    allowRange
                                />
                            </Box>
                        </Popover>

                        <Button
                            onClick={() => navigate("?filter=all")}
                            variant={data.currentFilter === "all" ? "primary" : undefined}
                            loading={isLoading && pendingFilter === "all"}
                        >
                            All Time
                        </Button>
                        <Button
                            onClick={() => navigate("?filter=week")}
                            variant={data.currentFilter === "week" ? "primary" : undefined}
                            loading={isLoading && pendingFilter === "week"}
                        >
                            This Week
                        </Button>
                        <Button
                            onClick={() => navigate("?filter=month")}
                            variant={data.currentFilter === "month" ? "primary" : undefined}
                            loading={isLoading && pendingFilter === "month"}
                        >
                            This Month
                        </Button>
                        <Button
                            onClick={() => navigate("?filter=year")}
                            variant={data.currentFilter === "year" ? "primary" : undefined}
                            loading={isLoading && pendingFilter === "year"}
                        >
                            This Year
                        </Button>
                    </InlineStack>
                </div>
            </div>
        </div>

        {/* Summary Stats */}
        <div style={statGridStyle}>
          <div style={statCardStyle}>
            <div style={{ fontSize: "13px", color: "#6d7175", fontWeight: "600" }}>B2B Orders</div>
            <div style={statValueStyle}>{data.totalB2BOrders}</div>
            <div style={{ fontSize: "12px", color: "#6d7175" }}>For selected period</div>
          </div>
          <div style={statCardStyle}>
            <div style={{ fontSize: "13px", color: "#6d7175", fontWeight: "600" }}>B2B Revenue</div>
            <div style={statValueStyle}>{formatCredit(data.totalB2BRevenue.toString(), data.currencyCode)}</div>
            <div style={{ fontSize: "12px", color: "#6d7175" }}>For selected period</div>
          </div>
          <div style={statCardStyle}>
            <div style={{ fontSize: "13px", color: "#6d7175", fontWeight: "600" }}>Quick Order Count</div>
            <div style={statValueStyle}>{data.quickOrderCount}</div>
            <div style={{ fontSize: "12px", color: "#6d7175" }}>Via Quick Order feature</div>
          </div>
          <div style={statCardStyle}>
            <div style={{ fontSize: "13px", color: "#6d7175", fontWeight: "600" }}>Quick Order Revenue</div>
            <div style={statValueStyle}>{formatCredit(data.quickOrderRevenue.toString(), data.currencyCode)}</div>
            <div style={{ fontSize: "12px", color: "#6d7175" }}>Via Quick Order feature</div>
          </div>
        </div>

        {/* Company Breakdown */}
        <div style={cardStyle}>
          <h2 style={titleStyle}>B2B Revenue by Company</h2>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={tableHeaderStyle}>Company Name</th>
                  <th style={tableHeaderStyle}>Orders</th>
                  <th style={tableHeaderStyle}>Total Revenue</th>
                </tr>
              </thead>
              <tbody>
                {data.companyStats.length > 0 ? (
                  data.companyStats.map((company) => (
                    <tr key={company.companyId}>
                      <td style={tableCellStyle}>{company.companyName}</td>
                      <td style={tableCellStyle}>{company.orderCount}</td>
                      <td style={tableCellStyle}>{formatCredit(company.totalRevenue.toString(), data.currencyCode)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={3} style={{ ...tableCellStyle, textAlign: "center", padding: "40px" }}>No company data available</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Company Pagination */}
          {data.companyPagination.totalPages > 1 && (
            <div style={paginationContainerStyle}>
              <Link
                to={getPaginationUrl(data.companyPagination.page - 1)}
                style={paginationButtonStyle(data.companyPagination.page <= 1)}
              >
                Previous
              </Link>
              <div style={{ fontSize: "14px", color: "#6d7175" }}>
                Page {data.companyPagination.page} of {data.companyPagination.totalPages}
              </div>
              <Link
                to={getPaginationUrl(data.companyPagination.page + 1)}
                style={paginationButtonStyle(data.companyPagination.page >= data.companyPagination.totalPages)}
              >
                Next
              </Link>
            </div>
          )}
        </div>

        {/* Top Products */}
        <div style={cardStyle}>
          <h2 style={titleStyle}>Top 10 Products by B2B Orders</h2>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={tableHeaderStyle}>Product</th>
                  <th style={tableHeaderStyle}>SKU</th>
                  <th style={tableHeaderStyle}>Quantity Sold</th>
                  <th style={tableHeaderStyle}>Revenue</th>
                </tr>
              </thead>
              <tbody>
                {data.topProducts.length > 0 ? (
                  data.topProducts.map((product, idx) => (
                    <tr key={`${product.productId}-${product.sku}-${idx}`}>
                      <td style={tableCellStyle}>
                        <div style={{ fontWeight: "600" }}>{product.title}</div>
                        {product.variantTitle && product.variantTitle !== "Default Title" && (
                          <div style={{ fontSize: "12px", color: "#6d7175" }}>{product.variantTitle}</div>
                        )}
                      </td>
                      <td style={tableCellStyle}>{product.sku}</td>
                      <td style={tableCellStyle}>{product.quantity}</td>
                      <td style={tableCellStyle}>{formatCredit(product.revenue.toString(), product.currencyCode)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} style={{ ...tableCellStyle, textAlign: "center", padding: "40px" }}>No product data available (only available for recent orders)</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
