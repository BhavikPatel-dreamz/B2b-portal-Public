import { Button, Text } from "@shopify/polaris";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams, Link } from "react-router";
import { useState, useEffect } from "react";
import prisma from "app/db.server";
import { authenticate } from "app/shopify.server";

type SalesDashboardFilters = {
  filterAgent: string;
  filterPaymentStatus: string;
  filterOrderStatus: string;
  filterCompany: string;
  filterDateFrom: string;
  filterDateTo: string;
};

type SalesDashboardLoaderData = {
  items: Array<any>;
  metrics: {
    totalOrders: number;
    totalQuotes: number;
    pendingOrders: number;
    pendingQuotes: number;
    totalRevenue: number;
  };
  salesUsers: Array<{ id: string; firstName: string; lastName: string; email: string }>;
  companies: Array<{ id: string; name: string }>;
  totalCount: number;
  currentPage: number;
  totalPages: number;
  activeTab: string;
  filters: SalesDashboardFilters;
  appUrl: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!store) {
    throw new Response("Store not found", { status: 404 });
  }

  const url = new URL(request.url);
  const filterAgent = url.searchParams.get("agent") || "";
  const filterPaymentStatus = url.searchParams.get("paymentStatus") || "";
  const filterOrderStatus = url.searchParams.get("orderStatus") || "";
  const filterCompany = url.searchParams.get("company") || "";
  const filterDateFrom = url.searchParams.get("dateFrom") || "";
  const filterDateTo = url.searchParams.get("dateTo") || "";
  const activeTab = url.searchParams.get("tab") || "orders"; // "orders" or "quotes"
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const limit = 15;
  const skip = (page - 1) * limit;
  const appUrl = process.env.SHOPIFY_APP_URL || "";
  // Get all sales users for filter dropdown
  const salesUsers = await prisma.user.findMany({
    where: { shopId: store.id, role: "SALES_USER" },
    select: { id: true, firstName: true, lastName: true, email: true },
    orderBy: { firstName: "asc" },
  });

  // Get all companies assigned to sales users for filter dropdown
  const salesUserIds = salesUsers.map(u => u.id);
  const assignedCompanyIds = await prisma.salesUserCompany.findMany({
    where: { userId: { in: salesUserIds } },
    select: { companyId: true },
    distinct: ["companyId"],
  });
  const companies = await prisma.companyAccount.findMany({
    where: { id: { in: assignedCompanyIds.map(ac => ac.companyId) } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  // Build where clause for orders
  const where: any = {
    shopId: store.id,
    createdByUserId: { in: salesUserIds },
  };

  // For "orders" tab: non-draft. For "quotes" tab: draft only.
  if (activeTab === "quotes") {
    where.orderStatus = "draft";
  } else {
    where.orderStatus = { notIn: ["draft", "converted", "archived"] };
  }

  if (filterAgent) {
    where.createdByUserId = filterAgent;
  }
  if (filterPaymentStatus) {
    where.paymentStatus = filterPaymentStatus;
  }
  if (filterOrderStatus && activeTab === "orders") {
    where.orderStatus = filterOrderStatus;
  }
  if (filterCompany) {
    where.companyId = filterCompany;
  }
  if (filterDateFrom || filterDateTo) {
    where.createdAt = {};
    if (filterDateFrom) where.createdAt.gte = new Date(filterDateFrom);
    if (filterDateTo) {
      const endDate = new Date(filterDateTo);
      endDate.setHours(23, 59, 59, 999);
      where.createdAt.lte = endDate;
    }
  }

  // Fetch paginated orders/quotes
  const [items, totalCount] = await Promise.all([
    prisma.b2BOrder.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
      include: {
        createdByUser: { select: { firstName: true, lastName: true, email: true } },
        company: { select: { id: true, name: true } },
      },
    }),
    prisma.b2BOrder.count({ where }),
  ]);

  // Dashboard metrics — all sales user orders (unfiltered)
  const metricsWhere = {
    shopId: store.id,
    createdByUserId: { in: salesUserIds },
  };

  const [
    totalOrders,
    totalQuotes,
    pendingOrders,
    pendingQuotes,
    revenueResult,
  ] = await Promise.all([
    prisma.b2BOrder.count({ where: { ...metricsWhere, orderStatus: { notIn: ["draft", "converted", "archived"] } } }),
    prisma.b2BOrder.count({ where: { ...metricsWhere, orderStatus: "draft" } }),
    prisma.b2BOrder.count({ where: { ...metricsWhere, orderStatus: { notIn: ["draft", "converted", "archived"] }, paymentStatus: "pending" } }),
    prisma.b2BOrder.count({ where: { ...metricsWhere, orderStatus: "draft" } }),
    prisma.b2BOrder.aggregate({
      where: { ...metricsWhere, orderStatus: { notIn: ["draft", "converted", "archived"] } },
      _sum: { orderTotal: true },
    }),
  ]);

  const totalRevenue = Number(revenueResult._sum.orderTotal ?? 0);
  const totalPages = Math.ceil(totalCount / limit);

  return Response.json({
    items: items.map(o => ({
      ...o,
      orderTotal: o.orderTotal.toString(),
      creditUsed: o.creditUsed.toString(),
      paidAmount: o.paidAmount.toString(),
      remainingBalance: o.remainingBalance.toString(),
      userCreditUsed: o.userCreditUsed.toString(),
      createdAt: o.createdAt.toISOString(),
      updatedAt: o.updatedAt.toISOString(),
      paidAt: o.paidAt?.toISOString() || null,
    })),
    metrics: { totalOrders, totalQuotes, pendingOrders, pendingQuotes, totalRevenue },
    salesUsers,
    companies,
    totalCount,
    currentPage: page,
    totalPages,
    activeTab,
    appUrl,
    filters: { filterAgent, filterPaymentStatus, filterOrderStatus, filterCompany, filterDateFrom, filterDateTo },
  });
};

