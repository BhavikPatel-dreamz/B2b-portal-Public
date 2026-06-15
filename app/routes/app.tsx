import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";
import { authenticate } from "../shopify.server";
import { APP_BILLING_PLANS, getIsTestBilling } from "app/utils/billing.server";
import {
  syncStoreSubscriptionState,
  getStorePlanValue,
} from "app/services/store.server";
import prisma from "app/db.server";
import { clearAdminCompaniesCache } from "./app.companies";
import { clearDashboardStatsCache } from "app/utils/dashboard-cache.server";

const PLAN_EXEMPT_PATHS = new Set([
  "/app/select-plan",
  "/app/cancel-subscription",
  "/app/billing-example",
]);

function requiresPlan(pathname: string) {
  return pathname.startsWith("/app") && !PLAN_EXEMPT_PATHS.has(pathname);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing, redirect, session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);

  if (requiresPlan(url.pathname)) {
    const store = await prisma.store.findUnique({
      where: { shopDomain: session.shop },
      select: { plan: true, planKey: true },
    });

    const billingState = await billing.check({
      plans: APP_BILLING_PLANS,
      isTest: getIsTestBilling(),
    });

    const activeSubscription = billingState.appSubscriptions?.find((s) => s.status === "ACTIVE");
    const currentPlan = getStorePlanValue(activeSubscription?.name);

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

    const hasPlanAccess = billingState.hasActivePayment || store?.plan === "free";

    if (!hasPlanAccess) {
      const returnTo = url.pathname + url.search;
      return redirect("/app/select-plan?returnTo=" + encodeURIComponent(returnTo));
    }
  }

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <PolarisAppProvider i18n={enTranslations}>
        <s-app-nav>
          <s-link href="/app/home">Home</s-link>
          <s-link href="/app/reports">Reports</s-link>
          <s-link href="/app/companies">B2B Companies</s-link>
          {/* <s-link href="/app/companies?tab=pending">Registrations</s-link> */}
          <s-link href="/app/registration-form">Registrations Form</s-link>
          <s-link href="/app/settings">Settings</s-link>
          <s-link href="/app/notifications">Email Template</s-link>
          <s-link href="/app/select-plan">Select Plan</s-link>
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
