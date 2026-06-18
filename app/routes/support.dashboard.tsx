import { LoaderFunctionArgs, redirect } from "react-router";
import { useLoaderData, Link } from "react-router";
import prisma from "app/db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const sessionToken = url.searchParams.get("session");

  if (!sessionToken) {
    return redirect("/support/login?error=unauthorized");
  }

  const session = await prisma.userSession.findUnique({
    where: { token: sessionToken },
    include: {
      user: {
        include: {
          salesCompanies: {
            include: { company: true }
          }
        }
      }
    }
  });

  if (!session || new Date() > new Date(session.expiresAt)) {
    return redirect("/support/login?error=expired");
  }

  return Response.json({
    sessionToken,
    user: session.user,
    companies: session.user.salesCompanies.map(sc => sc.company),
  });
};

export default function SupportDashboard() {
  const { sessionToken, user, companies } = useLoaderData<typeof loader>();

  return (
    <div style={styles.container}>
      {/* Sidebar */}
      <aside style={styles.sidebar}>
        <div style={styles.logoContainer}>
          <div style={styles.logoIcon}>🎁</div>
          <span style={styles.logoText}>SmartB2B</span>
        </div>
        
        <nav style={styles.nav}>
          <a href="#" style={{ ...styles.navItem, ...styles.navItemActive }}>
            Dashboard
          </a>
          <a href="#" style={styles.navItem}>Assigned Companies</a>
          <a href="#" style={styles.navItem}>Orders</a>
          <a href="#" style={styles.navItem}>Settings</a>
        </nav>

        <div style={styles.sidebarFooter}>
          <div style={styles.userProfile}>
            <div style={styles.avatar}>
              {user.firstName?.charAt(0) || user.email.charAt(0).toUpperCase()}
            </div>
            <div style={styles.userInfo}>
              <div style={styles.userName}>{user.firstName} {user.lastName}</div>
              <div style={styles.userRole}>Sales Support</div>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main style={styles.mainContent}>
        <header style={styles.header}>
          <div>
            <h1 style={styles.heroTitle}>Welcome back, {user.firstName}! 👋</h1>
            <p style={styles.subtitle}>Here is what's happening with your accounts today.</p>
          </div>
        </header>

        <div style={styles.dashboardGrid}>
          {/* Quick Stats */}
          <div style={styles.statCard}>
            <div style={styles.statIconWrapper}>
              <span style={styles.statIcon}>🏢</span>
            </div>
            <div style={styles.statValue}>{companies.length}</div>
            <div style={styles.statLabel}>Assigned Companies</div>
          </div>

          <div style={styles.statCard}>
            <div style={styles.statIconWrapper}>
              <span style={styles.statIcon}>📦</span>
            </div>
            <div style={styles.statValue}>12</div>
            <div style={styles.statLabel}>Pending Orders</div>
          </div>

          <div style={styles.statCard}>
            <div style={styles.statIconWrapper}>
              <span style={styles.statIcon}>⭐️</span>
            </div>
            <div style={styles.statValue}>$4,250</div>
            <div style={styles.statLabel}>Sales this week</div>
          </div>
        </div>

        {/* Assigned Companies List */}
        <div style={styles.card}>
          <h2 style={styles.cardTitle}>Your Assigned Companies</h2>
          {companies.length > 0 ? (
            <div style={styles.tableContainer}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Company Name</th>
                    <th style={styles.th}>Contact</th>
                    <th style={styles.th}>Credit Limit</th>
                    <th style={styles.th}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {companies.map(company => (
                    <tr key={company.id} style={styles.tr}>
                      <td style={styles.td}>
                        <strong>{company.name}</strong>
                      </td>
                      <td style={styles.td}>{company.contactEmail || "N/A"}</td>
                      <td style={styles.td}>
                        <span style={styles.badge}>
                          ${Number(company.creditLimit).toLocaleString()}
                        </span>
                      </td>
                      <td style={styles.td}>
                        <Link
                          to={`/support/portal?session=${sessionToken}&companyId=${company.id}`}
                          style={styles.actionBtn}
                        >
                          View Portal →
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={styles.emptyState}>
              <span style={{ fontSize: "40px", marginBottom: "16px" }}>📭</span>
              <p>You haven't been assigned to any companies yet.</p>
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
    fontFamily: "'Inter', sans-serif",
  },
  sidebar: {
    width: "280px",
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
  sidebarFooter: {
    padding: "24px",
    borderTop: "1px solid #eaeaea",
  },
  userProfile: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
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
  dashboardGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
    gap: "24px",
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
    transition: "transform 0.2s",
    cursor: "pointer",
  },
  statIconWrapper: {
    width: "48px",
    height: "48px",
    borderRadius: "14px",
    backgroundColor: "#fff0f4",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  statIcon: {
    fontSize: "24px",
  },
  statValue: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: "32px",
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
  tableContainer: {
    overflowX: "auto" as const,
  },
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
  },
  th: {
    textAlign: "left" as const,
    padding: "12px 16px",
    borderBottom: "1px solid #eaeaea",
    color: "#5c5f62",
    fontWeight: 500,
    fontSize: "14px",
  },
  tr: {
    borderBottom: "1px solid #f5f5f5",
    transition: "background-color 0.2s",
  },
  td: {
    padding: "16px",
    fontSize: "15px",
    color: "#202223",
  },
  badge: {
    backgroundColor: "#f4f6f8",
    padding: "6px 12px",
    borderRadius: "20px",
    fontSize: "13px",
    fontWeight: 600,
    color: "#2c6ecb",
  },
  actionBtn: {
    display: "inline-block",
    padding: "8px 16px",
    borderRadius: "8px",
    border: "1px solid #e1e1e1",
    backgroundColor: "white",
    color: "#202223",
    fontWeight: 500,
    fontSize: "13px",
    cursor: "pointer",
    transition: "all 0.2s",
    textDecoration: "none",
  },
  emptyState: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    padding: "48px",
    color: "#5c5f62",
    textAlign: "center" as const,
  }
};
