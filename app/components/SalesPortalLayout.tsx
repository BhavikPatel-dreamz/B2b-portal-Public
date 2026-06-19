import type { CSSProperties, ReactNode } from "react";
import { Form, Link } from "react-router";

export type SalesPortalCompany = {
  id: string;
  name: string;
  storeName?: string | null;
};

export type SalesPortalUser = {
  firstName?: string | null;
  lastName?: string | null;
  email: string;
};

type ActivePage = "overview" | "orders" | "quotes";

export function SalesPortalSidebar({
  company,
  user,
  activePage,
  orderCount,
  quoteCount,
}: {
  company: SalesPortalCompany;
  user: SalesPortalUser;
  activePage: ActivePage;
  orderCount?: number;
  quoteCount?: number;
}) {
  const displayName =
    [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email;
  const navItems = [
    {
      key: "overview" as const,
      label: "Overview",
      icon: "📊",
      to: `/sales/portal?companyId=${company.id}`,
    },
    {
      key: "orders" as const,
      label: "Orders",
      icon: "📦",
      count: orderCount,
      to: `/sales/portal/orders?company=${company.id}`,
    },
    {
      key: "quotes" as const,
      label: "Quotes",
      icon: "📝",
      count: quoteCount,
      to: `/sales/portal/company/${company.id}/quotes`,
    },
  ];

  return (
    <aside className="sales-portal-sidebar" style={styles.sidebar}>
      <div style={styles.logoContainer}>
        <img
          src="https://cdn.shopify.com/s/files/applications/c6da0a0589e2c3c978aadf2afec07db7_200x200.png?v=1776950914"
          alt="SmartB2B"
          style={styles.logoImage}
        />
        <span style={styles.logoText}>SmartB2B</span>
      </div>

      <div className="sales-portal-company-card" style={styles.companyCard}>
        <span style={styles.companyLabel}>Current Company</span>
        <strong style={styles.companyName}>{company.name}</strong>
        <span style={styles.storeName}>{company.storeName}</span>
      </div>

      <nav style={styles.nav} aria-label="Sales portal navigation">
        {navItems.map((item) => {
          const active = item.key === activePage;
          return (
            <Link
              key={item.key}
              to={item.to}
              aria-current={active ? "page" : undefined}
              style={{
                ...styles.navItem,
                ...(active ? styles.navItemActive : {}),
              }}
            >
              <span style={styles.navIcon} aria-hidden="true">
                {item.icon}
              </span>
              <span>{item.label}</span>
              {typeof item.count === "number" && (
                <span
                  style={{
                    ...styles.navCount,
                    ...(active ? styles.navCountActive : {}),
                  }}
                >
                  {item.count}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="sales-portal-user" style={styles.sidebarFooter}>
        <div style={styles.userProfile}>
          <span style={styles.avatar}>
            {(user.firstName || user.email).charAt(0).toUpperCase()}
          </span>
          <span style={styles.userInfo}>
            <strong style={styles.userName}>{displayName}</strong>
            <span style={styles.userRole}>Sales Agent</span>
          </span>
        </div>
        <Form method="post">
          <input type="hidden" name="intent" value="logout" />
          <button type="submit" style={styles.logoutButton}>
            Sign Out
          </button>
        </Form>
      </div>
    </aside>
  );
}

export function SalesPortalHeader({
  title,
  subtitle,
  companyId,
  companies = [],
  actions,
}: {
  title: string;
  subtitle: ReactNode;
  companyId: string;
  companies?: SalesPortalCompany[];
  actions?: ReactNode;
}) {
  return (
    <header className="sales-portal-header" style={styles.header}>
      <div style={styles.headingGroup}>
        <h1 style={styles.title}>{title}</h1>
        <p style={styles.subtitle}>{subtitle}</p>
      </div>
      <div className="sales-portal-header-actions" style={styles.headerActions}>
        {companies.length > 1 && (
          <select
            aria-label="Switch company"
            value={companyId}
            onChange={(event) => {
              if (event.target.value !== companyId) {
                window.location.href = `/sales/portal?companyId=${event.target.value}`;
              }
            }}
            style={styles.companySelect}
          >
            {companies.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </select>
        )}
        {actions}
      </div>
    </header>
  );
}

export function SalesPortalLayout({
  company,
  user,
  activePage,
  orderCount,
  quoteCount,
  children,
}: {
  company: SalesPortalCompany;
  user: SalesPortalUser;
  activePage: ActivePage;
  orderCount?: number;
  quoteCount?: number;
  children: ReactNode;
}) {
  return (
    <div className="sales-portal-layout" style={styles.layout}>
      <SalesPortalSidebar
        company={company}
        user={user}
        activePage={activePage}
        orderCount={orderCount}
        quoteCount={quoteCount}
      />
      <main className="sales-portal-main" style={styles.main}>
        {children}
      </main>
      <style>{responsiveCss}</style>
    </div>
  );
}

export const salesPortalButtonStyles = {
  primary: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: 40,
    padding: "10px 18px",
    background: "#111827",
    color: "#fff",
    border: "1px solid #111827",
    borderRadius: 8,
    textDecoration: "none",
    fontSize: 14,
    fontWeight: 500,
  } satisfies CSSProperties,
  secondary: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: 40,
    padding: "10px 18px",
    background: "#fff",
    color: "#111827",
    border: "1px solid #d1d5db",
    borderRadius: 8,
    textDecoration: "none",
    fontSize: 14,
    fontWeight: 500,
  } satisfies CSSProperties,
};

const responsiveCss = `
  .sales-portal-layout * { box-sizing: border-box; }
  .sales-portal-main input:focus,
  .sales-portal-main select:focus,
  .sales-portal-main textarea:focus {
    outline: none;
    border-color: #e91e63 !important;
    box-shadow: 0 0 0 3px rgba(233, 30, 99, 0.1);
  }
  .sales-quote-table-wrap { overflow-x: auto; }
  .sales-quote-row:hover { background: #fdfdfd; }
  @media (max-width: 1080px) {
    .sales-portal-overview-grid { grid-template-columns: minmax(0, 1fr) !important; }
    .sales-portal-credit-stats { flex-wrap: wrap; gap: 24px !important; }
    .sales-quote-filters { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
    .sales-quote-detail-grid { grid-template-columns: minmax(0, 1fr) !important; }
    .sales-quote-side-column { position: static !important; }
  }
  @media (max-width: 860px) {
    .sales-portal-layout { display: block !important; }
    .sales-portal-sidebar {
      width: 100% !important;
      min-width: 0 !important;
      padding: 14px 16px !important;
      border-right: 0 !important;
      border-bottom: 1px solid #eaeaea;
    }
    .sales-portal-sidebar nav { flex-direction: row !important; overflow-x: auto; }
    .sales-portal-sidebar nav a { flex: 0 0 auto; }
    .sales-portal-company-card, .sales-portal-user { display: none !important; }
    .sales-portal-main { padding: 24px 20px !important; }
    .sales-quote-info-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
  }
  @media (max-width: 620px) {
    .sales-portal-main { padding: 20px 14px !important; }
    .sales-portal-header { flex-direction: column !important; }
    .sales-portal-header-actions { width: 100%; flex-wrap: wrap; }
    .sales-portal-header-actions > a,
    .sales-portal-header-actions > button,
    .sales-portal-header-actions > form { flex: 1 1 auto; }
    .sales-portal-header-actions > select { flex: 1 1 100%; }
    .sales-quote-filters { grid-template-columns: minmax(0, 1fr) !important; }
    .sales-quote-info-grid { grid-template-columns: minmax(0, 1fr) !important; }
    .sales-quote-card { padding: 16px !important; }
  }
`;

const styles: Record<string, CSSProperties> = {
  layout: {
    display: "flex",
    minHeight: "100vh",
    background: "#fafafa",
    color: "#202223",
    fontFamily: "'Inter', system-ui, sans-serif",
  },
  sidebar: {
    width: 280,
    minWidth: 280,
    background: "#fff",
    borderRight: "1px solid #eaeaea",
    padding: "24px 0",
    display: "flex",
    flexDirection: "column",
  },
  logoContainer: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "0 24px",
    marginBottom: 24,
  },
  logoImage: { width: 48, height: 48, objectFit: "contain" },
  logoText: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: 20,
    fontWeight: 700,
    background: "linear-gradient(135deg, #e91e63 0%, #ff6b35 100%)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
  },
  companyCard: {
    margin: "0 16px 24px",
    padding: "14px 16px",
    borderRadius: 12,
    background: "linear-gradient(135deg, #fdf4f7 0%, #fff7eb 100%)",
    border: "1px solid #f8d7e3",
    display: "flex",
    flexDirection: "column",
    gap: 3,
  },
  companyLabel: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase",
    color: "#8c9196",
  },
  companyName: {
    color: "#e91e63",
    fontSize: 15,
    fontFamily: "'Poppins', sans-serif",
  },
  storeName: { color: "#8c9196", fontSize: 12 },
  nav: {
    padding: "0 12px",
    display: "flex",
    flexDirection: "column",
    gap: 4,
    flex: 1,
  },
  navItem: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    minHeight: 42,
    padding: "10px 16px",
    borderRadius: 10,
    color: "#5c5f62",
    textDecoration: "none",
    fontSize: 14,
    fontWeight: 500,
  },
  navItemActive: { background: "#fff0f4", color: "#e91e63", fontWeight: 600 },
  navIcon: { fontSize: 16 },
  navCount: {
    marginLeft: "auto",
    minWidth: 22,
    padding: "2px 6px",
    borderRadius: 8,
    background: "#f4f6f8",
    textAlign: "center",
    fontSize: 11,
  },
  navCountActive: { background: "#fff" },
  sidebarFooter: { padding: "16px 24px", borderTop: "1px solid #eaeaea" },
  userProfile: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginBottom: 12,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: "50%",
    background: "linear-gradient(135deg, #e91e63 0%, #ff6b35 100%)",
    color: "#fff",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 600,
  },
  userInfo: { minWidth: 0, display: "flex", flexDirection: "column" },
  userName: { overflow: "hidden", textOverflow: "ellipsis", fontSize: 13 },
  userRole: { color: "#8c9196", fontSize: 11 },
  logoutButton: {
    width: "100%",
    padding: "8px 14px",
    borderRadius: 8,
    border: "1px solid #e5e7eb",
    background: "#fff",
    color: "#6b7280",
    fontSize: 12,
    cursor: "pointer",
  },
  main: { flex: 1, minWidth: 0, padding: "32px 40px", overflowY: "auto" },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 20,
    marginBottom: 28,
  },
  headingGroup: { minWidth: 0 },
  title: {
    margin: 0,
    fontFamily: "'Poppins', sans-serif",
    fontSize: 28,
    fontWeight: 700,
    color: "#202223",
  },
  subtitle: {
    margin: "6px 0 0",
    color: "#6d7175",
    fontSize: 14,
    lineHeight: 1.5,
  },
  headerActions: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 12,
  },
  companySelect: {
    minWidth: 160,
    height: 40,
    padding: "0 12px",
    borderRadius: 8,
    border: "1px solid #d1d5db",
    fontSize: 13,
    fontFamily: "inherit",
    background: "#fff",
    color: "#202223",
    cursor: "pointer",
  },
};
