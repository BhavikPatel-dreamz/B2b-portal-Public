import {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  Link,
  redirect,
  useLoaderData,
} from "react-router";
import { useState } from "react";
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
import { getCreditSummary } from "app/services/creditService";
import { getThemePalette, type ThemePalette } from "app/utils/theme.server";

type ShopifyCompanyCustomer = {
  customerId?: string;
  id?: string;
  name?: string;
  email?: string;
  isGlobalAdmin?: boolean;
  roles?: string[];
  locationIds?: string[];
  locationNames?: string[];
  locationRoles?: Array<{
    roleName?: string | null;
    locationName?: string | null;
  }>;
  customer?: {
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

type CompanyUserOption = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  shopifyCustomerId: string | null;
  companyRole: string | null;
  locationIds: string[];
  locationNames: string[];
  isGlobalAdmin: boolean;
};

type ShopifyCatalogNode = {
  id: string;
  title: string;
  priceList: { name: string; currency: string } | null;
};

type ShopifyCatalogLocation = {
  id: string;
  name: string;
  phone?: string | null;
  shippingAddress?: {
    address1?: string | null;
    address2?: string | null;
    city?: string | null;
    province?: string | null;
    country?: string | null;
    zip?: string | null;
    phone?: string | null;
  } | null;
  catalogs?: { nodes?: ShopifyCatalogNode[] } | null;
};

type CompanyCatalogsResponse = {
  errors?: unknown;
  data?: {
    company?: {
      locations?: { nodes?: ShopifyCatalogLocation[] } | null;
    } | null;
  };
};

function formatLocationAddress(
  address?: ShopifyCatalogLocation["shippingAddress"],
) {
  if (!address) return [];
  const cityLine = [address.city, address.province, address.zip]
    .filter(Boolean)
    .join(", ");
  return [
    address.address1,
    address.address2,
    cityLine,
    address.country,
  ]
    .map((line) => String(line || "").trim())
    .filter(Boolean);
}

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

  return Response.json({ error: "Unknown intent" }, { status: 400 });
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { user } = await requireSalesSession(request);
  const companyId = params.companyId;
  const isQuoteMode = new URL(request.url).pathname.includes("create-quote");

  if (!companyId) {
    return redirect("/sales/portal");
  }

  if (!hasCompanyAccess(user, companyId)) {
    return redirect("/sales/portal");
  }

  // Get full company data including active users and shop to fetch GraphQL
  const company = await prisma.companyAccount.findUnique({
    where: { id: companyId },
    include: {
      shop: {
        select: {
          shopName: true,
          shopDomain: true,
          accessToken: true,
          currencyCode: true,
          plan: true,
          themeColor: true,
        },
      },
    },
  });

  if (!company || !company.shop) {
    return redirect("/sales/portal");
  }

  // Fetch real-time users directly from Shopify (fixes the issue where Shopify users aren't synced locally)
  let activeUsers: CompanyUserOption[] = [];

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
        .map((c: ShopifyCompanyCustomer) => {
          const fallbackName = c.name?.trim() || "";
          const [fallbackFirstName, ...fallbackLastParts] =
            fallbackName.split(/\s+/).filter(Boolean);
          const firstName =
            c.customer?.firstName?.trim() || fallbackFirstName || null;
          const lastName =
            c.customer?.lastName?.trim() ||
            fallbackLastParts.join(" ") ||
            null;
          const locationRoleNames =
            c.locationRoles
              ?.map((role) => role.roleName || "")
              .filter(Boolean) || [];
          const roleNames =
            [
              ...(c.roles || []),
              ...locationRoleNames,
              ...(c.customer?.roleAssignments?.edges
                ?.map((edge) => edge.node?.role?.name || "")
                .filter(Boolean) || []),
            ];
          const adminRole =
            roleNames.find((role) =>
              role.toLowerCase().includes("admin"),
            ) || null;
          const companyRole =
            adminRole ||
            roleNames[0] ||
            "Ordering only";
          const customerId =
            (c.customerId || c.customer?.id || c.id || "")
            .split("/")
            .pop() || "";
          const locationNames =
            c.locationNames ||
            c.locationRoles
              ?.map((role) => role.locationName || "")
              .filter(Boolean) ||
            [];

          return {
            id: customerId,
            email: c.customer?.email || c.email || "",
            firstName,
            lastName,
            shopifyCustomerId: customerId,
            companyRole,
            locationIds: c.locationIds || [],
            locationNames,
            isGlobalAdmin: Boolean(c.isGlobalAdmin),
          };
        })
        .filter((u: CompanyUserOption) =>
          u.isGlobalAdmin ||
          String(u.companyRole || "").toLowerCase().includes("admin"),
        );
    }
  }

  const creditSummary = await getCreditSummary(company.id);

  if (!creditSummary) {
    throw new Response("Unable to fetch credit summary", { status: 500 });
  }

  const isFreePlan = company.shop.plan === "free";
  const creditLimit = isFreePlan ? 0 : creditSummary.creditLimit.toNumber();
  const availableCredit = isFreePlan
    ? 0
    : Math.max(0, creditSummary.availableCredit.toNumber());

  // Fetch catalogs and price lists assigned to the company locations via Shopify GraphQL
  let catalogs: Array<{
    id: string;
    title: string;
    priceList: { name: string; currency: string } | null;
  }> = [];
  let priceLists: Array<{ name: string; currency: string }> = [];
  let locations: Array<{
    id: string;
    name: string;
    phone: string | null;
    addressLines: string[];
  }> = [];

  if (company.shopifyCompanyId && company.shop.accessToken) {
    const query = `
      query GetCompanyCatalogs($companyId: ID!) {
        company(id: $companyId) {
          locations(first: 50) {
            nodes {
              id
              name
              phone
              shippingAddress {
                address1
                address2
                city
                province
                country
                zip
                phone
              }
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
      const response = await fetch(
        `https://${company.shop.shopDomain}/admin/api/2025-01/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": company.shop.accessToken,
          },
          body: JSON.stringify({
            query,
            variables: { companyId: company.shopifyCompanyId },
          }),
        },
      );

      const data = (await response.json()) as CompanyCatalogsResponse;

      if (!data.errors && data.data?.company?.locations?.nodes) {
        locations = data.data.company.locations.nodes.map((loc) => ({
          id: loc.id,
          name: loc.name || "Company location",
          phone: loc.shippingAddress?.phone || loc.phone || null,
          addressLines: formatLocationAddress(loc.shippingAddress),
        }));

        const uniqueCatalogs = new Map<string, ShopifyCatalogNode>();
        const uniquePriceLists = new Map<
          string,
          { name: string; currency: string }
        >();

        data.data.company.locations.nodes.forEach((loc) => {
          loc.catalogs?.nodes?.forEach((cat) => {
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
      storeName: company.shop.shopName || company.shop.shopDomain,
      creditLimit: creditLimit.toString(),
      availableCredit: availableCredit.toString(),
      currencyCode: company.shop.currencyCode || "USD",
      users: activeUsers,
      locations,
      catalogs,
      priceLists,
      themeColor: company.shop.themeColor,
      theme: getThemePalette(company.shop.themeColor),
    },
    user: {
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
    },
    mode: isQuoteMode ? "quote" : "order",
  });
};

export default function CreateOrderCustomerSelection() {
  const { company, user, mode } = useLoaderData<{
    company: {
      id: string;
      name: string;
      storeName: string | null;
      creditLimit: string;
      availableCredit: string;
      currencyCode: string;
      users: CompanyUserOption[];
      locations: Array<{
        id: string;
        name: string;
        phone: string | null;
        addressLines: string[];
      }>;
      catalogs: Array<{
        id: string;
        title: string;
        priceList: { name: string; currency: string } | null;
      }>;
      priceLists: Array<{ name: string; currency: string }>;
      themeColor?: string | null;
      theme: ThemePalette;
    };
    user: {
      firstName: string | null;
      lastName: string | null;
      email: string;
    };
    mode: "order" | "quote";
  }>();
  
  // Use theme palette from loader
  const theme = company.theme;
  const [selectedLocationId, setSelectedLocationId] = useState(
    company.locations[0]?.id || "",
  );
  const flowBase =
    mode === "quote"
      ? `/sales/portal/company/${company.id}/create-quote`
      : `/sales/portal/company/${company.id}/create-order`;
  const flowLabel = mode === "quote" ? "Create Quote" : "Create Order";
  const selectedLocation = company.locations.find(
    (location) => location.id === selectedLocationId,
  );
  const locationAdmins = company.users.filter((companyUser) =>
    companyUser.locationIds.includes(selectedLocationId) ||
    Boolean(
      selectedLocation?.name &&
        companyUser.locationNames.some(
          (name) =>
            name.trim().toLowerCase() ===
            selectedLocation.name.trim().toLowerCase(),
        ),
    ),
  );
  const globalAdmins = company.users.filter(
    (companyUser) => companyUser.isGlobalAdmin,
  );
  const fallbackAdmins = company.users.filter(
    (companyUser) => companyUser.locationIds.length === 0,
  );
  const selectedAdmin =
    locationAdmins[0] || globalAdmins[0] || fallbackAdmins[0] || null;
  const buildStep2Url = (customerId: string) => {
    const params = new URLSearchParams({ customerId });
    if (selectedLocationId) {
      params.set("locationId", selectedLocationId);
    }
    return `${flowBase}/step2?${params.toString()}`;
  };
  const selectedAdminName = selectedAdmin
    ? [selectedAdmin.firstName, selectedAdmin.lastName]
        .filter(Boolean)
        .join(" ") || selectedAdmin.email
    : "";
  const formatCurrency = (val: string | number) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: company.currencyCode,
    }).format(Number(val) || 0);

  return (
    <SalesPortalLayout
      company={company}
      user={user}
      activePage={mode === "quote" ? "quotes" : "orders"}
    >
      <SalesPortalHeader
        title={`${flowLabel}: ${company.name}`}
        subtitle="Step 1: Select Customer"
        companyId={company.id}
        actions={
          <Link
            to={`/sales/portal?companyId=${company.id}`}
            style={salesPortalButtonStyles.secondary}
          >
            Back to Overview
          </Link>
        }
      />
      <div style={styles.container}>
        <main style={styles.mainContent}>
          <div style={styles.pageHeader}>
            <h1 style={styles.pageTitle}>
              {flowLabel}: {company.name}
            </h1>
            <p style={styles.pageSubtitle}>Step 1: Select Customer</p>
          </div>

          {/* Two Column Layout */}
          <div style={styles.twoColGrid}>
            {/* Left Column: Customer Selection */}
            <div style={styles.card}>
              <div style={styles.cardHeader}>
                <h2 style={styles.cardTitle}>Select delivery location</h2>
                <p style={styles.cardSubtitle}>
                  Choose the company location. The related admin user will be
                  selected automatically.
                </p>
              </div>

              <div>
                <label style={styles.locationLabel} htmlFor="deliveryLocation">
                  Delivery location
                </label>
                {company.locations.length > 0 ? (
                  <>
                    <select
                      id="deliveryLocation"
                      value={selectedLocationId}
                      onChange={(event) =>
                        setSelectedLocationId(event.currentTarget.value)
                      }
                      style={styles.locationSelect}
                    >
                      {company.locations.map((location) => (
                        <option key={location.id} value={location.id}>
                          {location.name}
                        </option>
                      ))}
                    </select>
                    <p style={styles.locationHint}>
                      {selectedLocation
                        ? `${flowLabel} will use ${selectedLocation.name} for B2B delivery, pricing, and admin selection.`
                        : "Select a Shopify company location to continue."}
                    </p>
                  </>
                ) : (
                  <p style={styles.locationWarning}>
                    No Shopify company locations were found. The next step will
                    use Shopify's default B2B location if available.
                  </p>
                )}
              </div>

              {selectedLocation && (
                <div style={styles.locationDetailsCard}>
                  <div>
                    <span style={styles.infoLabel}>Location Details</span>
                    <strong style={styles.locationName}>
                      {selectedLocation.name}
                    </strong>
                  </div>
                  {selectedLocation.addressLines.length > 0 ? (
                    <address style={styles.addressText}>
                      {selectedLocation.addressLines.map((line) => (
                        <span key={line}>{line}</span>
                      ))}
                    </address>
                  ) : (
                    <p style={styles.locationHint}>
                      No shipping address is configured for this location.
                    </p>
                  )}
                  {selectedLocation.phone && (
                    <span style={styles.locationPhone}>
                      Phone: {selectedLocation.phone}
                    </span>
                  )}
                </div>
              )}

              <div style={styles.locationSelectorSection}>
                <span style={styles.locationLabel}>Auto-selected admin</span>
                {selectedAdmin ? (
                  <div style={styles.userCard}>
                    <div style={styles.userCardAvatar}>
                      {selectedAdmin.firstName?.charAt(0) ||
                        selectedAdmin.email.charAt(0).toUpperCase()}
                    </div>
                    <div style={styles.userCardInfo}>
                      <div style={styles.userCardName}>
                        {selectedAdminName}
                      </div>
                      <div style={styles.userCardEmail}>
                        {selectedAdmin.email}
                      </div>
                    </div>
                    <div style={styles.userCardRole}>
                      <span style={styles.roleBadge}>
                        {selectedAdmin.isGlobalAdmin
                          ? "Global admin"
                          : selectedAdmin.companyRole || "Admin"}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div style={styles.emptyState}>
                    <p style={styles.emptyStateText}>
                      No admin user is assigned to this location.
                    </p>
                  </div>
                )}
              </div>

              <div style={styles.adminListSection}>
                <span style={styles.locationLabel}>
                  Admin users ({company.users.length})
                </span>
                {company.users.length > 0 ? (
                  <div style={styles.usersList}>
                    {company.users.map((companyUser) => (
                      <div
                        key={companyUser.id}
                        style={{
                          ...styles.adminListItem,
                          borderColor:
                            companyUser.id === selectedAdmin?.id
                              ? theme.accentTint
                              : "#e5e7eb",
                          backgroundColor:
                            companyUser.id === selectedAdmin?.id
                              ? theme.accentLighter
                              : "#ffffff",
                        }}
                      >
                        <div style={styles.userCardInfo}>
                          <div style={styles.userCardName}>
                            {[companyUser.firstName, companyUser.lastName]
                              .filter(Boolean)
                              .join(" ") || companyUser.email}
                          </div>
                          <div style={styles.userCardEmail}>
                            {companyUser.locationNames.length > 0
                              ? companyUser.locationNames.join(", ")
                              : "Company admin"}
                          </div>
                        </div>
                        <span style={styles.roleBadge}>
                          {companyUser.isGlobalAdmin
                            ? "Global admin"
                            : companyUser.companyRole || "Admin"}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p style={styles.locationWarning}>
                    No admin users found for this company.
                  </p>
                )}
              </div>

              {selectedAdmin ? (
                <Link
                  to={buildStep2Url(
                    selectedAdmin.shopifyCustomerId || selectedAdmin.id,
                  )}
                  style={{ ...styles.continueButton, backgroundColor: theme.accent }}
                >
                  Continue with {selectedAdminName} →
                </Link>
              ) : (
                <button type="button" disabled style={styles.disabledContinueButton}>
                  Assign an admin to continue
                </button>
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
                    <span style={styles.infoValue}>
                      {formatCurrency(company.creditLimit)}
                    </span>
                  </div>
                  <div style={styles.infoRow}>
                    <span style={styles.infoLabel}>Available Credit</span>
                    <span
                      style={{
                        ...styles.infoValue,
                        color:
                          Number(company.availableCredit) > 0
                            ? "#16a34a"
                            : "#dc2626",
                      }}
                    >
                      {formatCurrency(company.availableCredit)}
                    </span>
                  </div>

                  <div style={styles.divider} />

                  <div style={styles.infoCol}>
                    <span style={styles.infoLabel}>
                      Company Locations ({company.locations.length})
                    </span>
                    {company.locations.length > 0 ? (
                      <div style={styles.tagList}>
                        {company.locations.map((location) => (
                          <span key={location.id} style={{ ...styles.tag, backgroundColor: theme.accentLighter, color: theme.accent, borderColor: theme.accentTint }}>
                            {location.name}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span style={styles.emptyText}>
                        No locations assigned
                      </span>
                    )}
                  </div>

                  <div style={styles.divider} />

                  <div style={styles.infoCol}>
                    <span style={styles.infoLabel}>
                      Assigned Catalogs ({company.catalogs.length})
                    </span>
                    {company.catalogs.length > 0 ? (
                      <div style={styles.tagList}>
                        {company.catalogs.map((cat) => (
                          <span key={cat.id} style={{ ...styles.tag, backgroundColor: theme.accentLighter, color: theme.accent, borderColor: theme.accentTint }}>
                            {cat.title}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span style={styles.emptyText}>No catalogs assigned</span>
                    )}
                  </div>

                  <div style={styles.divider} />

                  <div style={styles.infoCol}>
                    <span style={styles.infoLabel}>
                      Assigned Price Lists ({company.priceLists.length})
                    </span>
                    {company.priceLists.length > 0 ? (
                      <div style={styles.tagList}>
                        {company.priceLists.map((pl) => (
                          <span key={pl.name} style={{ ...styles.tag, backgroundColor: theme.accentLighter, color: theme.accent, borderColor: theme.accentTint }}>
                            {pl.name} ({pl.currency})
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span style={styles.emptyText}>
                        No price lists assigned
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>

        <style>{`
        button:hover:not(:disabled) {
          border-color: ${theme.accent} !important;
          background-color: ${theme.accentLighter} !important;
        }
      `}</style>
      </div>
    </SalesPortalLayout>
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
    boxShadow:
      "0 4px 6px -1px rgba(0,0,0,0.05), 0 2px 4px -1px rgba(0,0,0,0.03)",
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
  locationSelectorSection: {
    marginTop: "24px",
    paddingTop: "20px",
    borderTop: "1px solid #f3f4f6",
  },
  locationLabel: {
    display: "block",
    marginBottom: "8px",
    fontSize: "13px",
    color: "#374151",
    fontWeight: 700,
  },
  locationSelect: {
    width: "100%",
    height: "44px",
    borderRadius: "8px",
    border: "1px solid #d1d5db",
    backgroundColor: "#ffffff",
    color: "#111827",
    padding: "0 12px",
    fontSize: "14px",
    fontWeight: 600,
  },
  locationHint: {
    margin: "8px 0 0",
    fontSize: "12px",
    color: "#6b7280",
    lineHeight: 1.5,
  },
  locationWarning: {
    margin: 0,
    fontSize: "13px",
    color: "#b45309",
    lineHeight: 1.5,
  },
  locationDetailsCard: {
    marginTop: "16px",
    padding: "16px",
    borderRadius: "8px",
    border: "1px solid #e5e7eb",
    backgroundColor: "#f9fafb",
    display: "flex",
    flexDirection: "column" as const,
    gap: "8px",
  },
  locationName: {
    display: "block",
    marginTop: "4px",
    color: "#111827",
    fontSize: "15px",
  },
  addressText: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "3px",
    margin: 0,
    color: "#374151",
    fontSize: "13px",
    fontStyle: "normal",
    lineHeight: 1.45,
  },
  locationPhone: {
    color: "#4b5563",
    fontSize: "13px",
    fontWeight: 600,
  },
  adminListSection: {
    marginTop: "18px",
  },
  adminListItem: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    padding: "12px",
    border: "1px solid #e5e7eb",
    borderRadius: "8px",
  },
  continueButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginTop: "20px",
    minHeight: "44px",
    borderRadius: "8px",
    color: "#ffffff",
    textDecoration: "none",
    fontSize: "14px",
    fontWeight: 700,
  },
  disabledContinueButton: {
    width: "100%",
    marginTop: "20px",
    minHeight: "44px",
    borderRadius: "8px",
    border: "1px solid #d1d5db",
    backgroundColor: "#f3f4f6",
    color: "#9ca3af",
    fontSize: "14px",
    fontWeight: 700,
    cursor: "not-allowed",
  },
  userForm: {
    margin: 0,
    textDecoration: "none",
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
    padding: "4px 10px",
    borderRadius: "6px",
    fontSize: "12px",
    fontWeight: 500,
    border: "1px solid",
  },
  emptyText: {
    fontSize: "13px",
    color: "#9ca3af",
    fontStyle: "italic" as const,
  },
};
