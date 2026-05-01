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
  useRevalidator,
  useNavigate,
} from "react-router";
import { useEffect, useState, useRef } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
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
        data: {
          id: string;
          contactEmail: string | null;
          submissionEmail: string | null;
          defaultCompanyCreditLimit: unknown;
          plan: string | null;
          currencyCode: string | null;
        };
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
    data: {
      id: string;
      contactEmail: string | null;
      submissionEmail: string | null;
      defaultCompanyCreditLimit: unknown;
      plan: string | null;
      currencyCode: string | null;
    };
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
  
  // Also clear store cache when companies cache is cleared
  storeCache.delete(shop);
  
  console.log("🧹 Admin companies and store cache cleared for:", shop);
};

export const clearAdminCompaniesStoreCache = (shop: string) => {
  storeCache.delete(shop);
  console.log("🧹 Admin companies store cache cleared for:", shop);
};

async function getStoreForShop(shop: string) {
  const cachedStore = storeCache.get(shop);
  if (cachedStore && Date.now() - cachedStore.timestamp < STORE_CACHE_TTL) {
    return cachedStore.data;
  }

  const store = await prisma.store.findUnique({
    where: { shopDomain: shop },
    select: {
      id: true,
      contactEmail: true,
      submissionEmail: true,
      defaultCompanyCreditLimit: true,
      plan: true,
      currencyCode: true,
    },
  });

  if (store) {
    storeCache.set(shop, { data: store, timestamp: Date.now() });
  }

  return store;
}

