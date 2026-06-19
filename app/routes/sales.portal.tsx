import { redirect, useLoaderData, Link } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import type { Prisma } from "@prisma/client";
import prisma from "app/db.server";
import {
  requireSalesSession,
  hasCompanyAccess,
  buildClearSessionCookie,
} from "app/utils/sales-session.server";
import {
  SalesPortalHeader,
  SalesPortalLayout,
  salesPortalButtonStyles,
} from "app/components/SalesPortalLayout";
import {
  getOrderAccessWhere,
  getOrderNumber,
  getShopifyOrderWhere,
} from "app/services/sales-order-management.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { user } = await requireSalesSession(request);

  const url = new URL(request.url);
  let companyId = url.searchParams.get("companyId");

  if (!companyId && user.salesCompanies.length > 0) {
    companyId = user.salesCompanies[0].companyId;
  }

  if (!companyId) {
    return redirect("/sales/portal");
  }

  if (!hasCompanyAccess(user, companyId)) {
    return redirect("/sales/portal");
  }

  // Get full company data
  const company = await prisma.companyAccount.findUnique({
    where: { id: companyId },
    include: {
      shop: {
        select: { shopName: true, shopDomain: true, accessToken: true },
      },
    },
  });

  if (!company) {
    return redirect("/sales/portal");
  }

  // Fetch real-time users directly from Shopify (fixes the issue where Shopify users aren't synced locally)
  let activeUsers: Array<{
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    companyRole: string | null;
  }> = [];
  type ShopifyCompanyCustomer = {
    customer: {
      id: string;
      email: string;
      firstName?: string | null;
      lastName?: string | null;
      roleAssignments?: {
        edges?: Array<{
          node?: { role?: { name?: string | null } | null } | null;
        }>;
      } | null;
    };
  };

  if (company.shopifyCompanyId && company.shop.accessToken) {
    const { getCompanyCustomers } =
      await import("app/utils/b2b-customer.server");
    const customersData = await getCompanyCustomers(
      company.shopifyCompanyId,
      company.shop.shopDomain,
      company.shop.accessToken,
      { first: 50 },
    );

    if (!customersData.error && customersData.customers) {
      activeUsers = customersData.customers
        .map((c: any) => {
          const firstName = c.customer.firstName?.trim() || null;
          const lastName = c.customer.lastName?.trim() || null;
          const companyRole =
            c.customer.roleAssignments?.edges?.[0]?.node?.role?.name ||
            "Ordering only";
          const customerId = c.customer.id.split("/").pop();

          return {
            id: customerId,
            email: c.customer.email,
            firstName,
            lastName,
            shopifyCustomerId: customerId,
            companyRole,
          };
        })
        .filter((u: any) => u.companyRole?.toLowerCase() === "location admin");
    }
  }

  // Get recent orders for this company using the same access rules as the orders page
  const recentOrderWhere: Prisma.B2BOrderWhereInput = {
    AND: [
      getOrderAccessWhere(user),
      getShopifyOrderWhere(),
      { companyId: company.id },
    ],
  };
  const recentOrders = await prisma.b2BOrder.findMany({
    where: recentOrderWhere,
    orderBy: { createdAt: "desc" },
    take: 15,
    include: {
      company: { select: { id: true, name: true } },
      createdByUser: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      items: { select: { quantity: true } },
    },
  });

  const orderCount = await prisma.b2BOrder.count({
    where: recentOrderWhere,
  });

  const quoteCount = await prisma.quote.count({
    where: { companyId: company.id },
  });

  // Get credit data
  const creditOrderWhere: Prisma.B2BOrderWhereInput = {
    AND: [
      recentOrderWhere,
      {
        paymentStatus: { in: ["pending", "partial"] },
        orderStatus: { notIn: ["cancelled", "converted", "archived"] },
      },
    ],
  };
  const pendingCreditOrders = await prisma.b2BOrder.aggregate({
    where: creditOrderWhere,
    _sum: { remainingBalance: true },
  });

  const creditLimit = Number(company.creditLimit ?? 0);
  const usedCredit = Number(pendingCreditOrders._sum.remainingBalance ?? 0);
  const availableCredit = creditLimit - usedCredit;

  return Response.json({
    user: {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
    },
    company: {
      ...company,
      creditLimit: creditLimit.toString(),
      usedCredit: usedCredit.toString(),
      availableCredit: availableCredit.toString(),
      storeName: company.shop.shopName || company.shop.shopDomain,
      users: activeUsers,
    },
    recentOrders: recentOrders.map((o) => ({
      id: o.id,
      orderNumber: getOrderNumber(o),
      customerName: o.customerName,
      customerEmail: o.customerEmail,
      company: o.company,
      salesAgent: o.createdByUser,
      itemCount: o.items.length,
      quantity: o.items.reduce((sum, item) => sum + item.quantity, 0),
      orderTotal: o.orderTotal?.toString() || "0",
      currencyCode: o.currencyCode,
      paymentStatus: o.paymentStatus,
      orderStatus: o.orderStatus,
      createdAt: o.createdAt.toISOString(),
      updatedAt: o.updatedAt.toISOString(),
    })),
    orderCount,
    quoteCount,
    allCompanies: user.salesCompanies.map((sc) => ({
      id: sc.company.id,
      name: sc.company.name,
    })),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "logout") {
    return redirect("/sales/login", {
      headers: {
        "Set-Cookie": buildClearSessionCookie(),
      },
    });
  }

  return Response.json({ error: "Unknown intent" });
};

