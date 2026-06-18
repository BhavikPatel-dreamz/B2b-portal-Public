import { LoaderFunctionArgs, redirect } from "react-router";
import { useLoaderData, Link, Form, useNavigation } from "react-router";
import prisma from "app/db.server";
import { requireSalesSession, hasCompanyAccess } from "app/utils/sales-session.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { user } = await requireSalesSession(request);
  const companyId = params.companyId;

  if (!companyId || !hasCompanyAccess(user, companyId)) {
    return redirect("/sales/dashboard");
  }

  // Get full company data including active users and shop to fetch GraphQL
  const company = await prisma.companyAccount.findUnique({
    where: { id: companyId },
    include: {
      shop: {
        select: { shopName: true, shopDomain: true, accessToken: true },
      },
    },
  });

  if (!company || !company.shop) {
    return redirect("/sales/dashboard");
  }

  // Fetch real-time users directly from Shopify (fixes the issue where Shopify users aren't synced locally)
  let activeUsers: Array<{
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    shopifyCustomerId: string | null;
    companyRole: string | null;
  }> = [];

  if (company.shopifyCompanyId && company.shop.accessToken) {
    const { getCompanyCustomers } = await import("app/utils/b2b-customer.server");
    const customersData = await getCompanyCustomers(company.shopifyCompanyId, company.shop.shopDomain, company.shop.accessToken, { first: 50 });
    
    if (!customersData.error && customersData.customers) {
      activeUsers = customersData.customers.map((c: any) => {
        const firstName = c.customer.firstName?.trim() || null;
        const lastName = c.customer.lastName?.trim() || null;
        const companyRole = c.customer.roleAssignments?.edges?.[0]?.node?.role?.name || "Customer";
        const customerId = c.customer.id.split("/").pop();
        
        return {
          id: customerId,
          email: c.customer.email,
          firstName,
          lastName,
          shopifyCustomerId: customerId,
          companyRole
        };
      });
    }
  }

  // Calculate available credit
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

  // Fetch catalogs and price lists assigned to the company locations via Shopify GraphQL
  let catalogs: Array<{ id: string; title: string; priceList: { name: string; currency: string } | null }> = [];
  let priceLists: Array<{ name: string; currency: string }> = [];

  if (company.shopifyCompanyId && company.shop.accessToken) {
    const query = `
      query GetCompanyCatalogs($companyId: ID!) {
        company(id: $companyId) {
          locations(first: 10) {
            nodes {
              catalogs(first: 20) {
                nodes {
                  id
                  title
                  ... on CompanyLocationCatalog {
                    priceList {
                      name
                      currency
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    try {
      const response = await fetch(`https://${company.shop.shopDomain}/admin/api/2025-01/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": company.shop.accessToken,
        },
        body: JSON.stringify({
          query,
          variables: { companyId: company.shopifyCompanyId },
        }),
      });

      const data = await response.json();
      
      if (!data.errors && data.data?.company?.locations?.nodes) {
        const uniqueCatalogs = new Map();
        const uniquePriceLists = new Map();

        data.data.company.locations.nodes.forEach((loc: any) => {
          loc.catalogs?.nodes?.forEach((cat: any) => {
            if (!uniqueCatalogs.has(cat.id)) {
              uniqueCatalogs.set(cat.id, {
                id: cat.id,
                title: cat.title,
                priceList: cat.priceList,
              });
            }
            if (cat.priceList && !uniquePriceLists.has(cat.priceList.name)) {
              uniquePriceLists.set(cat.priceList.name, {
                name: cat.priceList.name,
                currency: cat.priceList.currency,
              });
            }
          });
        });

        catalogs = Array.from(uniqueCatalogs.values());
        priceLists = Array.from(uniquePriceLists.values());
      }
    } catch (e) {
      console.error("Failed to fetch catalogs from Shopify:", e);
    }
  }

  return Response.json({
    company: {
      id: company.id,
      name: company.name,
      creditLimit: creditLimit.toString(),
      availableCredit: availableCredit.toString(),
      users: activeUsers,
      catalogs,
      priceLists,
    },
    user: {
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
    }
  });
};