// 📦 LOADER — GET request

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const startTime = Date.now();

  try {
    const url = new URL(request.url);
    const activeTab = normalizeTab(url.searchParams.get("tab"));
    const page = parseInt(url.searchParams.get("page") || "1", 10);
    const searchQuery = url.searchParams.get("search") || "";
    const sortOrder = normalizeSort(url.searchParams.get("sort"));
    const limit = 10;
    const skip = (page - 1) * limit;
    const shopFromUrl = url.searchParams.get("shop") || "";

    if (shopFromUrl) {
      const cacheKey = `admin-companies-${shopFromUrl}-${activeTab}-${page}-${searchQuery}-${sortOrder}`;
      const cached = cache.get(cacheKey);

      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        console.log(`⚡ Cache HIT (skipped all DB calls) → ${cacheKey}`);
        console.log(`🚀 API Time: ${Date.now() - startTime}ms`);
        return Response.json(cached.data);
      }
    }

    // ── SLOW PATH — run auth + all DB queries 
    console.log("🐢 Cache MISS → running auth + DB");

    const { admin, session } = await authenticate.admin(request);
    const shop = session.shop; // authoritative shop from session

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
          isFreePlan: false,
        },
        { status: 404 },
      );
    }

    const isFreePlan = store.plan === "free";

    // Build where clause with search
    const whereClause = {
      shopId: store.id,
      ...(searchQuery && {
        OR: [
          { name: { contains: searchQuery, mode: "insensitive" as const } },
          { shopifyCompanyId: { contains: searchQuery, mode: "insensitive" as const } },
          { contactName: { contains: searchQuery, mode: "insensitive" as const } },
          { contactEmail: { contains: searchQuery, mode: "insensitive" as const } },
        ],
      }),
    };

    const paymentTermsTemplatesPromise =
      activeTab === "companies" && !isFreePlan
        ? admin
            .graphql(
              `#graphql
              query {
                paymentTermsTemplates {
                  id
                  name
                  paymentTermsType
                  dueInDays
                }
              }`,
            )
            .then((response) => response.json())
            .then(
              (payload) =>
                payload?.data?.paymentTermsTemplates ||
                [],
            )
        : Promise.resolve(
            [] as Array<{
              id: string;
              name: string;
              paymentTermsType: string;
              dueInDays: number | null;
            }>,
          );

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
          isFreePlan,
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
            isFreePlan: boolean;
          };
        })();

    const [
      totalCount,
      companies,
      pendingCount,
      approvedCount,
      rejectedCount,
      registrationData,
      paymentTermsTemplates,
    ] = await Promise.all([
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
      paymentTermsTemplatesPromise,
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
    const paymentTermsNameMap = new Map(
      paymentTermsTemplates.map((template) => [template.id, template.name]),
    );

    const companiesWithCredit = companies.map((company) => {
      const creditLimitNum = Number(company.creditLimit ?? 0);
      const usedCreditNum = creditMap.get(company.id) ?? 0;
      const availableCreditNum = creditLimitNum - usedCreditNum;
      const creditUsagePercentage =
        creditLimitNum > 0
          ? Math.round((usedCreditNum / creditLimitNum) * 100)
          : 0;

      return {
        ...company,
        contactName: company.contactName || "-",
        paymentTerm: isFreePlan
          ? null
          : company.paymentTerm
            ? paymentTermsNameMap.get(company.paymentTerm) || company.paymentTerm
            : null,
        creditLimit: isFreePlan ? "0" : company.creditLimit.toString(),
        usedCredit: isFreePlan ? "0" : usedCreditNum.toString(),
        pendingCredit: "0",
        availableCredit: isFreePlan ? "0" : availableCreditNum.toString(),
        creditUsagePercentage: isFreePlan ? 0 : creditUsagePercentage,
        updatedAt: company.updatedAt.toISOString(),
        userCount: company._count.users,
        isDisable: company.isDisable || false,
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
      paymentTermsTemplates:
        activeTab === "companies"
          ? paymentTermsTemplates
          : registrationData.paymentTermsTemplates,
      allCatalogs: registrationData.allCatalogs,
      priceLists: registrationData.priceLists,
      storeMissing: false,
      currencyCode: store.currencyCode || "USD",
      totalCount: totalItems,
      currentPage: page,
      totalPages,
      searchQuery,
      sortOrder,
      isFreePlan,
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
        storeMissing: true,
        currencyCode: "USD",
        totalCount: 0,
        currentPage: 1,
        totalPages: 0,
        searchQuery: "",
        sortOrder: "newest",
        isFreePlan: false,
        },
        { status: 500 },
        );
        }
        };

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

  const isFreePlan = store.plan === "free";

  switch (intent) {
    // ── SYNC COMPANIES ──────────────────────────────────────
    case "syncCompanies": {
      const result = await syncShopifyCompanies(
        admin,
        store,
        store.contactEmail || store.submissionEmail,
      );

      if (result.success) clearAdminCompaniesCache(shop);

      return Response.json({
        intent,
        success: result.success,
        message: result.message,
        syncedCount: result.syncedCount,
        errors: result.errors,
      });
    }

    // ── UPDATE CREDIT
    case "updateCredit": {
      if (isFreePlan) {
        return Response.json({
          intent,
          success: false,
          errors: ["Credit limit is not available on the free plan"],
        });
      }

      const formData = new FormData();
      formData.append("id", (form.id as string) || "");
      formData.append("creditLimit", (form.creditLimit as string) || "0");

      const result = await updateCredit(formData, admin);

      // Credit change affects company list display — bust cache
      clearAdminCompaniesCache(shop);

      return Response.json(result);
    }

    // ── CREATE COMPANY
    case "createCompany": {
      const name = (form.name as string)?.trim();
      const shopifyCompanyId = (form.shopifyCompanyId as string)?.trim() || null;
      const contactName = (form.contactName as string)?.trim() || null;
      const contactEmail = (form.contactEmail as string)?.trim() || null;
      const creditRaw = (form.creditLimit as string | undefined)?.trim() || "";
      let credit = isFreePlan
        ? parseCredit("0")
        : creditRaw
          ? parseCredit(creditRaw)
          : null;

      if (!name) {
        return Response.json({
          intent, success: false, errors: ["Company name is required"],
        });
      }

      if (!isFreePlan && !creditRaw) {
        credit = store.defaultCompanyCreditLimit ?? parseCredit("0");
      }

      if (credit === null) {
        return Response.json({
          intent, success: false, errors: ["Credit must be a number"],
        });
      }

      if (shopifyCompanyId) {
        await prisma.companyAccount.upsert({
          where: {
            shopId_shopifyCompanyId: { shopId: store.id, shopifyCompanyId },
          },
          update: { name, contactName, contactEmail, creditLimit: credit },
          create: { shopId: store.id, shopifyCompanyId, name, contactName, contactEmail, creditLimit: credit },
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

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

export { default } from "./app.companies.page";
