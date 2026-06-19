import type { CSSProperties, ReactNode } from "react";
import { Form, Link } from "react-router";

type Company = { id: string; name: string; storeName?: string | null };
type User = {
  firstName?: string | null;
  lastName?: string | null;
  email: string;
};

export function SalesPortalQuoteShell({
  company,
  user,
  allCompanies = [],
  quoteCount,
  children,
}: {
  company: Company;
  user: User;
  allCompanies?: Company[];
  quoteCount?: number;
  children: ReactNode;
}) {
  const displayName =
    [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email;

  return (
    <div className="sales-quote-shell" style={styles.shell}>
      <aside className="sales-quote-sidebar" style={styles.sidebar}>
        <div style={styles.logoContainer}>
          <img
            src="https://cdn.shopify.com/s/files/applications/c6da0a0589e2c3c978aadf2afec07db7_200x200.png?v=1776950914"
            alt="SmartB2B"
            style={styles.logoImage}
          />
          <span style={styles.logoText}>SmartB2B</span>
        </div>

        <div style={styles.companySwitcher}>
          <span style={styles.companyLabel}>Current Company</span>
          <strong style={styles.companyName}>{company.name}</strong>
          <span style={styles.storeName}>{company.storeName}</span>
        </div>

        <nav style={styles.nav} aria-label="Sales portal navigation">
          <Link
            to={`/sales/portal?companyId=${company.id}`}
            style={styles.navItem}
          >
            <span aria-hidden="true">📊</span> Overview
          </Link>
          <Link
            to={`/sales/portal/company/${company.id}/orders`}
            style={styles.navItem}
          >
            <span aria-hidden="true">📦</span> Orders
          </Link>
          <Link
            to={`/sales/portal/company/${company.id}/quotes`}
            style={{ ...styles.navItem, ...styles.navItemActive }}
          >
            <span aria-hidden="true">📝</span> Quotes
            {typeof quoteCount === "number" && (
              <span style={styles.navCount}>{quoteCount}</span>
            )}
          </Link>
        </nav>

        {allCompanies.length > 1 && (
          <div style={styles.otherCompanies}>
            <span style={styles.companyLabel}>Other Companies</span>
            {allCompanies
              .filter((item) => item.id !== company.id)
              .map((item) => (
                <Link
                  key={item.id}
                  to={`/sales/portal?companyId=${item.id}`}
                  style={styles.companyLink}
                >
                  {item.name}
                </Link>
              ))}
          </div>
        )}

        <div style={styles.sidebarFooter}>
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

      <main className="sales-quote-main" style={styles.main}>
        {children}
      </main>
      <style>{responsiveCss}</style>
    </div>
  );
}

const responsiveCss = `
  .sales-quote-shell * { box-sizing: border-box; }
  .sales-quote-main input:focus,
  .sales-quote-main select:focus,
  .sales-quote-main textarea:focus {
    outline: none;
    border-color: #e91e63 !important;
    box-shadow: 0 0 0 3px rgba(233, 30, 99, 0.1);
  }
  .sales-quote-table-wrap { overflow-x: auto; }
  .sales-quote-row:hover { background: #fdfdfd; }
  @media (max-width: 1080px) {
    .sales-quote-filters { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
    .sales-quote-detail-grid { grid-template-columns: minmax(0, 1fr) !important; }
    .sales-quote-side-column { position: static !important; }
  }
  @media (max-width: 820px) {
    .sales-quote-shell { display: block !important; }
    .sales-quote-sidebar {
      width: 100% !important;
      min-width: 0 !important;
      padding: 14px 16px !important;
      border-right: 0 !important;
      border-bottom: 1px solid #eaeaea;
    }
    .sales-quote-sidebar nav { flex-direction: row !important; overflow-x: auto; }
    .sales-quote-sidebar nav a { flex: 0 0 auto; }
    .sales-quote-sidebar > div:nth-child(2),
    .sales-quote-sidebar > div:last-child { display: none !important; }
    .sales-quote-main { padding: 24px 20px !important; }
    .sales-quote-header { align-items: flex-start !important; }
    .sales-quote-info-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
  }
  @media (max-width: 560px) {
    .sales-quote-main { padding: 20px 14px !important; }
    .sales-quote-header { flex-direction: column !important; }
    .sales-quote-header-actions { width: 100%; justify-content: flex-start !important; }
    .sales-quote-header-actions > *, .sales-quote-header-actions form { flex: 1 1 auto; }
    .sales-quote-header-actions button, .sales-quote-header-actions a { width: 100%; justify-content: center; }
    .sales-quote-filters { grid-template-columns: minmax(0, 1fr) !important; }
    .sales-quote-info-grid { grid-template-columns: minmax(0, 1fr) !important; }
    .sales-quote-card { padding: 16px !important; }
  }
`;

const styles: Record<string, CSSProperties> = {
  shell: {
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
    color: "#e91e63",
  },
  companySwitcher: {
    margin: "0 16px 24px",
    padding: "14px 16px",
    borderRadius: 8,
    background: "#fff7f9",
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
  companyName: { color: "#e91e63", fontSize: 15 },
  storeName: { color: "#8c9196", fontSize: 12 },
  nav: { padding: "0 12px", display: "flex", flexDirection: "column", gap: 4 },
  navItem: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    minHeight: 42,
    padding: "10px 16px",
    borderRadius: 8,
    color: "#5c5f62",
    textDecoration: "none",
    fontSize: 14,
    fontWeight: 500,
  },
  navItemActive: { background: "#fff0f4", color: "#e91e63", fontWeight: 600 },
  navCount: {
    marginLeft: "auto",
    minWidth: 22,
    padding: "2px 6px",
    borderRadius: 8,
    background: "#fff",
    textAlign: "center",
    fontSize: 11,
  },
  otherCompanies: {
    padding: "20px 24px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  companyLink: {
    color: "#202223",
    textDecoration: "none",
    fontSize: 13,
    padding: "8px 10px",
    border: "1px solid #eaeaea",
    borderRadius: 8,
  },
  sidebarFooter: {
    marginTop: "auto",
    padding: "16px 24px",
    borderTop: "1px solid #eaeaea",
  },
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
    background: "#e91e63",
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
};
