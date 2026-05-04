import {
  useFetcher,
  useLoaderData,
  Link,
  useSearchParams,
  useNavigation,
  useRevalidator,
  useNavigate,
} from "react-router";
import { useEffect, useState, useRef } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  RegistrationApprovalsPanel,
  type RegistrationSubmission,
} from "./app.registrations";
import { formatCredit } from "../utils/company.utils";
import type { FormConfig } from "../utils/form-config.shared";
import type { CountryOption } from "app/components/registrations/EditDetailsModal";

type LoaderCompany = {
  id: string;
  name: string;
  shopifyCompanyId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  paymentTerm: string | null;
  creditLimit: string;
  usedCredit: string;
  pendingCredit: string;
  availableCredit: string;
  creditUsagePercentage: number;
  updatedAt: string;
  userCount: number;
  isDisable: boolean;
};

type RegistrationStatusTab = "companies" | "pending" | "rejected";
type CompanySortField = "updatedAt" | "name" | "contact" | "users";
type CompanySortDirection = "asc" | "desc";

interface ActionResponse {
  intent: string;
  success: boolean;
  message?: string;
  errors?: string[];
}

interface RegistrationsLoaderData {
  submissions: RegistrationSubmission[];
  formConfig: FormConfig;
  shippingCountryOptions: CountryOption[];
  shippingProvincesByCountry: Record<string, CountryOption[]>;
  paymentTermsTemplates: Array<{
    id: string;
    name: string;
    paymentTermsType: string;
    dueInDays: number | null;
  }>;
  allCatalogs: any[];
  priceLists: any[];
  storeMissing: boolean;
  isFreePlan: boolean;
  currencyCode: string;
}

