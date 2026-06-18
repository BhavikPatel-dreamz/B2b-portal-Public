import { LoaderFunctionArgs, redirect } from "react-router";
import { useLoaderData, Link, Form } from "react-router";
import prisma from "app/db.server";
import {
  requireSalesSession,
  buildClearSessionCookie,
} from "app/utils/sales-session.server";
import type { ActionFunctionArgs } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { user } = await requireSalesSession(request);

  // Fetch companies with additional data
  const companyIds = user.salesCompanies.map((sc) => sc.companyId);

  const companies = await prisma.companyAccount.findMany({
    where: { id: { in: companyIds } },
    include: {
      shop: {
        select: { shopName: true, shopDomain: true },
      },
      _count: {
        select: {
          users: true,
          orders: true,
        },
      },
    },
  });

  // Get aggregate stats across all assigned companies
  const [totalOrders, pendingOrders, revenueResult] = await Promise.all([
    prisma.b2BOrder.count({
      where: { companyId: { in: companyIds }, orderStatus: { notIn: ["draft", "cancelled", "converted", "archived"] } },
    }),
    prisma.b2BOrder.count({
      where: {
        companyId: { in: companyIds },
        paymentStatus: "pending",
        orderStatus: { notIn: ["draft", "cancelled", "converted", "archived"] },
      },
    }),
    prisma.b2BOrder.aggregate({
      where: { companyId: { in: companyIds }, orderStatus: { notIn: ["draft", "cancelled", "converted", "archived"] } },
      _sum: { orderTotal: true },
    }),
  ]);

  const totalRevenue = Number(revenueResult._sum.orderTotal ?? 0);

  return Response.json({
    user: {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
    },
    companies: companies.map((c) => ({
      id: c.id,
      name: c.name,
      contactEmail: c.contactEmail,
      creditLimit: Number(c.creditLimit).toString(),
      storeName: c.shop.shopName || c.shop.shopDomain,
      userCount: c._count.users,
      orderCount: c._count.orders,
    })),
    metrics: {
      totalCompanies: companies.length,
      totalOrders,
      pendingOrders,
      totalRevenue,
    },
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

export default function SalesDashboard() {
  const { user, companies, metrics } = useLoaderData<{
    user: { id: string; firstName: string | null; lastName: string | null; email: string };
    companies: Array<{
      id: string;
      name: string;
      contactEmail: string | null;
      creditLimit: string;
      storeName: string | null;
      userCount: number;
      orderCount: number;
    }>;
    metrics: {
      totalCompanies: number;
      totalOrders: number;
      pendingOrders: number;
      totalRevenue: number;
    };
  }>();

  const formatCurrency = (val: number) =>
    `$${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div style={styles.container}>
      {/* Sidebar */}
      <aside style={styles.sidebar}>
        <div style={styles.logoContainer}>
          <div style={styles.logoIcon}>🎁</div>
          <span style={styles.logoText}>SmartB2B</span>
        </div>

        <nav style={styles.nav}>
          <a href="/sales/dashboard" style={{ ...styles.navItem, ...styles.navItemActive }}>
            <span style={styles.navIcon}>📊</span> Dashboard
          </a>
        </nav>

        <div style={styles.sidebarFooter}>
          <div style={styles.userProfile}>
            <div style={styles.avatar}>
              {user.firstName?.charAt(0) || user.email.charAt(0).toUpperCase()}
            </div>
            <div style={styles.userInfo}>
              <div style={styles.userName}>{user.firstName} {user.lastName}</div>
              <div style={styles.userRole}>Sales Agent</div>
            </div>
          </div>
          <Form method="post">
            <input type="hidden" name="intent" value="logout" />
            <button type="submit" style={styles.logoutBtn}>
              Sign Out
            </button>
          </Form>
        </div>
      </aside>

      {/* Main Content */}
      <main style={styles.mainContent}>
        <header style={styles.header}>
          <div>
            <h1 style={styles.heroTitle}>Welcome back, {user.firstName}! 👋</h1>
            <p style={styles.subtitle}>Here's an overview of all your assigned companies and activity.</p>
          </div>
        </header>

        {/* Stats Grid */}
        <div style={styles.statsGrid}>
          <div style={styles.statCard}>
            <div style={{ ...styles.statIconWrapper, backgroundColor: "#fff0f4" }}>
              <span style={styles.statIcon}>🏢</span>
            </div>
            <div style={styles.statValue}>{metrics.totalCompanies}</div>
            <div style={styles.statLabel}>Assigned Companies</div>
          </div>

          <div style={styles.statCard}>
            <div style={{ ...styles.statIconWrapper, backgroundColor: "#e0f2fe" }}>
              <span style={styles.statIcon}>📦</span>
            </div>
            <div style={styles.statValue}>{metrics.totalOrders}</div>
            <div style={styles.statLabel}>Total Orders</div>
          </div>

          <div style={styles.statCard}>
            <div style={{ ...styles.statIconWrapper, backgroundColor: "#fef9c3" }}>
              <span style={styles.statIcon}>⏳</span>
            </div>
            <div style={styles.statValue}>{metrics.pendingOrders}</div>
            <div style={styles.statLabel}>Pending Orders</div>
          </div>

          <div style={styles.statCard}>
            <div style={{ ...styles.statIconWrapper, backgroundColor: "#dcfce7" }}>
              <span style={styles.statIcon}>💰</span>
            </div>
            <div style={styles.statValue}>{formatCurrency(metrics.totalRevenue)}</div>
            <div style={styles.statLabel}>Total Revenue</div>
          </div>
        </div>

        {/* Companies List */}
        <div style={styles.card}>
          <h2 style={styles.cardTitle}>Your Assigned Companies</h2>
          {companies.length > 0 ? (
            <div style={styles.companyGrid}>
              {companies.map((company) => (
                <Link
                  key={company.id}
                  to={`/sales/portal?companyId=${company.id}`}
                  style={styles.companyCard}
                >
                  <div style={styles.companyCardHeader}>
                    <div style={styles.companyAvatar}>
                      {company.name.charAt(0).toUpperCase()}
                    </div>
                    <div style={styles.companyMeta}>
                      <div style={styles.companyName}>{company.name}</div>
                      <div style={styles.companyStore}>{company.storeName}</div>
                    </div>
                  </div>
                  <div style={styles.companyStats}>
                    <div style={styles.companyStat}>
                      <span style={styles.companyStatValue}>{company.userCount}</span>
                      <span style={styles.companyStatLabel}>Users</span>
                    </div>
                    <div style={styles.companyStat}>
                      <span style={styles.companyStatValue}>{company.orderCount}</span>
                      <span style={styles.companyStatLabel}>Orders</span>
                    </div>
                    <div style={styles.companyStat}>
                      <span style={styles.companyStatValue}>${Number(company.creditLimit).toLocaleString()}</span>
                      <span style={styles.companyStatLabel}>Credit Limit</span>
                    </div>
                  </div>
                  <div style={styles.viewPortalRow}>
                    <span style={styles.viewPortalText}>View Portal →</span>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div style={styles.emptyState}>
              <span style={{ fontSize: "40px", marginBottom: "16px" }}>📭</span>
              <p style={{ margin: 0, fontWeight: 500 }}>No companies assigned yet.</p>
              <p style={{ margin: "8px 0 0", fontSize: "13px", color: "#9ca3af" }}>
                Contact your store admin to get assigned to companies.
              </p>
            </div>
          )}
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
    marginBottom: "40px",
  },
  logoIcon: {
    fontSize: "24px",
  },
  logoText: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: "20px",
    fontWeight: 700,
    background: "linear-gradient(135deg, #E91E63 0%, #FF6B35 100%)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
  },
  nav: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "8px",
    padding: "0 12px",
    flex: 1,
  },
  navItem: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "12px 16px",
    textDecoration: "none",
    color: "#5c5f62",
    borderRadius: "12px",
    fontWeight: 500,
    fontSize: "15px",
    transition: "all 0.2s ease",
  },
  navItemActive: {
    backgroundColor: "#fff0f4",
    color: "#E91E63",
    fontWeight: 600,
  },
  navIcon: {
    fontSize: "16px",
  },
  sidebarFooter: {
    padding: "24px",
    borderTop: "1px solid #eaeaea",
  },
  userProfile: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    marginBottom: "16px",
  },
  avatar: {
    width: "40px",
    height: "40px",
    borderRadius: "50%",
    background: "linear-gradient(135deg, #E91E63 0%, #FF6B35 100%)",
    color: "white",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 600,
    fontSize: "16px",
    fontFamily: "'Poppins', sans-serif",
  },
  userInfo: {
    display: "flex",
    flexDirection: "column" as const,
  },
  userName: {
    fontWeight: 600,
    fontSize: "14px",
    color: "#202223",
  },
  userRole: {
    fontSize: "12px",
    color: "#8c9196",
  },
  logoutBtn: {
    width: "100%",
    padding: "10px 16px",
    borderRadius: "10px",
    border: "1px solid #e5e7eb",
    backgroundColor: "#fff",
    color: "#6b7280",
    fontSize: "13px",
    fontWeight: 500,
    cursor: "pointer",
    transition: "all 0.2s",
    fontFamily: "'Inter', sans-serif",
  },
  mainContent: {
    flex: 1,
    padding: "40px 48px",
    overflowY: "auto" as const,
  },
  header: {
    marginBottom: "32px",
  },
  heroTitle: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: "30px",
    fontWeight: 700,
    color: "#111",
    margin: "0 0 8px 0",
    letterSpacing: "-0.02em",
  },
  subtitle: {
    fontSize: "16px",
    color: "#5c5f62",
    margin: 0,
  },
  statsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: "20px",
    marginBottom: "32px",
  },
  statCard: {
    backgroundColor: "white",
    padding: "24px",
    borderRadius: "20px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.03)",
    border: "1px solid #eaeaea",
    display: "flex",
    flexDirection: "column" as const,
    gap: "12px",
    transition: "transform 0.2s, box-shadow 0.2s",
  },
  statIconWrapper: {
    width: "48px",
    height: "48px",
    borderRadius: "14px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  statIcon: {
    fontSize: "24px",
  },
  statValue: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: "28px",
    fontWeight: 700,
    color: "#111",
    margin: 0,
    lineHeight: 1,
  },
  statLabel: {
    fontSize: "14px",
    color: "#5c5f62",
    fontWeight: 500,
  },
  card: {
    backgroundColor: "white",
    borderRadius: "20px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.03)",
    border: "1px solid #eaeaea",
    padding: "32px",
  },
  cardTitle: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: "20px",
    fontWeight: 600,
    color: "#111",
    margin: "0 0 24px 0",
  },
  companyGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
    gap: "20px",
  },
  companyCard: {
    display: "block",
    textDecoration: "none",
    color: "inherit",
    padding: "24px",
    borderRadius: "16px",
    border: "1px solid #eaeaea",
    backgroundColor: "#fafafa",
    transition: "all 0.25s ease",
    cursor: "pointer",
  },
  companyCardHeader: {
    display: "flex",
    alignItems: "center",
    gap: "14px",
    marginBottom: "20px",
  },
  companyAvatar: {
    width: "48px",
    height: "48px",
    borderRadius: "14px",
    background: "linear-gradient(135deg, #E91E63 0%, #FF6B35 100%)",
    color: "white",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 700,
    fontSize: "20px",
    fontFamily: "'Poppins', sans-serif",
    flexShrink: 0,
  },
  companyMeta: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "2px",
    minWidth: 0,
  },
  companyName: {
    fontFamily: "'Poppins', sans-serif",
    fontWeight: 600,
    fontSize: "16px",
    color: "#111",
    whiteSpace: "nowrap" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  companyStore: {
    fontSize: "13px",
    color: "#8c9196",
  },
  companyStats: {
    display: "flex",
    gap: "24px",
    paddingTop: "16px",
    borderTop: "1px solid #eaeaea",
    marginBottom: "16px",
  },
  companyStat: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "2px",
  },
  companyStatValue: {
    fontWeight: 700,
    fontSize: "16px",
    color: "#202223",
    fontFamily: "'Poppins', sans-serif",
  },
  companyStatLabel: {
    fontSize: "12px",
    color: "#8c9196",
    fontWeight: 500,
  },
  viewPortalRow: {
    textAlign: "right" as const,
  },
  viewPortalText: {
    fontSize: "13px",
    fontWeight: 600,
    color: "#E91E63",
  },
  emptyState: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    padding: "48px",
    color: "#5c5f62",
    textAlign: "center" as const,
  },
};