export default function SalesDashboard() {
  const {
    items, metrics, salesUsers, companies,
    totalCount, currentPage, totalPages, activeTab, filters, appUrl,
  } = useLoaderData<typeof loader>() as SalesDashboardLoaderData;
  const [searchParams, setSearchParams] = useSearchParams();

  const setFilter = (key: string, value: string) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (value) {
        next.set(key, value);
      } else {
        next.delete(key);
      }
      next.set("page", "1");
      return next;
    });
  };

  const clearFilters = () => {
    setSearchParams(prev => {
      const next = new URLSearchParams();
      const shop = prev.get("shop");
      if (shop) next.set("shop", shop);
      next.set("tab", activeTab);
      return next;
    });
  };

  const formatDate = (iso: string) =>
    new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(iso));

  const formatCurrency = (val: string | number) =>
    `$${Number(val).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const statusBadge = (status: string) => {
    const colorMap: Record<string, { bg: string; color: string }> = {
      paid: { bg: "#dcfce7", color: "#166534" },
      pending: { bg: "#fef9c3", color: "#854d0e" },
      partial: { bg: "#e0f2fe", color: "#075985" },
      cancelled: { bg: "#fce4ec", color: "#b71c1c" },
      fulfilled: { bg: "#dcfce7", color: "#166534" },
      unfulfilled: { bg: "#fef9c3", color: "#854d0e" },
      draft: { bg: "#f3e8ff", color: "#6b21a8" },
      open: { bg: "#e0f2fe", color: "#075985" },
    };
    const s = colorMap[status?.toLowerCase()] || { bg: "#f3f4f6", color: "#374151" };
    return (
      <span style={{
        display: "inline-block",
        padding: "3px 10px",
        borderRadius: "20px",
        fontSize: "12px",
        fontWeight: 600,
        backgroundColor: s.bg,
        color: s.color,
        textTransform: "capitalize",
      }}>
        {status || "N/A"}
      </span>
    );
  };

  const hasActiveFilters = filters.filterAgent || filters.filterPaymentStatus ||
    filters.filterOrderStatus || filters.filterCompany || filters.filterDateFrom || filters.filterDateTo;

      const portalLoginUrl = `${appUrl}/sales/login`;
  return (
    <div style={pageShellStyle}>
      <div style={pageHeroStyle}>
        <Link to="/app" style={backLinkStyle}>
          <svg viewBox="0 0 20 20" style={{ width: "16px", height: "16px" }} fill="currentColor">
            <path fillRule="evenodd" d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z" clipRule="evenodd" />
          </svg>
          Back to Dashboard
        </Link>
        <h3 style={pageTitleStyle}>Sales Dashboard</h3>
        <p style={pageSubtitleStyle}>
          Track all orders and quotes created by your sales agents across companies.
        </p>
      </div>


      <div style={contentPanelStyle}>
        {/* Metrics Cards */}

         <div style={{
                  marginBottom: "16px",
                  padding: "14px 18px",
                  borderRadius: "12px",
                  backgroundColor: "#fff0f4",
                  border: "1px solid #f8d7e3",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "12px",
                  flexWrap: "wrap" as const,
                }}>
                  <div>
                    <Text variant="bodyMd" fontWeight="semibold" as="span">Sales Portal Login: </Text>
                    <Text variant="bodyMd" as="span">{portalLoginUrl}</Text>
                  </div>
                  <Button size="micro" onClick={() => navigator.clipboard.writeText(portalLoginUrl)}>
                    Copy URL
                  </Button>
          </div>
        <div style={metricsGridStyle}>
          <div style={metricCardStyle}>
            <div style={{ ...metricIconStyle, backgroundColor: "#e0f2fe" }}>📦</div>
            <div style={metricValueStyle}>{metrics.totalOrders}</div>
            <div style={metricLabelStyle}>Total Orders</div>
          </div>
          <div style={metricCardStyle}>
            <div style={{ ...metricIconStyle, backgroundColor: "#f3e8ff" }}>📝</div>
            <div style={metricValueStyle}>{metrics.totalQuotes}</div>
            <div style={metricLabelStyle}>Total Quotes</div>
          </div>
          <div style={metricCardStyle}>
            <div style={{ ...metricIconStyle, backgroundColor: "#fef9c3" }}>⏳</div>
            <div style={metricValueStyle}>{metrics.pendingOrders}</div>
            <div style={metricLabelStyle}>Pending Orders</div>
          </div>
          <div style={metricCardStyle}>
            <div style={{ ...metricIconStyle, backgroundColor: "#fce4ec" }}>📋</div>
            <div style={metricValueStyle}>{metrics.pendingQuotes}</div>
            <div style={metricLabelStyle}>Pending Quotes</div>
          </div>
          <div style={{ ...metricCardStyle, gridColumn: "span 1" }}>
            <div style={{ ...metricIconStyle, backgroundColor: "#dcfce7" }}>💰</div>
            <div style={metricValueStyle}>{formatCurrency(metrics.totalRevenue)}</div>
            <div style={metricLabelStyle}>Total Revenue</div>
          </div>
        </div>

        {/* Tabs */}
        <div style={tabsRowStyle}>
          {[
            { key: "orders", label: "Orders", count: metrics.totalOrders },
            { key: "quotes", label: "Quotes (Drafts)", count: metrics.totalQuotes },
          ].map(tab => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setFilter("tab", tab.key)}
              style={{
                appearance: "none",
                background: "transparent",
                borderLeft: "none",
                borderRight: "none",
                borderTop: "none",
                cursor: "pointer",
                padding: "10px 18px",
                borderBottom: activeTab === tab.key ? "2px solid #2c6ecb" : "2px solid transparent",
                color: activeTab === tab.key ? "#2c6ecb" : "#5c5f62",
                fontWeight: activeTab === tab.key ? 600 : 400,
                marginBottom: -1,
                fontSize: 14,
              }}
            >
              {tab.label} ({tab.count})
            </button>
          ))}
        </div>

        {/* Filters Toolbar */}
        <div style={toolbarStyle}>
          <select
            value={filters.filterAgent}
            onChange={e => setFilter("agent", e.target.value)}
            style={selectStyle}
          >
            <option value="">All Sales Agents</option>
            {salesUsers.map(u => (
              <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>
            ))}
          </select>

          <select
            value={filters.filterCompany}
            onChange={e => setFilter("company", e.target.value)}
            style={selectStyle}
          >
            <option value="">All Companies</option>
            {companies.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>

          <select
            value={filters.filterPaymentStatus}
            onChange={e => setFilter("paymentStatus", e.target.value)}
            style={selectStyle}
          >
            <option value="">All Payment Status</option>
            <option value="pending">Pending</option>
            <option value="paid">Paid</option>
            <option value="partial">Partial</option>
          </select>

          {activeTab === "orders" && (
            <select
              value={filters.filterOrderStatus}
              onChange={e => setFilter("orderStatus", e.target.value)}
              style={selectStyle}
            >
              <option value="">All Order Status</option>
              <option value="open">Open</option>
              <option value="fulfilled">Fulfilled</option>
              <option value="cancelled">Cancelled</option>
            </select>
          )}

          <input
            type="date"
            value={filters.filterDateFrom}
            onChange={e => setFilter("dateFrom", e.target.value)}
            style={dateInputStyle}
            placeholder="From"
          />
          <input
            type="date"
            value={filters.filterDateTo}
            onChange={e => setFilter("dateTo", e.target.value)}
            style={dateInputStyle}
            placeholder="To"
          />

          {hasActiveFilters && (
            <button onClick={clearFilters} style={clearBtnStyle}>
              ✕ Clear
            </button>
          )}
        </div>

        {/* Results Table */}
        <div style={tableCardStyle}>
          {items.length === 0 ? (
            <div style={emptyStyle}>
              <span style={{ fontSize: "36px" }}>{activeTab === "quotes" ? "📝" : "📦"}</span>
              <div style={{ fontSize: "15px", fontWeight: 600, color: "#202223", marginTop: "12px" }}>
                No {activeTab === "quotes" ? "quotes" : "orders"} found
              </div>
              <div style={{ fontSize: "13px", color: "#5c5f62", marginTop: "4px" }}>
                {hasActiveFilters ? "Try adjusting your filters." : `No ${activeTab} created by sales agents yet.`}
              </div>
            </div>
          ) : (
            <>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={thStyle}>Order Name</th>
                    <th style={thStyle}>Company</th>
                    <th style={thStyle}>Sales Agent</th>
                    <th style={thStyle}>Total</th>
                    <th style={thStyle}>Payment</th>
                    <th style={thStyle}>Status</th>
                    <th style={thStyle}>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item: any) => (
                    <tr key={item.id} style={trStyle}>
                      <td style={tdStyle}>
                        <strong style={{ color: "#2c6ecb" }}>
                          {item.orderNumber ||
                            (item.orderNumber
                              ? `#${item.orderNumber.split("/").pop()}`
                              : item.orderNumber.slice(0, 8))}
                        </strong>
                      </td>
                      <td style={tdStyle}>{item.company.name}</td>
                      <td style={tdStyle}>
                        {item.createdByUser.firstName} {item.createdByUser.lastName}
                      </td>
                      <td style={tdStyle}>{formatCurrency(item.orderTotal)}</td>
                      <td style={tdStyle}>{statusBadge(item.paymentStatus)}</td>
                      <td style={tdStyle}>{statusBadge(item.orderStatus)}</td>
                      <td style={tdStyle}>{formatDate(item.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Pagination */}
              {totalPages > 1 && (
                <div style={paginationStyle}>
                  <span style={{ fontSize: "13px", color: "#5c5f62" }}>
                    Showing {((currentPage - 1) * 15) + 1}–{Math.min(currentPage * 15, totalCount)} of {totalCount}
                  </span>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      onClick={() => setFilter("page", String(currentPage - 1))}
                      disabled={currentPage <= 1}
                      style={{ ...pageBtnStyle, opacity: currentPage <= 1 ? 0.4 : 1 }}
                    >
                      ← Prev
                    </button>
                    <button
                      onClick={() => setFilter("page", String(currentPage + 1))}
                      disabled={currentPage >= totalPages}
                      style={{ ...pageBtnStyle, opacity: currentPage >= totalPages ? 0.4 : 1 }}
                    >
                      Next →
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────
const pageShellStyle = {
  background: "#f1f2f4",
  minHeight: "100vh",
  padding: "24px",
  boxSizing: "border-box" as const,
  fontFamily: '-apple-system, BlinkMacSystemFont, "San Francisco", "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
};
const pageHeroStyle = {
  width: "100%",
  maxWidth: 1200,
  margin: "0 auto 18px",
  padding: "0px 0px 16px 0px",
  borderRadius: 14,
  border: "1px solid #dfe3e8",
  background: "linear-gradient(135deg, #ffffff 0%)",
  boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
};
const backLinkStyle = {
  display: "inline-flex" as const,
  alignItems: "center" as const,
  gap: "8px",
  color: "#2c6ecb",
  textDecoration: "none",
  fontSize: "14px",
  fontWeight: 600,
  margin: "15px 15px 5px",
};
const pageTitleStyle = {
  fontSize: "22px",
  lineHeight: 1.15,
  fontWeight: 650,
  color: "#202223",
  margin: "15px",
};
const pageSubtitleStyle = {
  fontSize: "14px",
  color: "#5c5f62",
  margin: "0 15px 0",
};
const contentPanelStyle = {
  width: "100%",
  maxWidth: 1200,
  margin: "0 auto",
  boxSizing: "border-box" as const,
};
const metricsGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(5, 1fr)",
  gap: "14px",
  marginBottom: "18px",
};
const metricCardStyle = {
  backgroundColor: "white",
  padding: "18px",
  borderRadius: 14,
  border: "1px solid #dfe3e8",
  boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
  display: "flex",
  flexDirection: "column" as const,
  gap: "8px",
};
const metricIconStyle = {
  width: "40px",
  height: "40px",
  borderRadius: "10px",
  display: "flex",
  alignItems: "center" as const,
  justifyContent: "center" as const,
  fontSize: "20px",
};
const metricValueStyle = {
  fontSize: "24px",
  fontWeight: 700,
  color: "#202223",
  lineHeight: 1,
};
const metricLabelStyle = {
  fontSize: "13px",
  color: "#5c5f62",
  fontWeight: 500,
};
const tabsRowStyle = {
  display: "flex",
  gap: 12,
  marginBottom: 16,
  paddingBottom: 2,
  borderBottom: "1px solid #e3e3e3",
  flexWrap: "wrap" as const,
};
const toolbarStyle = {
  display: "flex",
  alignItems: "center" as const,
  gap: 10,
  flexWrap: "wrap" as const,
  marginBottom: 16,
  padding: 14,
  border: "1px solid #dde3ea",
  borderRadius: 14,
  background: "linear-gradient(180deg, #ffffff 0%, #f8fbff 100%)",
};
const selectStyle = {
  padding: "8px 12px",
  borderRadius: "8px",
  border: "1px solid #c9ccd0",
  fontSize: "13px",
  outline: "none",
  minWidth: "150px",
  backgroundColor: "white",
};
const dateInputStyle = {
  padding: "8px 12px",
  borderRadius: "8px",
  border: "1px solid #c9ccd0",
  fontSize: "13px",
  outline: "none",
  width: "140px",
};
const clearBtnStyle = {
  padding: "8px 14px",
  borderRadius: "8px",
  border: "1px solid #c9ccd0",
  backgroundColor: "#fff",
  color: "#b71c1c",
  fontSize: "13px",
  fontWeight: 600,
  cursor: "pointer",
};
const tableCardStyle = {
  overflowX: "auto" as const,
  border: "1px solid #e3e7ec",
  borderRadius: 12,
  background: "#ffffff",
};
const thStyle = {
  textAlign: "left" as const,
  padding: "14px 16px",
  fontSize: 13,
  fontWeight: 650,
  color: "#202223",
  background: "#fbfbfc",
  borderBottom: "1px solid #e3e7ec",
  whiteSpace: "nowrap" as const,
};
const trStyle = {
  borderBottom: "1px solid #eef1f4",
};
const tdStyle = {
  padding: "14px 16px",
  verticalAlign: "top" as const,
  lineHeight: 1.45,
  color: "#202223",
  fontSize: "14px",
};
const emptyStyle = {
  display: "flex",
  flexDirection: "column" as const,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  padding: "48px 20px",
  textAlign: "center" as const,
};
const paginationStyle = {
  display: "flex",
  justifyContent: "space-between" as const,
  alignItems: "center" as const,
  padding: "14px 16px",
  borderTop: "1px solid #e3e7ec",
};
const pageBtnStyle = {
  padding: "6px 14px",
  borderRadius: "8px",
  border: "1px solid #c9ccd0",
  backgroundColor: "white",
  fontSize: "13px",
  fontWeight: 500,
  cursor: "pointer",
};
