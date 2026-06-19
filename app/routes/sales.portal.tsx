import { redirect, useLoaderData, Link, Form } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "app/db.server";
import {
  requireSalesSession,
  hasCompanyAccess,
  buildClearSessionCookie,
} from "app/utils/sales-session.server";

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

  // Get recent orders for this company
  const recentOrders = await prisma.b2BOrder.findMany({
    where: {
      companyId: company.id,
      orderStatus: { notIn: ["converted", "archived"] },
    },
    orderBy: { createdAt: "desc" },
    take: 15,
    select: {
      id: true,
      shopifyOrderId: true,
      orderTotal: true,
      paymentStatus: true,
      orderStatus: true,
      createdAt: true,
      createdByUser: {
        select: { firstName: true, lastName: true, email: true },
      },
    },
  });

  const quoteCount = await prisma.quote.count({
    where: { companyId: company.id },
  });

  // Get credit data
  const pendingCreditOrders = await prisma.b2BOrder.aggregate({
    where: {
      companyId: company.id,
      paymentStatus: { in: ["pending", "partial"] },
      orderStatus: { notIn: ["cancelled", "converted", "archived"] },
    },
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
      ...o,
      orderTotal: o.orderTotal?.toString() || "0",
      createdAt: o.createdAt.toISOString(),
    })),
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
  const { user, company, recentOrders, quoteCount, allCompanies } = useLoaderData<{
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
      shopifyOrderId: string | null;
      orderTotal: string;
      paymentStatus: string;
      orderStatus: string;
      createdAt: string;
    }>;
    quoteCount: number;
    allCompanies: Array<{ id: string; name: string }>;
  }>();

  const formatDate = (iso: string) =>
    new Intl.DateTimeFormat("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(new Date(iso));

  const formatCurrency = (val: string | number) =>
    `$${Number(val).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

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
    <div style={styles.container}>
      {/* Sidebar */}
      <aside style={styles.sidebar}>
        <div style={styles.logoContainer}>
          <div style={styles.logoIcon}>
            <img
              src="https://cdn.shopify.com/s/files/applications/c6da0a0589e2c3c978aadf2afec07db7_200x200.png?v=1776950914"
              alt="Logo"
              style={styles.logoImage}
            />
          </div>
          <span style={styles.logoText}>SmartB2B</span>
        </div>

        {/* Company Switcher */}
        <div style={styles.companySwitcher}>
          <div style={styles.companySwitcherLabel}>Current Company</div>
          <div style={styles.companySwitcherValue}>{company.name}</div>
          <div style={styles.companySwitcherStore}>{company.storeName}</div>
        </div>

        <nav style={styles.nav}>
          <a
            href="#overview"
            style={{ ...styles.navItem, ...styles.navItemActive }}
          >
            <span style={styles.navIcon}>📊</span> Overview
          </a>
          <Link
            to={`/sales/portal/company/${company.id}/orders`}
            style={styles.navItem}
          >
            <span style={styles.navIcon}>📦</span> Orders ({recentOrders.length}
            )
          </Link>
          <Link
            to={`/sales/portal/company/${company.id}/quotes`}
            style={styles.navItem}
          >
            <span style={styles.navIcon}>📝</span> Quotes ({quoteCount})
          </Link>
        </nav>

        {/* Other Companies */}
       

        <div style={styles.sidebarFooter}>
          <div style={styles.userProfile}>
            <div style={styles.avatar}>
              {user.firstName?.charAt(0) || user.email.charAt(0).toUpperCase()}
            </div>
            <div style={styles.userInfo}>
              <div style={styles.userName}>
                {user.firstName} {user.lastName}
              </div>
              <div style={styles.userRole}>Sales Agent</div>
            </div>
          </div>
          <div
            style={{
              display: "flex",
              gap: "8px",
              flexDirection: "column" as const,
            }}
          >
            {/* <Link to="/sales/portal" style={styles.backLink}>
              ← Back to Portal
            </Link> */}
            <Form method="post">
              <input type="hidden" name="intent" value="logout" />
              <button type="submit" style={styles.logoutBtn}>
                Sign Out
              </button>
            </Form>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main style={styles.mainContent}>
        {/* Header */}
        <header
          style={{
            ...styles.header,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
          }}
          id="overview"
        >
          <div>
            <h1 style={styles.heroTitle}>{company.name}</h1>
            <p style={styles.subtitle}>
              {company.contactEmail
                ? `Contact: ${company.contactEmail}`
                : "Sales Portal"}{" "}
              · {company.users.length} customer(s) · {company.storeName}
            </p>
          </div>
          <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
            {allCompanies.length > 1 && (
              <select
                value={company.id}
                onChange={(e) => {
                  const selectedCompanyId = e.target.value;
                  if (selectedCompanyId !== company.id) {
                    window.location.href = `/sales/portal?companyId=${selectedCompanyId}`;
                  }
                }}
                style={{
                  padding: "8px 12px",
                  borderRadius: "8px",
                  border: "1.5px solid #e5e7eb",
                  fontSize: "13px",
                  fontFamily: "'Inter', system-ui, sans-serif",
                  backgroundColor: "#fff",
                  color: "#202223",
                  cursor: "pointer",
                  minWidth: "160px",
                }}
              >
                {allCompanies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
            <Link
              to={`/sales/portal/company/${company.id}/create-order`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                padding: "10px 18px",
                backgroundColor: "#111827",
                color: "#ffffff",
                borderRadius: "8px",
                textDecoration: "none",
                fontWeight: 500,
                fontSize: "14px",
                transition: "background-color 0.2s",
              }}
            >
              <span>+</span> Create Order
            </Link>
            <Link
              to={`/sales/portal/company/${company.id}/create-quote`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                padding: "10px 18px",
                backgroundColor: "#ffffff",
                color: "#111827",
                border: "1px solid #d1d5db",
                borderRadius: "8px",
                textDecoration: "none",
                fontWeight: 500,
                fontSize: "14px",
              }}
            >
              <span>+</span> Create Quote
            </Link>
          </div>
        </header>

        {/* Credit Limit Card */}
        <div style={styles.creditCard}>
          <div style={styles.creditHeader}>
            <h2 style={styles.creditTitle}>Company Credit</h2>
          </div>
          <div style={styles.creditBody}>
            <div style={styles.creditStatGroup}>
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
        <div style={styles.twoColGrid}>
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
                            {order.shopifyOrderId
                              ? `#${order.shopifyOrderId.split("/").pop()}`
                              : order.id.slice(0, 8)}
                          </strong>
                        </td>
                        <td style={styles.td}>{formatDate(order.createdAt)}</td>
                        <td style={styles.td}>
                          {formatCurrency(order.orderTotal)}
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
      </main>

      <style>{`
        a[style]:hover {
          background-color: #f9fafb !important;
        }
      `}</style>
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    minHeight: "100vh",
    backgroundColor: "#fafafa",
    fontFamily: "'Inter', system-ui, sans-serif",
  },
  sidebar: {
    width: "280px",
    minWidth: "280px",
    backgroundColor: "#ffffff",
    borderRight: "1px solid #eaeaea",
    display: "flex",
    flexDirection: "column" as const,
    padding: "24px 0",
  },
  logoContainer: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "0 24px",
    marginBottom: "24px",
  },
  logoIcon: {
    width: "48px",
    height: "48px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  logoImage: {
    width: "100%",
    height: "100%",
    objectFit: "contain",
  },
  logoText: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: "20px",
    fontWeight: 700,
    background: "linear-gradient(135deg, #E91E63 0%, #FF6B35 100%)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
  },
  companySwitcher: {
    margin: "0 16px 24px",
    padding: "14px 16px",
    borderRadius: "12px",
    background: "linear-gradient(135deg, #fdf4f7 0%, #fff7eb 100%)",
    border: "1px solid #f8d7e3",
  },
  companySwitcherLabel: {
    fontSize: "11px",
    fontWeight: 600,
    textTransform: "uppercase" as const,
    color: "#8c9196",
    letterSpacing: "0.06em",
    marginBottom: "4px",
  },
  companySwitcherValue: {
    fontSize: "15px",
    fontWeight: 700,
    color: "#E91E63",
    fontFamily: "'Poppins', sans-serif",
  },
  companySwitcherStore: {
    fontSize: "12px",
    color: "#8c9196",
    marginTop: "2px",
  },
  nav: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "4px",
    padding: "0 12px",
    flex: 1,
  },
  navItem: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "11px 16px",
    textDecoration: "none",
    color: "#5c5f62",
    borderRadius: "10px",
    fontWeight: 500,
    fontSize: "14px",
    transition: "all 0.2s ease",
  },
  navItemActive: {
    backgroundColor: "#fff0f4",
    color: "#E91E63",
    fontWeight: 600,
  },
  navIcon: { fontSize: "16px" },
  otherCompanies: {
    padding: "16px 24px",
    borderTop: "1px solid #eaeaea",
    marginTop: "8px",
  },
  otherCompaniesLabel: {
    fontSize: "11px",
    fontWeight: 600,
    textTransform: "uppercase" as const,
    color: "#8c9196",
    letterSpacing: "0.06em",
    marginBottom: "12px",
  },
  companyLink: {
    display: "block",
    padding: "8px 12px",
    borderRadius: "8px",
    textDecoration: "none",
    color: "#202223",
    fontSize: "13px",
    fontWeight: 500,
    marginBottom: "4px",
    transition: "background-color 0.2s",
    backgroundColor: "#f9fafb",
    border: "1px solid #eaeaea",
  },
  sidebarFooter: {
    padding: "16px 24px",
    borderTop: "1px solid #eaeaea",
  },
  userProfile: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    marginBottom: "12px",
  },
  avatar: {
    width: "36px",
    height: "36px",
    borderRadius: "50%",
    background: "linear-gradient(135deg, #E91E63 0%, #FF6B35 100%)",
    color: "white",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 600,
    fontSize: "14px",
    fontFamily: "'Poppins', sans-serif",
  },
  userInfo: { display: "flex", flexDirection: "column" as const },
  userName: { fontWeight: 600, fontSize: "13px", color: "#202223" },
  userRole: { fontSize: "11px", color: "#8c9196" },
  backLink: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    fontSize: "13px",
    color: "#2c6ecb",
    textDecoration: "none",
    fontWeight: 500,
  },
  logoutBtn: {
    width: "100%",
    padding: "8px 14px",
    borderRadius: "8px",
    border: "1px solid #e5e7eb",
    backgroundColor: "#fff",
    color: "#6b7280",
    fontSize: "12px",
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "'Inter', sans-serif",
  },
  mainContent: {
    flex: 1,
    padding: "32px 40px",
    overflowY: "auto" as const,
  },
  header: { marginBottom: "28px" },
  heroTitle: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: "28px",
    fontWeight: 700,
    color: "#111",
    margin: "0 0 6px 0",
    letterSpacing: "-0.02em",
  },
  subtitle: {
    fontSize: "15px",
    color: "#5c5f62",
    margin: 0,
  },
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
