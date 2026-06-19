import { LoaderFunctionArgs, redirect } from "react-router";
import { useLoaderData, Link } from "react-router";
import type { Prisma } from "@prisma/client";
import prisma from "app/db.server";
import {
  validateSalesSession,
  hasCompanyAccess,
} from "app/utils/sales-session.server";
import {
  getOrderAccessWhere,
  getOrderNumber,
  getShopifyOrderWhere,
} from "app/services/sales-order-management.server";

type LoaderData = {
  user: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string;
  };
  sessionToken: string | null;
  company: {
    id: string;
    name: string;
    contactEmail: string | null;
    creditLimit: string;
    usedCredit: string;
    availableCredit: string;
    users: Array<{
      id: string;
      email: string;
      firstName: string | null;
      lastName: string | null;
      shopifyCustomerId: string | null;
      isActive: boolean;
      companyRole: string | null;
    }>;
  };
  recentOrders: Array<{
    id: string;
    orderNumber: string;
    customerName: string | null;
    customerEmail: string | null;
    company: { id: string; name: string };
    salesAgent: {
      id: string;
      firstName: string | null;
      lastName: string | null;
      email: string;
    };
    itemCount: number;
    quantity: number;
    orderTotal: string;
    currencyCode: string;
    paymentStatus: string;
    orderStatus: string;
    createdAt: string;
    updatedAt: string;
  }>;
  allCompanies: Array<{ id: string; name: string }>;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const sessionToken = url.searchParams.get("session");
  const companyId = url.searchParams.get("companyId");

  // Validate session
  const sessionResult = await validateSalesSession(sessionToken);
  if (!sessionResult.valid) {
    return redirect("/support/login?error=unauthorized");
  }

  const user = sessionResult.user;

  // Validate company access
  if (!companyId || !hasCompanyAccess(user, companyId)) {
    return redirect(
      `/support/dashboard?session=${sessionToken}&error=access_denied`,
    );
  }

  // Get full company data
  const company = await prisma.companyAccount.findUnique({
    where: { id: companyId },
    include: {
      users: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          shopifyCustomerId: true,
          isActive: true,
          companyRole: true,
        },
        where: { isActive: true },
      },
    },
  });

  if (!company) {
    return redirect(
      `/support/dashboard?session=${sessionToken}&error=company_not_found`,
    );
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
    take: 10,
    include: {
      company: { select: { id: true, name: true } },
      createdByUser: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      items: { select: { quantity: true } },
    },
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
    sessionToken,
    company: {
      ...company,
      creditLimit: creditLimit.toString(),
      usedCredit: usedCredit.toString(),
      availableCredit: availableCredit.toString(),
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
    allCompanies: user.salesCompanies.map((sc) => ({
      id: sc.company.id,
      name: sc.company.name,
    })),
  });
};

export default function SalesPortal() {
  const { user, sessionToken, company, recentOrders, allCompanies } =
    useLoaderData<LoaderData>();

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
        </div>

        <nav style={styles.nav}>
          <a href="#" style={{ ...styles.navItem, ...styles.navItemActive }}>
            <span style={styles.navIcon}>📊</span> Dashboard
          </a>
          <a href="#" style={styles.navItem}>
            <span style={styles.navIcon}>👥</span> Customers
          </a>
          <a href="#" style={styles.navItem}>
            <span style={styles.navIcon}>📦</span> Orders
          </a>
          <a href="#" style={styles.navItem}>
            <span style={styles.navIcon}>💳</span> Credit
          </a>
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
              <div style={styles.userRole}>Sales Support</div>
            </div>
          </div>
          <Link
            to={`/support/dashboard?session=${sessionToken}`}
            style={styles.backLink}
          >
            ← Back to Dashboard
          </Link>
        </div>
      </aside>

      {/* Main Content */}
      <main style={styles.mainContent}>
        {/* Header */}
        <header style={styles.header}>
          <div>
            <h1 style={styles.heroTitle}>{company.name}</h1>
            <p style={styles.subtitle}>
              {company.contactEmail
                ? `Contact: ${company.contactEmail}`
                : "Sales Portal"}{" "}
              · {company.users.length} customer(s)
            </p>
          </div>
        </header>

        {/* Two columns: Users + Recent Orders */}
        <div style={styles.twoColGrid}>
          {/* Company Users */}
          <div style={styles.card}>
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
          <div style={styles.card}>
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
                          <strong>{order.orderNumber}</strong>
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
      </main>
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    minHeight: "100vh",
    backgroundColor: "#fafafa",
    fontFamily: "'Inter', sans-serif",
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
    objectFit: "contain" as const,
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
  statsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap: "20px",
    marginBottom: "28px",
  },
  statCard: {
    backgroundColor: "white",
    padding: "22px",
    borderRadius: "16px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.03)",
    border: "1px solid #eaeaea",
    display: "flex",
    flexDirection: "column" as const,
    gap: "10px",
  },
  statIconWrapper: {
    width: "44px",
    height: "44px",
    borderRadius: "12px",
    backgroundColor: "#fff0f4",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  statIcon: { fontSize: "22px" },
  statValue: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: "26px",
    fontWeight: 700,
    color: "#111",
    lineHeight: 1,
  },
  statLabel: { fontSize: "13px", color: "#5c5f62", fontWeight: 500 },
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