function formatDisplayDate(value: string) {
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

function downloadCsv(filename: string, rows: string[][]) {
  const csv = rows
    .map((row) =>
      row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(","),
    )
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function normalizeTab(value: string | null): RegistrationStatusTab {
  switch (value?.toLowerCase()) {
    case "pending":
      return "pending";
    case "rejected":
      return "rejected";
    default:
      return "companies";
  }
}

export default function CompaniesPage() {
  const {
    companies,
    submissions,
    activeTab,
    pendingCount,
    approvedCount,
    rejectedCount,
    formConfig,
    shippingCountryOptions,
    shippingProvincesByCountry,
    paymentTermsTemplates,
    allCatalogs,
    priceLists,
    storeMissing,
    currencyCode,
    totalCount,
    currentPage,
    totalPages,
    searchQuery,
    sortField,
    sortDirection,
    isFreePlan,
    freePlanCompanyCount,
    freePlanRegistrationCount,
    freePlanCompanyLimit,
    freePlanRegistrationLimit,
    freePlanCompanyLimitReached,
    freePlanRegistrationLimitReached,
  } = useLoaderData<typeof import("./app.companies").loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const intervalIdRef = useRef<NodeJS.Timeout | null>(null);
  const registrationsFetcher = useFetcher<RegistrationsLoaderData>();

  // Controlled search input
  const [query, setQuery] = useState(searchQuery);
  const [pendingCompanyId, setPendingCompanyId] = useState<string | null>(null);
  const [selectedTab, setSelectedTab] =
    useState<RegistrationStatusTab>(activeTab);
  const [registrationData, setRegistrationData] =
    useState<RegistrationsLoaderData | null>(() =>
      formConfig
        ? {
          submissions,
          formConfig,
          shippingCountryOptions,
          shippingProvincesByCountry,
          paymentTermsTemplates,
          allCatalogs,
          priceLists,
          storeMissing,
          isFreePlan,
          currencyCode,
        }
        : null,
    );
  const derivedRegistrationCounts = registrationData?.submissions.reduce(
    (counts, submission) => {
      if (submission.status === "PENDING") counts.pending += 1;
      if (submission.status === "APPROVED") counts.approved += 1;
      if (submission.status === "REJECTED") counts.rejected += 1;
      return counts;
    },
    { pending: 0, approved: 0, rejected: 0 },
  );
  const displayedPendingCount =
    derivedRegistrationCounts?.pending ?? pendingCount;
  const displayedRejectedCount =
    derivedRegistrationCounts?.rejected ?? rejectedCount;
  const actionButtonWidth = 124;
  const pageShellStyle = {
    background: "#f1f2f4",
    minHeight: "100vh",
    padding: "24px",
    boxSizing: "border-box",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "San Francisco", "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
  } as const;
  const pageHeroStyle = {
    width: "100%",
    maxWidth: 1200,
    margin: "0 auto 18px",
    padding: "0px 0px 16px 0px",  
    borderRadius: 14,
    border: "1px solid #dfe3e8",
    background: "linear-gradient(135deg, #ffffff 0%)",
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
  } as const;
  const pageEyebrowStyle = {
    fontSize: "11px",
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    color: "#2c6ecb",
    marginBottom: "6px",
  } as const;
  const pageHeroTitleStyle = {
    fontSize: "22px",
    lineHeight: 1.15,
    fontWeight: 650,
    color: "#202223",
    margin: "15px",
  } as const;
  const pageHeroTextStyle = {
    fontSize: "14px",
    color: "#5c5f62",
    margin: "0 15px 0",
  } as const;
  const tabsRowStyle = {
    display: "flex",
    gap: 12,
    marginBottom: 16,
    paddingBottom: 2,
    borderBottom: "1px solid #e3e3e3",
    flexWrap: "wrap" as const,
  } as const;
  const toolbarStyle = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap" as const,
    marginBottom: 16,
    padding: 14,
    border: "1px solid #dde3ea",
    borderRadius: 14,
    background: "linear-gradient(180deg, #ffffff 0%, #f8fbff 100%)",
  } as const;
  const tableCardStyle = {
    position: "relative" as const,
    overflowX: "auto" as const,
    overflowY: "hidden" as const,
    border: "1px solid #e3e7ec",
    borderRadius: 12,
    background: "#ffffff",
  } as const;
  const tableHeaderCellStyle = {
    textAlign: "left" as const,
    padding: "14px 16px",
    fontSize: 13,
    fontWeight: 650,
    color: "#202223",
    background: "#fbfbfc",
    borderBottom: "1px solid #e3e7ec",
    whiteSpace: "nowrap" as const,
  } as const;
  const sortableHeaderButtonStyle = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    border: "none",
    background: "transparent",
    padding: 0,
    font: "inherit",
    fontWeight: 650,
    color: "#202223",
    cursor: "pointer",
  } as const;
  const tableCellStyle = {
    padding: "14px 16px",
    verticalAlign: "top" as const,
    lineHeight: 1.45,
    color: "#202223",
    borderTop: "1px solid #eef1f4",
  } as const;
  const contentPanelStyle = {
    width: "100%",
    maxWidth: 1200,
    margin: "0 auto",
    boxSizing: "border-box",
  } as const;

  // Auto-refresh effect (30 seconds interval)
  useEffect(() => {
    if (selectedTab !== "companies") {
      return;
    }

    const AUTO_REFRESH_INTERVAL = 30 * 1000; // 30 seconds

    intervalIdRef.current = setInterval(() => {
      console.log("🔄 Auto-refreshing companies list");
      revalidator.revalidate();
    }, AUTO_REFRESH_INTERVAL);

    return () => {
      if (intervalIdRef.current) {
        clearInterval(intervalIdRef.current);
      }
    };
  }, [revalidator, selectedTab]);

  useEffect(() => {
    if (!registrationsFetcher.data) {
      return;
    }

    setRegistrationData(registrationsFetcher.data);
  }, [registrationsFetcher.data]);

  const loadRegistrations = () => {
    if (registrationData || registrationsFetcher.state !== "idle") {
      return;
    }

    const registrationParams = new URLSearchParams();
    const shop = searchParams.get("shop");

    if (shop) {
      registrationParams.set("shop", shop);
    }

    const queryString = registrationParams.toString();
    registrationsFetcher.load(
      queryString ? `/app/registrations?${queryString}` : "/app/registrations",
    );
  };

  const updateTabInUrl = (nextTab: RegistrationStatusTab) => {
    if (typeof window === "undefined") {
      return;
    }

    const nextUrl = new URL(window.location.href);

    if (nextTab === "companies") {
      nextUrl.searchParams.delete("tab");
    } else {
      nextUrl.searchParams.set("tab", nextTab);
    }

    window.history.replaceState(window.history.state, "", nextUrl);
  };

  const handleTabChange = (nextTab: RegistrationStatusTab) => {
    setSelectedTab(nextTab);
    updateTabInUrl(nextTab);

    if (nextTab !== "companies") {
      loadRegistrations();
    }
  };

  const buildCompaniesQueryString = (
    overrides: Record<string, string | null | undefined>,
  ) => {
    const nextParams = new URLSearchParams(searchParams);

    Object.entries(overrides).forEach(([key, value]) => {
      if (!value) {
        nextParams.delete(key);
      } else {
        nextParams.set(key, value);
      }
    });

    return `?${nextParams.toString()}`;
  };

  const toggleSort = (field: CompanySortField) => {
    const nextDirection: CompanySortDirection =
      sortField === field && sortDirection === "asc" ? "desc" : "asc";

    setSearchParams((prev) => {
      const nextParams = new URLSearchParams(prev);
      nextParams.set("page", "1");
      nextParams.set("sortField", field);
      nextParams.set("sortDirection", nextDirection);
      nextParams.delete("sort");
      return nextParams;
    });
  };

  const renderSortArrow = (field: CompanySortField) => {
    if (sortField !== field) {
      return <span style={{ color: "#8c9196", fontSize: 12 }}>↕</span>;
    }

    return (
      <span style={{ color: "#2c6ecb", fontSize: 12 }}>
        {sortDirection === "asc" ? "↑" : "↓"}
      </span>
    );
  };

  const exportCompaniesCsv = () => {
    downloadCsv("companies.csv", [
      [
        "Company",
        "Shopify Company ID",
        "Contact Name",
        "Contact Email",
        "Users",
        ...(!isFreePlan ? ["Payment Terms"] : []),
        "Updated At",
        "Status",
        ...(!isFreePlan
          ? ["Credit Limit", "Used Credit", "Available Credit", "Usage %"]
          : []),
      ],
      ...companies.map((company) => [
        company.name,
        company.shopifyCompanyId?.replace(
          "gid://shopify/Company/",
          "",
        ) || "",
        company.contactName || "",
        company.contactEmail || "",
        String(company.userCount),
        ...(!isFreePlan ? [company.paymentTerm || "No payment terms"] : []),
        formatDisplayDate(company.updatedAt),
        company.isDisable ? "Inactive" : "Active",
        ...(!isFreePlan
          ? [
              company.creditLimit,
              company.usedCredit,
              company.availableCredit,
              String(company.creditUsagePercentage),
            ]
          : []),
      ]),
    ]);
  };

  const updateFetcher = useFetcher<ActionResponse>();
  const syncFetcher = useFetcher<ActionResponse>();
  const shopify = useAppBridge();

  const isUpdating = updateFetcher.state !== "idle";
  const isSyncing = syncFetcher.state !== "idle";
  const isLoadingRegistrationTab =
    selectedTab !== "companies" &&
    !registrationData &&
    registrationsFetcher.state !== "idle";

  // derive searching state from router navigation
  const navigation = useNavigation();
  const isSearching =
    navigation.state !== "idle" &&
    (navigation.location?.search?.includes("search=") ||
      Boolean(searchParams.get("search")));

  useEffect(() => {
    if (navigation.state === "idle") {
      setPendingCompanyId(null);
    }
  }, [navigation.state]);

  // Handle sync companies response
  useEffect(() => {
    if (syncFetcher.state !== "idle" || !syncFetcher.data) return;

    const data = syncFetcher.data as ActionResponse & { syncedCount?: number };

    if (data.success) {
      const syncedCount = data.syncedCount ?? 0;
      const message =
        syncedCount === 0
          ? "✓ Companies up to date"
          : `✓ ${syncedCount} company(ies) synced successfully`;
      shopify.toast.show?.(message);
      revalidator.revalidate();
    } else if (data.errors?.length) {
      shopify.toast.show?.(data.errors[0], { isError: true });
    }
  }, [syncFetcher.data, syncFetcher.state, shopify, revalidator]);

  if (storeMissing) {
    return (
      <div style={pageShellStyle}>
      <div style={pageHeroStyle}>
        <div style={pageEyebrowStyle}>B2B Directory</div>
        <h1 style={pageHeroTitleStyle}>Companies</h1>
          <p style={pageHeroTextStyle}>
            Manage company accounts, registrations, and credit visibility from one place.
          </p>
        </div>
        <div
          style={{
            ...contentPanelStyle,
            background: "#ffffff",
            border: "1px solid #dfe3e8",
            borderRadius: 16,
            boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
            padding: "16px",
          }}
        >
          <s-banner tone="critical">
            <s-heading>Store not found</s-heading>
            <s-paragraph>
              The current shop does not exist in the database. Please reinstall
              the app.
            </s-paragraph>
          </s-banner>
        </div>
      </div>
    );
  }

  return (
    <div style={pageShellStyle}>
      <div style={pageHeroStyle}>
        <h3 style={pageHeroTitleStyle}>Companies</h3>
        <p style={pageHeroTextStyle}>
          Manage company profiles, contacts, credit limits, and your B2B customer accounts in one place.
        </p>
      </div>
      <div style={contentPanelStyle}>
          {isFreePlan &&
          (freePlanCompanyLimitReached || freePlanRegistrationLimitReached) ? (
            <div
              style={{
                marginBottom: 16,
                padding: 14,
                borderRadius: 14,
                border: "1px solid #f1c40f",
                background: "linear-gradient(180deg, #fffdf2 0%, #fff7db 100%)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <div>
                  <div style={{ fontSize: 15, fontWeight: 650, color: "#202223" }}>
                    Free plan limit reached
                  </div>
                  <div style={{ fontSize: 13, color: "#5c5f62", marginTop: 4 }}>
                    Companies: {freePlanCompanyCount}/{freePlanCompanyLimit} · Registrations: {freePlanRegistrationCount}/{freePlanRegistrationLimit}
                  </div>
                </div>
                <Link
                  to="/app/select-plan?returnTo=%2Fapp%2Fcompanies"
                  style={{ textDecoration: "none" }}
                >
                  <button
                    type="button"
                    style={{
                      padding: "10px 16px",
                      borderRadius: 10,
                      border: "none",
                      background: "#202223",
                      color: "white",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Upgrade Plan
                  </button>
                </Link>
              </div>
            </div>
          ) : null}
          <div style={tabsRowStyle}>
            {[
              { key: "companies", label: "Company List", count: null },
              { key: "pending", label: "Pending", count: displayedPendingCount },
              { key: "rejected", label: "Rejected", count: displayedRejectedCount },
            ].map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => handleTabChange(tab.key as RegistrationStatusTab)}
                style={{
                  appearance: "none",
                  background: "transparent",
                  borderLeft: "none",
                  borderRight: "none",
                  borderTop: "none",
                  cursor: "pointer",
                  padding: "10px 18px",
                  borderBottom:
                    selectedTab === tab.key
                      ? "2px solid #2c6ecb"
                      : "2px solid transparent",
                  color: selectedTab === tab.key ? "#2c6ecb" : "#5c5f62",
                  fontWeight: selectedTab === tab.key ? 600 : 400,
                  marginBottom: -1,
                  fontSize: 14,
                }}
              >
                {tab.label}
                {typeof tab.count === "number" ? ` (${tab.count})` : ""}
              </button>
            ))}
          </div>

          {selectedTab === "companies" ? (
            <div style={toolbarStyle}>
              <div style={{
                position: "relative",
                flex: "1 1 420px",
                minWidth: 260,
                display: "flex",
                alignItems: "center"
              }}>
                <input
                  type="text"
                  placeholder="Search by company name, email."
                  value={query}
                  onChange={(e) => {
                    const value = e.target.value;
                    setQuery(value);
                    setSearchParams((prev) => {
                      const newParams = new URLSearchParams(prev);
                      newParams.set("page", "1");
                      if (value) {
                        newParams.set("search", value);
                      } else {
                        newParams.delete("search");
                      }
                      return newParams;
                    });
                  }}
                  style={{
                    width: "100%",
                    minHeight: 40,
                    padding: "8px 36px 8px 12px",
                    borderRadius: 10,
                    border: "1px solid #c9ccd0",
                    fontSize: 14,
                    outline: "none",
                  }}
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("");
                      setSearchParams((prev) => {
                        const newParams = new URLSearchParams(prev);
                        newParams.set("page", "1");
                        newParams.delete("search");
                        return newParams;
                      });
                    }}
                    style={{
                      position: "absolute",
                      right: 8,
                      top: "50%",
                      transform: "translateY(-50%)",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      padding: "4px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: "50%",
                      width: 24,
                      height: 24,
                      fontSize: 16,
                      color: "#5c5f62",
                      lineHeight: 1,
                    }}
                    title="Clear search"
                  >
                    ✕
                  </button>
                )}
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginLeft: "auto" }}>
                <s-button
                  type="button"
                  variant="secondary"
                  onClick={exportCompaniesCsv}
                  style={{ minWidth: actionButtonWidth, display: "inline-block" }}
                >
                  Export CSV
                </s-button>

                <syncFetcher.Form method="post">
                  <input name="intent" value="syncCompanies" hidden readOnly />
                  <s-button
                    type="submit"
                    variant="secondary"
                    loading={isSyncing}
                    style={{ width: actionButtonWidth, display: "inline-block" }}
                  >
                    Company Sync
                  </s-button>
                </syncFetcher.Form>
              </div>
            </div>
          ) : null}

          {selectedTab === "companies" ? (
            companies.length === 0 ? (
              <>
                {searchQuery ? (
                  <div style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "40px 20px",
                    minHeight: "200px",
                    textAlign: "center",
                    border: "1px solid #e3e7ec",
                    borderRadius: 12,
                    background: "#ffffff"
                  }}>
                    <div style={{ fontSize: "16px", fontWeight: 600, color: "#202223", marginBottom: "8px" }}>
                      No result found
                    </div>
                    <div style={{ fontSize: "14px", color: "#5c5f62" }}>
                      No companies matching "{searchQuery}" were found. Try adjusting your search terms.
                    </div>
                  </div>
                ) : (
                  <div style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "40px 20px",
                    minHeight: "200px",
                    textAlign: "center",
                    border: "1px solid #e3e7ec",
                    borderRadius: 12,
                    background: "#ffffff"
                  }}>
                    <div style={{ fontSize: "16px", fontWeight: 600, color: "#202223" }}>
                      No companies yet
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div style={tableCardStyle}>
                {isSearching && (
                  <div
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      right: 0,
                      bottom: 0,
                      backgroundColor: "rgba(255, 255, 255, 0.7)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      zIndex: 10,
                      borderRadius: 8,
                    }}
                  >
                    <div style={{ textAlign: "center" }}>
                      <div
                        style={{
                          display: "inline-block",
                          width: 24,
                          height: 24,
                          border: "3px solid #e0e0e0",
                          borderTop: "3px solid #1a1b1d",
                          borderRadius: "50%",
                          animation: "spin 0.8s linear infinite",
                        }}
                      />
                      <p style={{ marginTop: 8, color: "#5c5f62", fontSize: 13 }}>
                        Searching…
                      </p>
                    </div>
                    <style>{`
                  @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                  }
                `}</style>
                  </div>
                )}
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    minWidth: isFreePlan ? 760 : 1180,
                    fontSize: 13,
                    opacity: isSearching ? 0.5 : 1,
                    pointerEvents: isSearching ? "none" : "auto",
                  }}
                >
                  <thead>
                    <tr>
                      <th style={{ ...tableHeaderCellStyle, minWidth: 220 }}>
                        <button
                          type="button"
                          onClick={() => toggleSort("name")}
                          style={sortableHeaderButtonStyle}
                        >
                          <span>Company</span>
                          {renderSortArrow("name")}
                        </button>
                      </th>
                      <th style={{ ...tableHeaderCellStyle, minWidth: 240 }}>
                        <button
                          type="button"
                          onClick={() => toggleSort("contact")}
                          style={sortableHeaderButtonStyle}
                        >
                          <span>Contact</span>
                          {renderSortArrow("contact")}
                        </button>
                      </th>
                      <th style={{ ...tableHeaderCellStyle, minWidth: 90 }}>
                        <button
                          type="button"
                          onClick={() => toggleSort("users")}
                          style={sortableHeaderButtonStyle}
                        >
                          <span>Users</span>
                          {renderSortArrow("users")}
                        </button>
                      </th>
                      {!isFreePlan && (
                        <th style={{ ...tableHeaderCellStyle, minWidth: 140 }}>
                          Payment Terms
                        </th>
                      )}
                      {!isFreePlan && (
                        <>
                          <th style={{ ...tableHeaderCellStyle, minWidth: 120 }}>
                            Credit Limit
                          </th>
                          <th style={{ ...tableHeaderCellStyle, minWidth: 120 }}>
                            Used Credit
                          </th>
                          <th style={{ ...tableHeaderCellStyle, minWidth: 140 }}>
                            Available Credit
                          </th>
                          <th style={{ ...tableHeaderCellStyle, minWidth: 90 }}>
                            Usage %
                          </th>
                        </>
                      )}
                      <th style={{ ...tableHeaderCellStyle, minWidth: 130 }}>
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {companies.map((company: LoaderCompany) => (
                      (() => {
                        const companyPath = `/app/companies/${company.id}`;
                        const isNavigatingToCompany =
                          navigation.location?.pathname === companyPath;
                        const isCompanyLoading =
                          pendingCompanyId === company.id || isNavigatingToCompany;

                        return (
                          <tr
                            key={company.id}
                            style={{
                              borderTop: "1px solid #e3e3e3",
                              backgroundColor: company.isDisable
                                ? "#ffebee"
                                : "transparent",
                            }}
                          >
                            <td
                              style={{
                                ...tableCellStyle,
                                overflowWrap: "anywhere",
                              }}
                            >
                              {company.name}
                              <br />
                              {company.shopifyCompanyId
                                ? company.shopifyCompanyId.replace(
                                  "gid://shopify/Company/",
                                  "",
                                )
                                : "–"}
                            </td>

                            <td
                              style={{
                                ...tableCellStyle,
                                overflowWrap: "anywhere",
                              }}
                            >
                              {company.contactName || company.contactEmail ? (
                                <span>
                                  {company.contactName ? (
                                    <>
                                      {company.contactName}
                                      <br />
                                      {company.contactEmail
                                        ? company.contactEmail
                                        : "-"}
                                    </>
                                  ) : (
                                    <>{company.contactEmail}</>
                                  )}
                                </span>
                              ) : (
                                <span style={{ color: "#5c5f62" }}>Not set</span>
                              )}
                            </td>
                            <td style={tableCellStyle}>
                              {company.userCount}
                            </td>
                            {!isFreePlan && (
                              <td style={tableCellStyle}>
                                {company.paymentTerm || "No payment terms"}
                              </td>
                            )}
                            {!isFreePlan && (
                              <>
                                <td style={tableCellStyle}>
                                  {formatCredit(company.creditLimit, currencyCode)}
                                </td>
                                <td
                                  style={{
                                    ...tableCellStyle,
                                    color: "#d72c0d",
                                    fontWeight: 500,
                                  }}
                                >
                                  {formatCredit(company.usedCredit, currencyCode)}
                                </td>
                                <td
                                  style={{
                                    ...tableCellStyle,
                                    color:
                                      parseFloat(company.availableCredit) >= 0
                                        ? "#008060"
                                        : "#d72c0d",
                                    fontWeight:
                                      parseFloat(company.availableCredit) < 0
                                        ? 600
                                        : 500,
                                  }}
                                >
                                  {formatCredit(company.availableCredit, currencyCode)}
                                </td>
                                <td
                                  style={{
                                    ...tableCellStyle,
                                    color:
                                      company.creditUsagePercentage >= 90
                                        ? "#d72c0d"
                                        : company.creditUsagePercentage >= 70
                                        ? "#b98900"
                                        : "#008060",
                                    fontWeight: 500,
                                  }}
                                >
                                  {company.creditUsagePercentage}%
                                </td>
                              </>
                            )}
                            <td
                              style={{
                                ...tableCellStyle,
                                verticalAlign: "middle",
                              }}
                            >
                              <div
                                style={{
                                  width: actionButtonWidth,
                                  maxWidth: "100%",
                                }}
                              >
                                <s-button
                                  type="button"
                                  variant="secondary"
                                  loading={isCompanyLoading}
                                  disabled={isCompanyLoading || isUpdating}
                                  onClick={() => {
                                    setPendingCompanyId(company.id);
                                    navigate(companyPath);
                                  }}
                                  style={{ width: "100%", display: "block" }}
                                >
                                  View
                                </s-button>
                              </div>
                            </td>
                          </tr>
                        );
                      })()
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : isLoadingRegistrationTab ? (
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                minHeight: 220,
                border: "1px solid #e3e7ec",
                borderRadius: 12,
                background: "#ffffff",
              }}
            >
              <div style={{ textAlign: "center" }}>
                <div
                  style={{
                    display: "inline-block",
                    width: 24,
                    height: 24,
                    border: "3px solid #e0e0e0",
                    borderTop: "3px solid #1a1b1d",
                    borderRadius: "50%",
                    animation: "spin 0.8s linear infinite",
                  }}
                />
                <p style={{ marginTop: 8, color: "#5c5f62", fontSize: 13 }}>
                  Loading registrations...
                </p>
              </div>
            </div>
          ) : registrationData ? (
            <RegistrationApprovalsPanel
              submissions={registrationData.submissions}
              storeMissing={registrationData.storeMissing}
              formConfig={registrationData.formConfig}
              shippingCountryOptions={registrationData.shippingCountryOptions}
              shippingProvincesByCountry={registrationData.shippingProvincesByCountry}
              paymentTermsTemplates={registrationData.paymentTermsTemplates}
              isFreePlan={isFreePlan}
              allCatalogs={registrationData.allCatalogs}
              priceLists={registrationData.priceLists}
              forcedStatusFilter={selectedTab.toUpperCase() as "PENDING" | "APPROVED" | "REJECTED"}
              hideStatusTabs
              embedded
              heading="Registrations"
            />
          ) : (
            <s-empty-state heading="No registration data available" />
          )}

          {/* Pagination */}
          {selectedTab === "companies" && totalPages > 1 && (
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
                marginTop: 24,
                paddingTop: 24,
                borderTop: "1px solid #e3e3e3",
              }}
            >
              <Link
                to={buildCompaniesQueryString({ page: String(currentPage - 1) })}
                style={{
                  padding: "8px 16px",
                  borderRadius: 8,
                  border: "1px solid #c9ccd0",
                  textDecoration: "none",
                  color: currentPage === 1 ? "#999" : "#202223",
                  pointerEvents: currentPage === 1 ? "none" : "auto",
                  opacity: currentPage === 1 ? 0.5 : 1,
                }}
              >
                Previous
              </Link>

              <div style={{ display: "flex", gap: 8 }}>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map(
                  (pageNum) => {
                    const showPage =
                      pageNum === 1 ||
                      pageNum === totalPages ||
                      Math.abs(pageNum - currentPage) <= 1;

                    const showEllipsis =
                      (pageNum === 2 && currentPage > 3) ||
                      (pageNum === totalPages - 1 &&
                        currentPage < totalPages - 2);

                    if (showEllipsis) {
                      return (
                        <span
                          key={pageNum}
                          style={{
                            padding: "8px 12px",
                            color: "#999",
                          }}
                        >
                          ...
                        </span>
                      );
                    }

                    if (!showPage) return null;

                    return (
                      <Link
                        key={pageNum}
                        to={buildCompaniesQueryString({ page: String(pageNum) })}
                        style={{
                          padding: "8px 12px",
                          borderRadius: 8,
                          border: "1px solid #c9ccd0",
                          textDecoration: "none",
                          color: pageNum === currentPage ? "white" : "#202223",
                          background:
                            pageNum === currentPage ? "#005bd3" : "white",
                          fontWeight: pageNum === currentPage ? 600 : 400,
                        }}
                      >
                        {pageNum}
                      </Link>
                    );
                  },
                )}
              </div>

              <Link
                to={buildCompaniesQueryString({ page: String(currentPage + 1) })}
                style={{
                  padding: "8px 16px",
                  borderRadius: 8,
                  border: "1px solid #c9ccd0",
                  textDecoration: "none",
                  color: currentPage === totalPages ? "#999" : "#202223",
                  pointerEvents: currentPage === totalPages ? "none" : "auto",
                  opacity: currentPage === totalPages ? 0.5 : 1,
                }}
              >
                Next
              </Link>

              <span style={{ marginLeft: 16, color: "#5c5f62", fontSize: 14 }}>
                Page {currentPage} of {totalPages} ({totalCount} companies)
              </span>
            </div>
          )}
      </div>
    </div>
  );
}