export default function CreateOrderCustomerSelection() {
  const { company, user } = useLoaderData<{
    company: {
      id: string;
      name: string;
      creditLimit: string;
      availableCredit: string;
      users: Array<{
        id: string;
        firstName: string | null;
        lastName: string | null;
        email: string;
        shopifyCustomerId: string | null;
        companyRole: string | null;
      }>;
      catalogs: Array<{ id: string; title: string; priceList: { name: string; currency: string } | null }>;
      priceLists: Array<{ name: string; currency: string }>;
    };
    user: {
      firstName: string | null;
      lastName: string | null;
      email: string;
    };
  }>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const formatCurrency = (val: string | number) =>
    `$${Number(val).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

  return (
    <div style={styles.container}>
      {/* Top Header Navigation */}
      <header style={styles.header}>
        <div style={styles.headerContent}>
          <div style={styles.breadcrumb}>
            <Link to="/sales/dashboard" style={styles.breadcrumbLink}>Dashboard</Link>
            <span style={styles.breadcrumbSeparator}>/</span>
            <Link to={`/sales/portal?companyId=${company.id}`} style={styles.breadcrumbLink}>{company.name}</Link>
            <span style={styles.breadcrumbSeparator}>/</span>
            <span style={styles.breadcrumbCurrent}>Create Order</span>
          </div>
          <div style={styles.headerUser}>
            <div style={styles.avatar}>
              {user.firstName?.charAt(0) || user.email.charAt(0).toUpperCase()}
            </div>
            <span style={styles.userName}>{user.firstName} {user.lastName}</span>
          </div>
        </div>
      </header>

      <main style={styles.mainContent}>
        <div style={styles.pageHeader}>
          <h1 style={styles.pageTitle}>Create Order: {company.name}</h1>
          <p style={styles.pageSubtitle}>Step 1: Select Customer</p>
        </div>

        {/* Two Column Layout */}
        <div style={styles.twoColGrid}>
          {/* Left Column: Customer Selection */}
          <div style={styles.card}>
            <div style={styles.cardHeader}>
              <h2 style={styles.cardTitle}>Who is this order for?</h2>
              <p style={styles.cardSubtitle}>Select a customer user to proceed with building the order.</p>
            </div>

            {company.users.length > 0 ? (
              <div style={styles.usersList}>
                {company.users.map((companyUser) => (
                  <Form key={companyUser.id} method="post" action={`/sales/portal/company/${company.id}/create-order/step2`} style={styles.userForm}>
                    <input type="hidden" name="customerId" value={companyUser.id} />
                    <button type="submit" style={styles.userCard} disabled={isSubmitting}>
                      <div style={styles.userCardAvatar}>
                        {companyUser.firstName?.charAt(0) || companyUser.email.charAt(0).toUpperCase()}
                      </div>
                      <div style={styles.userCardInfo}>
                        <div style={styles.userCardName}>
                          {companyUser.firstName} {companyUser.lastName}
                        </div>
                        <div style={styles.userCardEmail}>{companyUser.email}</div>
                      </div>
                      <div style={styles.userCardRole}>
                        <span style={styles.roleBadge}>{companyUser.companyRole || "User"}</span>
                      </div>
                      <div style={styles.userCardAction}>
                        Select →
                      </div>
                    </button>
                  </Form>
                ))}
              </div>
            ) : (
              <div style={styles.emptyState}>
                <span style={styles.emptyStateIcon}>👥</span>
                <p style={styles.emptyStateText}>No active users found for this company.</p>
              </div>
            )}
          </div>

          {/* Right Column: Company Info Snapshot */}
          <div style={styles.sideCol}>
            <div style={styles.card}>
              <h3 style={styles.sectionTitle}>Company Snapshot</h3>
              
              <div style={styles.infoList}>
                <div style={styles.infoRow}>
                  <span style={styles.infoLabel}>Company Name</span>
                  <span style={styles.infoValue}>{company.name}</span>
                </div>
                
                <div style={styles.divider} />
                
                <div style={styles.infoRow}>
                  <span style={styles.infoLabel}>Credit Limit</span>
                  <span style={styles.infoValue}>{formatCurrency(company.creditLimit)}</span>
                </div>
                <div style={styles.infoRow}>
                  <span style={styles.infoLabel}>Available Credit</span>
                  <span style={{ ...styles.infoValue, color: Number(company.availableCredit) > 0 ? "#16a34a" : "#dc2626" }}>
                    {formatCurrency(company.availableCredit)}
                  </span>
                </div>

                <div style={styles.divider} />

                <div style={styles.infoCol}>
                  <span style={styles.infoLabel}>Assigned Catalogs ({company.catalogs.length})</span>
                  {company.catalogs.length > 0 ? (
                    <div style={styles.tagList}>
                      {company.catalogs.map(cat => (
                        <span key={cat.id} style={styles.tag}>{cat.title}</span>
                      ))}
                    </div>
                  ) : (
                    <span style={styles.emptyText}>No catalogs assigned</span>
                  )}
                </div>

                <div style={styles.divider} />

                <div style={styles.infoCol}>
                  <span style={styles.infoLabel}>Assigned Price Lists ({company.priceLists.length})</span>
                  {company.priceLists.length > 0 ? (
                    <div style={styles.tagList}>
                      {company.priceLists.map(pl => (
                        <span key={pl.name} style={styles.tag}>{pl.name} ({pl.currency})</span>
                      ))}
                    </div>
                  ) : (
                    <span style={styles.emptyText}>No price lists assigned</span>
                  )}
                </div>

              </div>
            </div>
          </div>
        </div>
      </main>

      <style>{`
        button:hover:not(:disabled) {
          border-color: #E91E63 !important;
          background-color: #fff0f4 !important;
        }
      `}</style>
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    flexDirection: "column" as const,
    minHeight: "100vh",
    backgroundColor: "#f9fafb",
    fontFamily: "'Inter', system-ui, sans-serif",
  },
  header: {
    backgroundColor: "#ffffff",
    borderBottom: "1px solid #eaeaea",
    padding: "0 40px",
    height: "64px",
    display: "flex",
    alignItems: "center",
  },
  headerContent: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    width: "100%",
    maxWidth: "1200px",
    margin: "0 auto",
  },
  breadcrumb: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: "14px",
  },
  breadcrumbLink: {
    color: "#4b5563",
    textDecoration: "none",
    fontWeight: 500,
    transition: "color 0.2s",
  },
  breadcrumbSeparator: {
    color: "#d1d5db",
  },
  breadcrumbCurrent: {
    color: "#111827",
    fontWeight: 600,
  },
  headerUser: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
  },
  avatar: {
    width: "32px",
    height: "32px",
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
  userName: {
    fontSize: "14px",
    fontWeight: 500,
    color: "#374151",
  },
  mainContent: {
    flex: 1,
    padding: "40px",
    width: "100%",
    maxWidth: "1200px",
    margin: "0 auto",
  },
  pageHeader: {
    marginBottom: "32px",
  },
  pageTitle: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: "28px",
    fontWeight: 700,
    color: "#111827",
    margin: "0 0 8px 0",
    letterSpacing: "-0.02em",
  },
  pageSubtitle: {
    fontSize: "16px",
    color: "#6b7280",
    margin: 0,
  },
  twoColGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 340px",
    gap: "24px",
    alignItems: "start",
  },
  card: {
    backgroundColor: "white",
    borderRadius: "16px",
    boxShadow: "0 4px 6px -1px rgba(0,0,0,0.05), 0 2px 4px -1px rgba(0,0,0,0.03)",
    border: "1px solid #f3f4f6",
    padding: "24px",
  },
  cardHeader: {
    marginBottom: "24px",
  },
  cardTitle: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: "18px",
    fontWeight: 600,
    color: "#111827",
    margin: "0 0 4px 0",
  },
  cardSubtitle: {
    fontSize: "14px",
    color: "#6b7280",
    margin: 0,
  },
  usersList: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "12px",
  },
  userForm: {
    margin: 0,
  },
  userCard: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: "16px",
    padding: "16px",
    backgroundColor: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: "12px",
    cursor: "pointer",
    transition: "all 0.2s ease",
    textAlign: "left" as const,
  },
  userCardAvatar: {
    width: "40px",
    height: "40px",
    borderRadius: "50%",
    backgroundColor: "#f3f4f6",
    color: "#4b5563",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 600,
    fontSize: "16px",
    fontFamily: "'Poppins', sans-serif",
    flexShrink: 0,
  },
  userCardInfo: {
    flex: 1,
    minWidth: 0,
  },
  userCardName: {
    fontWeight: 600,
    fontSize: "15px",
    color: "#111827",
    marginBottom: "2px",
  },
  userCardEmail: {
    fontSize: "13px",
    color: "#6b7280",
    whiteSpace: "nowrap" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  userCardRole: {
    flexShrink: 0,
  },
  roleBadge: {
    backgroundColor: "#f3f4f6",
    padding: "4px 10px",
    borderRadius: "20px",
    fontSize: "12px",
    fontWeight: 500,
    color: "#4b5563",
    textTransform: "capitalize" as const,
  },
  userCardAction: {
    fontSize: "14px",
    fontWeight: 600,
    color: "#E91E63",
    paddingLeft: "16px",
  },
  emptyState: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    padding: "48px",
    color: "#6b7280",
    textAlign: "center" as const,
    backgroundColor: "#f9fafb",
    borderRadius: "12px",
    border: "1px dashed #d1d5db",
  },
  emptyStateIcon: {
    fontSize: "32px",
    marginBottom: "12px",
  },
  emptyStateText: {
    margin: 0,
    fontSize: "14px",
    fontWeight: 500,
  },
  sideCol: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "24px",
  },
  sectionTitle: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: "16px",
    fontWeight: 600,
    color: "#111827",
    margin: "0 0 20px 0",
  },
  infoList: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "16px",
  },
  infoRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  infoCol: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "8px",
  },
  infoLabel: {
    fontSize: "13px",
    color: "#6b7280",
    fontWeight: 500,
  },
  infoValue: {
    fontSize: "14px",
    color: "#111827",
    fontWeight: 600,
  },
  divider: {
    height: "1px",
    backgroundColor: "#f3f4f6",
  },
  tagList: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: "8px",
  },
  tag: {
    backgroundColor: "#fdf4f7",
    color: "#be185d",
    padding: "4px 10px",
    borderRadius: "6px",
    fontSize: "12px",
    fontWeight: 500,
    border: "1px solid #fbcfe8",
  },
  emptyText: {
    fontSize: "13px",
    color: "#9ca3af",
    fontStyle: "italic" as const,
  },
};