export default function SalesPortal() {
  const { user, company, recentOrders, orderCount, quoteCount, allCompanies } =
    useLoaderData<{
      user: {
        id: string;
        firstName: string | null;
        lastName: string | null;
        email: string;
      };
      company: {
        id: string;
        name: string;
        contactEmail: string | null;
        creditLimit: string;
        usedCredit: string;
        availableCredit: string;
        storeName: string | null;
        users: Array<{
          id: string;
          email: string;
          firstName: string | null;
          lastName: string | null;
          companyRole: string | null;
        }>;
      };
      recentOrders: Array<{
        id: string;
        orderNumber: string;
        orderTotal: string;
        currencyCode: string;
        paymentStatus: string;
        orderStatus: string;
        createdAt: string;
      }>;
      orderCount: number;
      quoteCount: number;
      allCompanies: Array<{ id: string; name: string }>;
    }>();

  const formatDate = (iso: string) =>
    new Intl.DateTimeFormat("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(new Date(iso));

  const formatCurrency = (val: string | number, currency = "USD") =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(Number(val) || 0);

  const getStatusBadge = (status: string) => {
    const map: Record<string, { bg: string; color: string }> = {
      paid: { bg: "#dcfce7", color: "#166534" },
      pending: { bg: "#fef9c3", color: "#854d0e" },
      partial: { bg: "#e0f2fe", color: "#075985" },
      cancelled: { bg: "#fce4ec", color: "#b71c1c" },
      fulfilled: { bg: "#dcfce7", color: "#166534" },
      unfulfilled: { bg: "#fef9c3", color: "#854d0e" },
      draft: { bg: "#f3e8ff", color: "#6b21a8" },
    };
    const s = map[status?.toLowerCase()] || { bg: "#f3f4f6", color: "#374151" };
    return (
      <span
        style={{
          padding: "4px 10px",
          borderRadius: "20px",
          fontSize: "12px",
          fontWeight: 600,
          backgroundColor: s.bg,
          color: s.color,
          textTransform: "capitalize" as const,
        }}
      >
        {status || "N/A"}
      </span>
    );
  };

  const creditPercent =
    Number(company.creditLimit) > 0
      ? Math.min(
          100,
          (Number(company.usedCredit) / Number(company.creditLimit)) * 100,
        )
      : 0;

  return (
    <SalesPortalLayout
      company={company}
      user={user}
      activePage="overview"
      orderCount={orderCount}
      quoteCount={quoteCount}
    >
      <div id="overview">
        <SalesPortalHeader
          title={company.name}
          subtitle={`${company.contactEmail ? `Contact: ${company.contactEmail}` : "Sales Portal"} · ${company.users.length} customer(s) · ${company.storeName}`}
          companyId={company.id}
          companies={allCompanies}
          actions={
            <>
              <Link
                to={`/sales/portal/company/${company.id}/create-order`}
                style={salesPortalButtonStyles.primary}
              >
                <span>+</span> Create Order
              </Link>
              <Link
                to={`/sales/portal/company/${company.id}/create-quote`}
                style={salesPortalButtonStyles.secondary}
              >
                <span>+</span> Create Quote
              </Link>
            </>
          }
        />

        {/* Credit Limit Card */}
        <div style={styles.creditCard}>
          <div style={styles.creditHeader}>
            <h2 style={styles.creditTitle}>Company Credit</h2>
          </div>
          <div style={styles.creditBody}>
            <div
              className="sales-portal-credit-stats"
              style={styles.creditStatGroup}
            >
              <div style={styles.creditStat}>
                <span style={styles.creditStatLabel}>Credit Limit</span>
                <span style={styles.creditStatValue}>
                  {formatCurrency(company.creditLimit)}
                </span>
              </div>
              <div style={styles.creditStat}>
                <span style={styles.creditStatLabel}>Credit Used</span>
                <span style={styles.creditStatValue}>
                  {formatCurrency(company.usedCredit)}
                </span>
              </div>
              <div style={styles.creditStat}>
                <span style={styles.creditStatLabel}>Available Credit</span>
                <span style={styles.creditStatValue}>
                  {formatCurrency(company.availableCredit)}
                </span>
              </div>
            </div>
            <div style={styles.progressBarBg}>
              <div
                style={{
                  ...styles.progressBarFill,
                  width: `${creditPercent}%`,
                  backgroundColor:
                    creditPercent > 90
                      ? "#ef4444"
                      : creditPercent > 70
                        ? "#f97316"
                        : "#E91E63",
                }}
              />
            </div>
            <div style={styles.progressLabel}>
              {creditPercent.toFixed(0)}% of limit utilized
            </div>
          </div>
        </div>

        {/* Two columns: Users + Recent Orders */}
        <div className="sales-portal-overview-grid" style={styles.twoColGrid}>
          {/* Company Users */}
          <div style={styles.card} id="users">
            <h2 style={styles.cardTitle}>Company Users</h2>
            {company.users.length > 0 ? (
              <div style={styles.tableContainer}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Name</th>
                      <th style={styles.th}>Email</th>
                      <th style={styles.th}>Role</th>
                    </tr>
                  </thead>
                  <tbody>
                    {company.users.map((u) => (
                      <tr key={u.id} style={styles.tr}>
                        <td style={styles.td}>
                          <strong>
                            {u.firstName} {u.lastName}
                          </strong>
                        </td>
                        <td style={styles.td}>{u.email}</td>
                        <td style={styles.td}>
                          <span style={styles.roleBadge}>
                            {u.companyRole || "User"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={styles.emptyState}>
                <span style={{ fontSize: "32px" }}>👥</span>
                <p>No active users in this company.</p>
              </div>
            )}
          </div>

          {/* Recent Orders */}
          <div style={styles.card} id="orders">
            <h2 style={styles.cardTitle}>Recent Orders</h2>
            {recentOrders.length > 0 ? (
              <div style={styles.tableContainer}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Order</th>
                      <th style={styles.th}>Date</th>
                      <th style={styles.th}>Total</th>
                      <th style={styles.th}>Payment</th>
                      <th style={styles.th}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentOrders.map((order) => (
                      <tr key={order.id} style={styles.tr}>
                        <td style={styles.td}>
                          <strong style={{ color: "#2c6ecb" }}>
                            {order.orderNumber}
                          </strong>
                        </td>
                        <td style={styles.td}>{formatDate(order.createdAt)}</td>
                        <td style={styles.td}>
                          {formatCurrency(order.orderTotal, order.currencyCode)}
                        </td>
                        <td style={styles.td}>
                          {getStatusBadge(order.paymentStatus)}
                        </td>
                        <td style={styles.td}>
                          {getStatusBadge(order.orderStatus)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={styles.emptyState}>
                <span style={{ fontSize: "32px" }}>📦</span>
                <p>No orders found for this company.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </SalesPortalLayout>
  );
}

const styles = {
  // Credit card styles
  creditCard: {
    backgroundColor: "white",
    borderRadius: "20px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.03)",
    border: "1px solid #eaeaea",
    marginBottom: "28px",
    overflow: "hidden",
  },
  creditHeader: {
    padding: "20px 24px 0",
  },
  creditTitle: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: "17px",
    fontWeight: 600,
    color: "#111",
    margin: 0,
  },
  creditBody: {
    padding: "20px 24px 24px",
  },
  creditStatGroup: {
    display: "flex",
    gap: "40px",
    marginBottom: "20px",
  },
  creditStat: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "4px",
  },
  creditStatLabel: {
    fontSize: "13px",
    color: "#8c9196",
    fontWeight: 500,
  },
  creditStatValue: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: "24px",
    fontWeight: 700,
    color: "#111",
    lineHeight: 1,
  },
  progressBarBg: {
    width: "100%",
    height: "8px",
    backgroundColor: "#f3f4f6",
    borderRadius: "4px",
    overflow: "hidden",
  },
  progressBarFill: {
    height: "100%",
    borderRadius: "4px",
    transition: "width 0.5s ease",
  },
  progressLabel: {
    fontSize: "12px",
    color: "#8c9196",
    marginTop: "8px",
    fontWeight: 500,
  },
  // Layout
  twoColGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1.5fr",
    gap: "24px",
  },
  card: {
    backgroundColor: "white",
    borderRadius: "16px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.03)",
    border: "1px solid #eaeaea",
    padding: "24px",
  },
  cardTitle: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: "17px",
    fontWeight: 600,
    color: "#111",
    margin: "0 0 20px 0",
  },
  tableContainer: { overflowX: "auto" as const },
  table: { width: "100%", borderCollapse: "collapse" as const },
  th: {
    textAlign: "left" as const,
    padding: "10px 14px",
    borderBottom: "1px solid #eaeaea",
    color: "#5c5f62",
    fontWeight: 500,
    fontSize: "13px",
    whiteSpace: "nowrap" as const,
  },
  tr: { borderBottom: "1px solid #f5f5f5" },
  td: { padding: "12px 14px", fontSize: "14px", color: "#202223" },
  roleBadge: {
    backgroundColor: "#f4f6f8",
    padding: "4px 10px",
    borderRadius: "20px",
    fontSize: "12px",
    fontWeight: 600,
    color: "#6d7175",
  },
  emptyState: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    padding: "40px",
    color: "#5c5f62",
    textAlign: "center" as const,
    gap: "8px",
  },
};
