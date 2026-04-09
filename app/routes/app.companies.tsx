import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  HeadersFunction,
} from "react-router";
import {
  useFetcher,
  useLoaderData,
  Link,
  useSearchParams,
  useNavigation,
} from "react-router";
import { useEffect, useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  RegistrationApprovalsPanel,
  type RegistrationSubmission,
} from "./app.registrations";
import {
  syncShopifyCompanies,
  parseForm,
  parseCredit,
} from "../utils/company.server";
import { updateCredit } from "../services/company.server";
import { formatCredit } from "../utils/company.utils";
import type { FormConfig } from "../utils/form-config.shared";
import type { CountryOption } from "app/components/registrations/EditDetailsModal";

type LoaderCompany = {
  id: string;
  name: string;
  shopifyCompanyId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  creditLimit: string;
  usedCredit: string;
  pendingCredit: string;
  availableCredit: string;
  creditUsagePercentage: number;
  updatedAt: string;
  userCount: number;
  isDisable: boolean;
};

type RegistrationStatusTab = "companies" | "pending"  | "rejected";

interface ActionResponse {
  intent: string;
  success: boolean;
  message?: string;
  errors?: string[];
}

type SortOrder = "newest" | "oldest";

function normalizeSort(value: string | null): SortOrder {
  return value === "oldest" ? "oldest" : "newest";
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


// ============================================================
// 🗂️  CACHE SETUP 
// ============================================================

declare global {
  var __adminCompaniesCache:
    | Map<string, { data: any; timestamp: number }>
    | undefined;
  var __adminCompaniesStoreCache:
    | Map<
        string,
        {
          data: { id: string; submissionEmail: string | null };
          timestamp: number;
        }
      >
    | undefined;
}

const cache: Map<string, { data: any; timestamp: number }> =
  globalThis.__adminCompaniesCache ??
  (globalThis.__adminCompaniesCache = new Map());

const storeCache: Map<
  string,
  {
    data: { id: string; submissionEmail: string | null };
    timestamp: number;
  }
> =
  globalThis.__adminCompaniesStoreCache ??
  (globalThis.__adminCompaniesStoreCache = new Map());

const CACHE_TTL = 3 * 60 * 1000; // 3 min
const STORE_CACHE_TTL = 10 * 60 * 1000; // 10 min

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

// ============================================================
// 🧹 CACHE HELPERS
// ============================================================

export const clearAdminCompaniesCache = (shop: string) => {
  const prefix = `admin-companies-${shop}`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
  console.log("🧹 Admin companies cache cleared for:", prefix);
};

async function getStoreForShop(shop: string) {
  const cachedStore = storeCache.get(shop);
  if (cachedStore && Date.now() - cachedStore.timestamp < STORE_CACHE_TTL) {
    return cachedStore.data;
  }

  const store = await prisma.store.findUnique({
    where: { shopDomain: shop },
    select: { id: true, submissionEmail: true },
  });

  if (store) {
    storeCache.set(shop, { data: store, timestamp: Date.now() });
  }

  return store;
}

// ============================================================
// 📦 LOADER — GET request
// ============================================================

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const startTime = Date.now();

  try {
    const url         = new URL(request.url);
    const activeTab   = normalizeTab(url.searchParams.get("tab"));
    const page        = parseInt(url.searchParams.get("page")   || "1", 10);
    const searchQuery = url.searchParams.get("search") || "";
    const sortOrder   = normalizeSort(url.searchParams.get("sort"));
    const limit       = 10;
    const skip        = (page - 1) * limit;

    // shop is FREE from URL — Shopify always appends it to admin routes
    const shopFromUrl = url.searchParams.get("shop") || "";

    // ── FAST PATH — check cache before auth + all DB calls ──
    // authenticate.admin() is a fast JWT check, but the 4 DB queries are slow
    if (shopFromUrl) {
      const cacheKey = `admin-companies-${shopFromUrl}-${activeTab}-${page}-${searchQuery}-${sortOrder}`;
      const cached   = cache.get(cacheKey);

      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        console.log(`⚡ Cache HIT (skipped all DB calls) → ${cacheKey}`);
        console.log(`🚀 API Time: ${Date.now() - startTime}ms`);
        return Response.json(cached.data);
      }
    }

    // ── SLOW PATH — run auth + all DB queries ───────────────
    console.log("🐢 Cache MISS → running auth + DB");

    const { session } = await authenticate.admin(request);
    const shop        = session.shop; // authoritative shop from session

    const cacheKey = `admin-companies-${shop}-${activeTab}-${page}-${searchQuery}-${sortOrder}`;

    const store = await getStoreForShop(shop);

    if (!store) {
      return Response.json(
        {
          companies: [] as LoaderCompany[],
          submissions: [] as RegistrationSubmission[],
          activeTab,
          pendingCount: 0,
          approvedCount: 0,
          rejectedCount: 0,
          formConfig: null as FormConfig | null,
          shippingCountryOptions: [] as CountryOption[],
          shippingProvincesByCountry: {} as Record<string, CountryOption[]>,
          paymentTermsTemplates: [] as Array<{
            id: string;
            name: string;
            paymentTermsType: string;
            dueInDays: number | null;
          }>,
          allCatalogs: [] as any[],
          priceLists: [] as any[],
          storeMissing: true,
          totalCount: 0,
          currentPage: 1,
          totalPages: 0,
          searchQuery: "",
        },
        { status: 404 },
      );
    }

    // Build where clause with search
    const whereClause = {
      shopId: store.id,
      ...(searchQuery && {
        OR: [
          { name:             { contains: searchQuery, mode: "insensitive" as const } },
          { shopifyCompanyId: { contains: searchQuery, mode: "insensitive" as const } },
          { contactName:      { contains: searchQuery, mode: "insensitive" as const } },
          { contactEmail:     { contains: searchQuery, mode: "insensitive" as const } },
        ],
      }),
    };

    const registrationDataPromise =
      activeTab === "companies"
        ? Promise.resolve({
            submissions: [] as RegistrationSubmission[],
            formConfig: null as FormConfig | null,
            shippingCountryOptions: [] as CountryOption[],
            shippingProvincesByCountry: {} as Record<string, CountryOption[]>,
            paymentTermsTemplates: [] as Array<{
              id: string;
              name: string;
              paymentTermsType: string;
              dueInDays: number | null;
            }>,
            allCatalogs: [] as any[],
            priceLists: [] as any[],
          })
        : (async () => {
            const { loader: registrationsLoader } = await import("./app.registrations");
            const registrationUrl = new URL(request.url);
            registrationUrl.pathname = "/app/registrations";
            registrationUrl.searchParams.set("status", activeTab.toUpperCase());

            const registrationResponse = await registrationsLoader({
              request: new Request(registrationUrl.toString(), request),
              params: {},
              context: undefined as never,
            });

            return (await registrationResponse.json()) as {
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
            };
          })();

    const [totalCount, companies, pendingCount, approvedCount, rejectedCount, registrationData] = await Promise.all([
      prisma.companyAccount.count({ where: whereClause }),
      prisma.companyAccount.findMany({
        where: whereClause,
        orderBy: { updatedAt: sortOrder === "oldest" ? "asc" : "desc" },
        skip,
        take: limit,
        include: { _count: { select: { users: true } } },
      }),
      prisma.registrationSubmission.count({
        where: { shopId: store.id, status: "PENDING", shopifyCustomerId: { not: null } },
      }),
      prisma.registrationSubmission.count({
        where: { shopId: store.id, status: "APPROVED", shopifyCustomerId: { not: null } },
      }),
      prisma.registrationSubmission.count({
        where: { shopId: store.id, status: "REJECTED", shopifyCustomerId: { not: null } },
      }),
      registrationDataPromise,
    ]);
    const totalItems =
      activeTab === "companies"
        ? totalCount
        : activeTab === "pending"
          ? pendingCount
            : rejectedCount;
    const totalPages = Math.ceil(totalItems / limit);

    const orderCreditByCompany =
      companies.length === 0
        ? []
        : await prisma.b2BOrder.groupBy({
            by: ["companyId"],
            where: {
              companyId: { in: companies.map((c) => c.id) },
              paymentStatus: { in: ["pending", "partial"] },
              orderStatus: { notIn: ["cancelled"] },
            },
            _sum: { creditUsed: true },
          });

    const creditMap = new Map(
      orderCreditByCompany.map((entry) => [
        entry.companyId,
        Number(entry._sum.creditUsed ?? 0),
      ]),
    );

    const companiesWithCredit = companies.map((company) => {
      const creditLimitNum      = Number(company.creditLimit ?? 0);
      const usedCreditNum       = creditMap.get(company.id) ?? 0;
      const availableCreditNum  = creditLimitNum - usedCreditNum;
      const creditUsagePercentage =
        creditLimitNum > 0
          ? Math.round((usedCreditNum / creditLimitNum) * 100)
          : 0;

      return {
        ...company,
        contactName:          company.contactName || "-",
        creditLimit:          company.creditLimit.toString(),
        usedCredit:           usedCreditNum.toString(),
        pendingCredit:        "0",
        availableCredit:      availableCreditNum.toString(),
        creditUsagePercentage,
        updatedAt:            company.updatedAt.toISOString(),
        userCount:            company._count.users,
        isDisable:            company.isDisable || false,
      } satisfies LoaderCompany;
    });

    const result = {
      companies: companiesWithCredit,
      submissions: registrationData.submissions,
      activeTab,
      pendingCount,
      approvedCount,
      rejectedCount,
      formConfig: registrationData.formConfig,
      shippingCountryOptions: registrationData.shippingCountryOptions,
      shippingProvincesByCountry: registrationData.shippingProvincesByCountry,
      paymentTermsTemplates: registrationData.paymentTermsTemplates,
      allCatalogs: registrationData.allCatalogs,
      priceLists: registrationData.priceLists,
      storeMissing: false,
      totalCount: totalItems,
      currentPage: page,
      totalPages,
      searchQuery,
      sortOrder,
    };

    // ✅ Store in cache
    cache.set(cacheKey, { data: result, timestamp: Date.now() });
    console.log(`✅ Cache SET → ${cacheKey}`);
    console.log(`🚀 API Time: ${Date.now() - startTime}ms`);

    return Response.json(result);
  } catch (error) {
    console.error("❌ Admin companies loader error:", error);
    return Response.json(
      {
        companies: [],
        submissions: [],
        activeTab: "companies" as const,
        pendingCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
        formConfig: null,
        shippingCountryOptions: [],
        shippingProvincesByCountry: {},
        paymentTermsTemplates: [],
        allCatalogs: [],
        priceLists: [],
        storeMissing: false,
        totalCount: 0,
        currentPage: 1,
        totalPages: 0,
        searchQuery: "",
        sortOrder: "newest" as const,
      },
      { status: 500 },
    );
  }
};

