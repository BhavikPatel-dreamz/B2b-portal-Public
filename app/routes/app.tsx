import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import type { ShouldRevalidateFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";
import { authenticate } from "../shopify.server";
import { APP_BILLING_PLANS, getIsTestBilling } from "app/utils/billing.server";
import { FREE_PLAN, PAID_PLAN, PLAN_99, CUSTOM_PLAN } from "app/billing-plans.shared";
import {
  syncStoreSubscriptionState,
  getStorePlanValue,
  hasCustomPlanConfiguration,
} from "app/services/store.server";
import prisma from "app/db.server";
import { clearAdminCompaniesCache } from "./app.companies";
import { clearDashboardStatsCache } from "app/utils/dashboard-cache.server";

const SALES_ONLY_STORES = new Set([
  "staging-labor-law-center.myshopify.com",
]);

const SALES_ONLY_ALLOWED_PATHS = new Set([
  "/app/sales-users",
  "/app/sales-dashboard",
]);

const SALES_ONLY_EXEMPT_PATHS = new Set([
  "/app/select-plan",
  "/app/cancel-subscription",
  "/app/billing-example",
]);

const PLAN_EXEMPT_PATHS = new Set([
  "/app/select-plan",
  "/app/cancel-subscription",
  "/app/billing-example",
]);

function requiresPlan(pathname: string) {
  return pathname.startsWith("/app") && !PLAN_EXEMPT_PATHS.has(pathname);
}

// ── IN-MEMORY CACHE for app layout data ─────────────────────────
declare global {
  var __appLayoutCache:
    | Map<string, { data: { apiKey: string; showSalesLinks: boolean; salesOnlyStore: boolean }; timestamp: number }>
    | undefined;
}

const appLayoutCache: Map<string, { data: { apiKey: string; showSalesLinks: boolean; salesOnlyStore: boolean }; timestamp: number }> =
  globalThis.__appLayoutCache ?? (globalThis.__appLayoutCache = new Map());

const APP_LAYOUT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing, redirect, session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);

  // Sales-only store: redirect non-allowed pages immediately (before cache)
  if (SALES_ONLY_STORES.has(session.shop) && !SALES_ONLY_ALLOWED_PATHS.has(url.pathname) && !SALES_ONLY_EXEMPT_PATHS.has(url.pathname)) {
    return redirect("/app/sales-dashboard");
  }

  const cacheKey = `app-layout-${session.shop}`;
  const cached = appLayoutCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < APP_LAYOUT_CACHE_TTL) {
    console.log("⚡ App layout cache HIT", cacheKey);
    return Response.json(cached.data);
  }
  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
    select: { plan: true, planKey: true, customPlanKey: true, customPlanActive: true, customAmount: true },
  });
  const hasCustomPlan = hasCustomPlanConfiguration(
    store?.customPlanKey,
    store?.planKey,
    store?.customAmount,
    store?.customPlanActive,
  );

  const normalizePlanName = (planName?: string | null) => {
    if (planName === "approved payment") {
      return PAID_PLAN;
    }
    return planName || "free";
  };

  let showSalesLinks =
    [PLAN_99, CUSTOM_PLAN].includes(normalizePlanName(store?.plan)) ||
    hasCustomPlan;

  if (requiresPlan(url.pathname)) {
    const billingState = await billing.check({
      plans: APP_BILLING_PLANS as any,
      isTest: getIsTestBilling(),
    });

    const activeSubscription = billingState.appSubscriptions?.find((s) => s.status === "ACTIVE");
    const currentPlan = getStorePlanValue(activeSubscription?.name);
    const currentPlanName = normalizePlanName(activeSubscription?.name ?? store?.plan ?? "free");
    const storedPlanName = normalizePlanName(store?.plan);

    if (billingState.hasActivePayment) {
      // Only sync if plan changed or wasn"t previously synced
      if (store?.plan !== currentPlan || store?.planKey !== activeSubscription?.id) {
        console.log("Plan changed or not synced. Syncing...");
        await syncStoreSubscriptionState(
          session.shop,
          billingState.appSubscriptions || [],
          admin,
        );
        clearAdminCompaniesCache(session.shop);
        clearDashboardStatsCache(session.shop);
      }
    } else if (store?.plan === "approved payment") {
      // If we thought they were on a paid plan but they don"t have active payment anymore
      await syncStoreSubscriptionState(
        session.shop,
        [],
        admin,
      );
      clearAdminCompaniesCache(session.shop);
      clearDashboardStatsCache(session.shop);
    }

    const hasCustomPlan = hasCustomPlanConfiguration(
      store?.customPlanKey,
      store?.planKey,
      store?.customAmount,
      store?.customPlanActive,
    );
    const planNameForLinks = activeSubscription?.name || (hasCustomPlan ? CUSTOM_PLAN : storedPlanName);
    const normalizedLinkPlanName = normalizePlanName(planNameForLinks);
    showSalesLinks =
      normalizedLinkPlanName === PLAN_99 ||
      normalizedLinkPlanName === CUSTOM_PLAN ||
      hasCustomPlan;
    const hasPlanAccess =
      billingState.hasActivePayment ||
      normalizedLinkPlanName === FREE_PLAN ||
      normalizedLinkPlanName === PAID_PLAN ||
      normalizedLinkPlanName === PLAN_99 ||
      normalizedLinkPlanName === CUSTOM_PLAN ||
      hasCustomPlan;

    if (!hasPlanAccess) {
      const returnTo = url.pathname + url.search;
      return redirect("/app/select-plan?returnTo=" + encodeURIComponent(returnTo));
    }
  }

  const isSalesOnlyStore = SALES_ONLY_STORES.has(session.shop);

  const result = { apiKey: process.env.SHOPIFY_API_KEY || "", showSalesLinks, salesOnlyStore: isSalesOnlyStore };

  // Store in cache
  appLayoutCache.set(cacheKey, { data: result, timestamp: Date.now() });

  return result;
};

export function clearAppLayoutCache(shopDomain: string) {
  const key = `app-layout-${shopDomain}`;
  appLayoutCache.delete(key);
  console.log("🧹 App layout cache cleared for:", key);
}


// ── SKIP REVALIDATION on client-side GET navigations ────────────
export function shouldRevalidate({
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (formMethod && formMethod !== "GET") {
    return defaultShouldRevalidate;
  }
  return false;
}

export default function App() {
  const { apiKey, showSalesLinks, salesOnlyStore } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <PolarisAppProvider i18n={enTranslations}>
        <s-app-nav>
          {!salesOnlyStore && <s-link href="/app/home">Home</s-link>}
          {!salesOnlyStore && <s-link href="/app/reports">Reports</s-link>}
          {!salesOnlyStore && <s-link href="/app/companies">B2B Companies</s-link>}
          {/* <s-link href="/app/companies?tab=pending">Registrations</s-link> */}
          {!salesOnlyStore && <s-link href="/app/registration-form">Registrations Form</s-link>}
          {!salesOnlyStore && <s-link href="/app/settings">Settings</s-link>}
          {!salesOnlyStore && <s-link href="/app/notifications">Email Template</s-link>}
          {(salesOnlyStore || showSalesLinks) && <s-link href="/app/sales-users">Sales Users</s-link>}
          {(salesOnlyStore || showSalesLinks) && <s-link href="/app/sales-dashboard">Sales Dashboard</s-link>}
          {!salesOnlyStore && <s-link href="/app/select-plan">Select Plan</s-link>}
          {!salesOnlyStore && <s-link href="/app/quotes">Quotes</s-link>}
        </s-app-nav>
        <Outlet />
      </PolarisAppProvider>
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