// ============================================================
// ✏️  ACTION — POST requests
// Auth always runs on mutations — never skip for security.
// Cache is busted after every successful mutation.
// ============================================================

export const action = async ({ request }: ActionFunctionArgs) => {
  const form = await parseForm(request.clone());
  const intent = (form.intent as string) || "";

  if (
    [
      "checkCustomer",
      "approveRegistration",
      "reject",
      "updatecustomerCompanyDetails",
      "assignCatalog",
      "removeCatalog",
    ].includes(intent)
  ) {
    const { action: registrationsAction } = await import("./app.registrations");
    return registrationsAction({ request, params: {}, context: undefined as never });
  }

  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const store = await getStoreForShop(shop);

  if (!store) {
    return Response.json(
      { intent: "unknown", success: false, errors: ["Store not found"] },
      { status: 404 },
    );
  }

  switch (intent) {
    // ── SYNC COMPANIES ──────────────────────────────────────
    case "syncCompanies": {
      const result = await syncShopifyCompanies(admin, store, store.submissionEmail);

      // Sync changes data — bust all pages
      if (result.success) clearAdminCompaniesCache(shop);

      return Response.json({
        intent,
        success:     result.success,
        message:     result.message,
        syncedCount: result.syncedCount,
        errors:      result.errors,
      });
    }

    // ── UPDATE CREDIT ───────────────────────────────────────
    case "updateCredit": {
      const formData = new FormData();
      formData.append("id",          (form.id as string)          || "");
      formData.append("creditLimit", (form.creditLimit as string) || "0");

      const result = await updateCredit(formData, admin);

      // Credit change affects company list display — bust cache
      clearAdminCompaniesCache(shop);

      return Response.json(result);
    }

    // ── CREATE COMPANY ──────────────────────────────────────
    case "createCompany": {
      const name            = (form.name as string)?.trim();
      const shopifyCompanyId = (form.shopifyCompanyId as string)?.trim() || null;
      const contactName     = (form.contactName as string)?.trim()  || null;
      const contactEmail    = (form.contactEmail as string)?.trim() || null;
      const credit          = parseCredit((form.creditLimit as string) || undefined);

      if (!name) {
        return Response.json({
          intent, success: false, errors: ["Company name is required"],
        });
      }
      if (!credit) {
        return Response.json({
          intent, success: false, errors: ["Credit must be a number"],
        });
      }

      if (shopifyCompanyId) {
        await prisma.companyAccount.upsert({
          where: {
            shopId_shopifyCompanyId: { shopId: store.id, shopifyCompanyId },
          },
          update:  { name, contactName, contactEmail, creditLimit: credit },
          create:  { shopId: store.id, shopifyCompanyId, name, contactName, contactEmail, creditLimit: credit },
        });
      } else {
        await prisma.companyAccount.create({
          data: {
            shopId: store.id,
            shopifyCompanyId: null,
            name,
            contactName,
            contactEmail,
            creditLimit: credit,
          },
        });
      }

      // New company added — bust cache so it shows up immediately
      clearAdminCompaniesCache(shop);

      return Response.json({ intent, success: true, message: "Company saved" });
    }

    default:
      return Response.json({ intent, success: false, errors: ["Unknown intent"] });
  }
};
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
    totalCount,
    currentPage,
    totalPages,
    searchQuery,
    sortOrder,
  } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  // Controlled search input
  const [query, setQuery] = useState(searchQuery);
  const [pendingCompanyId, setPendingCompanyId] = useState<string | null>(null);

  const exportCompaniesCsv = () => {
    downloadCsv("companies.csv", [
      [
        "Company",
        "Shopify Company ID",
        "Contact Name",
        "Contact Email",
        "Users",
        "Credit Limit",
        "Used Credit",
        "Available Credit",
        "Usage %",
        "Updated At",
        "Status",
      ],
      ...companies.map((company) => [
        company.name,
        company.shopifyCompanyId?.replace("gid://shopify/Company/", "") || "",
        company.contactName || "",
        company.contactEmail || "",
        String(company.userCount),
        company.creditLimit,
        company.usedCredit,
        company.availableCredit,
        String(company.creditUsagePercentage),
        formatDisplayDate(company.updatedAt),
        company.isDisable ? "Inactive" : "Active",
      ]),
    ]);
  };

  const updateFetcher = useFetcher<ActionResponse>();
  const syncFetcher = useFetcher<ActionResponse>();

  const isUpdating = updateFetcher.state !== "idle";
  const isSyncing = syncFetcher.state !== "idle";

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

  if (storeMissing) {
    return (
      <s-page heading="Companies">
        <s-section>
          <s-banner tone="critical">
            <s-heading>Store not found</s-heading>
            <s-paragraph>
              The current shop does not exist in the database. Please reinstall
              the app.
            </s-paragraph>
          </s-banner>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Companies">
      <s-section>
        <div
          style={{
            display: "flex",
            gap: 8,
            marginBottom: 16,
            borderBottom: "1px solid #e3e3e3",
          }}
        >
          {[
            { key: "companies", label: "Company List", count: null },
            { key: "pending", label: "Pending", count: pendingCount },
            { key: "rejected", label: "Rejected", count: rejectedCount },
          ].map((tab) => (
            <Link
              key={tab.key}
              to={`?${new URLSearchParams({
                ...(tab.key !== "companies" ? { tab: tab.key } : {}),
                page: "1",
              })}`}
              style={{
                padding: "8px 16px",
                textDecoration: "none",
                borderBottom:
                  activeTab === tab.key
                    ? "2px solid #2c6ecb"
                    : "2px solid transparent",
                color: activeTab === tab.key ? "#2c6ecb" : "#5c5f62",
                fontWeight: activeTab === tab.key ? 600 : 400,
                marginBottom: -1,
              }}
            >
              {tab.label}
              {typeof tab.count === "number" ? ` (${tab.count})` : ""}
            </Link>
          ))}
        </div>

        {activeTab === "companies" ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
              marginBottom: 16,
              padding: 14,
              border: "1px solid #dde3ea",
              borderRadius: 14,
              background: "linear-gradient(180deg, #ffffff 0%, #f8fbff 100%)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
                flex: 1,
                minWidth: 320,
              }}
            >
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
                  flex: "1 1 280px",
                  minHeight: 36,
                  padding: "6px 12px",
                  borderRadius: 10,
                  border: "1px solid #c9ccd0",
                  fontSize: 13,
                  outline: "none",
                }}
              />

              <select
                value={sortOrder}
                onChange={(e) => {
                  setSearchParams((prev) => {
                    const newParams = new URLSearchParams(prev);
                    newParams.set("page", "1");
                    newParams.set("sort", e.target.value);
                    return newParams;
                  });
                }}
                style={{
                  minHeight: 36,
                  padding: "6px 12px",
                  borderRadius: 10,
                  border: "1px solid #c9ccd0",
                  fontSize: 13,
                  background: "#fff",
                }}
              >
                <option value="newest">Sort by newest</option>
                <option value="oldest">Sort by oldest</option>
              </select>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <s-button type="button" variant="secondary" onClick={exportCompaniesCsv}>
                Export CSV
              </s-button>

              <syncFetcher.Form method="post">
                <input name="intent" value="syncCompanies" hidden readOnly />
                <s-button type="submit" variant="secondary" loading={isSyncing}>
                  Company Sync
                </s-button>
              </syncFetcher.Form>
            </div>
          </div>
        ) : null}

        {activeTab === "companies" ? (
          companies.length === 0 ? (
            <s-empty-state
              heading={searchQuery ? "No companies found" : "No companies yet"}
            />
          ) : (
          <div style={{ position: "relative" }}>
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
                opacity: isSearching ? 0.5 : 1,
                pointerEvents: isSearching ? "none" : "auto",
              }}
            >
              <thead>
                <tr>
                  <th
                    style={{ textAlign: "left", padding: "8px", width: "15%" }}
                  >
                    Company
                  </th>
                  <th
                    style={{ textAlign: "left", padding: "8px", width: "15%" }}
                  >
                    Contact
                  </th>
                  <th
                    style={{ textAlign: "left", padding: "8px", width: "5%" }}
                  >
                    Users
                  </th>
                  <th
                    style={{ textAlign: "left", padding: "8px", width: "8%" }}
                  >
                    Credit Limit
                  </th>
                  <th
                    style={{ textAlign: "left", padding: "8px", width: "8%" }}
                  >
                    Used Credit
                  </th>
                  <th
                    style={{ textAlign: "left", padding: "8px", width: "8%" }}
                  >
                    Available Credit
                  </th>
                  <th
                    style={{ textAlign: "left", padding: "8px", width: "8%" }}
                  >
                    Usage %
                  </th>
                  <th
                    style={{ textAlign: "left", padding: "8px", width: "10%" }}
                  >
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
                        <td style={{ padding: "8px" }}>
                          {company.name}
                          <br />
                          {company.shopifyCompanyId
                            ? company.shopifyCompanyId.replace(
                                "gid://shopify/Company/",
                                "",
                              )
                            : "–"}
                        </td>

                        <td style={{ padding: "8px" }}>
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
                        <td style={{ padding: "8px" }}>{company.userCount}</td>
                        <td style={{ padding: "8px" }}>
                          {formatCredit(company.creditLimit)}
                        </td>
                        <td
                          style={{
                            padding: "8px",
                            color: "#d72c0d",
                            fontWeight: 500,
                          }}
                        >
                          {formatCredit(company.usedCredit)}
                        </td>
                        <td
                          style={{
                            padding: "8px",
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
                          {formatCredit(company.availableCredit)}
                        </td>
                        <td
                          style={{
                            padding: "8px",
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
                        <td
                          style={{
                            padding: "8px",
                            minWidth: 200,
                            display: "flex",
                            gap: 8,
                            alignItems: "center",
                          }}
                        >
                          <Link
                            to={companyPath}
                            discover="render"
                            prefetch="intent"
                            onClick={() => setPendingCompanyId(company.id)}
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              gap: 8,
                              minWidth: 92,
                              padding: "6px 12px",
                              borderRadius: 6,
                              border: "1px solid #c9ccd0",
                              textDecoration: "none",
                              color: "#202223",
                              fontSize: 13,
                              fontWeight: 500,
                              backgroundColor: "white",
                              cursor: isCompanyLoading ? "wait" : "pointer",
                              opacity:
                                isUpdating || isCompanyLoading ? 0.75 : 1,
                              pointerEvents: isCompanyLoading
                                ? "none"
                                : "auto",
                            }}
                          >
                            {isCompanyLoading && (
                              <span
                                aria-hidden="true"
                                style={{
                                  display: "inline-block",
                                  width: 12,
                                  height: 12,
                                  border: "2px solid #d9d9d9",
                                  borderTopColor: "#202223",
                                  borderRadius: "50%",
                                  animation: "spin 0.8s linear infinite",
                                }}
                              />
                            )}
                            {isCompanyLoading ? "Loading..." : "View"}
                          </Link>
                        </td>
                      </tr>
                    );
                  })()
                ))}
              </tbody>
            </table>
          </div>
          )
        ) : (
          <RegistrationApprovalsPanel
            submissions={submissions}
            storeMissing={storeMissing}
            formConfig={formConfig!}
            shippingCountryOptions={shippingCountryOptions}
            shippingProvincesByCountry={shippingProvincesByCountry}
            paymentTermsTemplates={paymentTermsTemplates}
            allCatalogs={allCatalogs}
            priceLists={priceLists}
            forcedStatusFilter={activeTab.toUpperCase() as "PENDING" | "APPROVED" | "REJECTED"}
            hideStatusTabs
            embedded
            heading="Registrations"
          />
        )}

        {/* Pagination */}
        {activeTab === "companies" && totalPages > 1 && (
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              gap: 12,
              marginTop: 24,
              paddingTop: 24,
              borderTop: "1px solid #e3e3e3",
            }}
          >
            <Link
              to={`?${new URLSearchParams({ ...(searchQuery && { search: searchQuery }), page: String(currentPage - 1) })}`}
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
                      to={`?${new URLSearchParams({ ...(searchQuery && { search: searchQuery }), page: String(pageNum) })}`}
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
              to={`?${new URLSearchParams({ ...(searchQuery && { search: searchQuery }), page: String(currentPage + 1) })}`}
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
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
