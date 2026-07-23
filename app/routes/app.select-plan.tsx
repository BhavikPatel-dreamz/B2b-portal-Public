import {
  ActionFunctionArgs,
  Form,
  redirect,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  useRevalidator,
  Link,
 LoaderFunctionArgs } from "react-router";
import { useEffect, useMemo } from "react";
import { FREE_PLAN, PAID_PLAN, PLAN_99, CUSTOM_PLAN } from "app/billing-plans.shared";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  setStoreFreePlan,
  syncStoreSubscriptionState,
  syncStoreSubscriptionStateFast,
  getCustomPlanConfig,
} from "app/services/store.server";
import { clearAppLayoutCache } from "./app";
import prisma from "app/db.server";
import { clearAdminCompaniesCache } from "./app.companies";
import { clearDashboardStatsCache } from "app/utils/dashboard-cache.server";



// ============================================================
// 🗂️  CACHE SETUP
// ============================================================

declare global {
  var __selectPlanCache:
    | Map<string, { data: any; timestamp: number }>
    | undefined;
}

const selectPlanCache: Map<string, { data: any; timestamp: number }> =
  globalThis.__selectPlanCache ??
  (globalThis.__selectPlanCache = new Map());

const SELECT_PLAN_CACHE_TTL = 30 * 1000; // 30 seconds (reduced from 2 min for critical billing page)

// ============================================================
// 🧹 CACHE HELPER
// ============================================================

export const clearSelectPlanCache = (shop: string) => {
  const key = `select-plan-${shop}`;
  selectPlanCache.delete(key);
  console.log("🧹 SelectPlan cache cleared for:", shop);
};
function getBillingErrorMessage(error: any) {
  const defaultMessage = "Billing action failed";
  const rawMessage =
    error?.errorData?.[0]?.message || error?.message || defaultMessage;

  if (rawMessage === "Custom apps cannot use the Billing API") {
    return {
      billingUnsupported: true,
      message:
        "This Shopify app install is treated as a custom app, so Shopify Billing API requests are not supported.",
    };
  }

  if (
    rawMessage.includes("no response available") ||
    rawMessage.includes("Http request error") ||
    rawMessage.includes("fetch failed")
  ) {
    return {
      billingUnsupported: true,
      message:
        "Shopify Billing API could not be reached. Ensure your app tunnel and store connection are working.",
    };
  }

  return {
    billingUnsupported: false,
    message: rawMessage,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { authenticate } = await import("../shopify.server");
  const { billing, session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const shop = session.shop;

const isTest = process.env.SHOPIFY_BILLING_TEST === "true";


  const isReturnFromBilling = url.searchParams.has("charge_id");
  const isPendingReturn = url.searchParams.has("charge_id_pending"); // ✅ NEW

  const returnTo =
    url.searchParams.get("returnTo")?.startsWith("/app/")
      ? url.searchParams.get("returnTo")
      : "/app";

  const cacheKey = `select-plan-${shop}`;
  const cached = selectPlanCache.get(cacheKey);

  // ✅ SKIP cache entirely when returning from Shopify billing
  if (
    !isReturnFromBilling &&
    !isPendingReturn &&
    cached &&
    Date.now() - cached.timestamp < SELECT_PLAN_CACHE_TTL
  ) {
    console.log(`⚡ Cache HIT → ${cacheKey}`);
    return { ...cached.data, returnTo };
  }

  console.log("🐢 Cache MISS → running billing check + DB");

  const store = await prisma.store.findUnique({
    where: { shopDomain: shop },
    select: { plan: true, planKey: true, customPlanKey: true, customAmount: true, customPlanActive: true, currencyCode: true },
  });

  if (!store) {
    const result = {
      isTest,
      hasActivePayment: false,
      currentPlan: null,
      currentPlanKey: null,
      activePlans: [],
      customAmount: null,
      customPlanActive: false,
      currencyCode: "USD",
    };
    selectPlanCache.set(cacheKey, { data: result, timestamp: Date.now() });
    return { ...result, returnTo };
  }

  const hasExplicitFreePlan = store?.plan === "free";
  const isFreePlan = hasExplicitFreePlan;

  // ✅ Free plan fast-path ONLY when NOT returning from billing
  if (!isReturnFromBilling && !isPendingReturn && isFreePlan) {
    const customAmount = store.customAmount || null;
    const customPlan = getCustomPlanConfig(
      store?.customPlanKey,
      store?.planKey,
      customAmount,
      store?.customPlanActive,
    );
    const result = {
      isTest,
      hasActivePayment: false,
      currentPlan: "free",
      currentPlanKey: store.planKey || store.customPlanKey || null,
      activePlans: [],
      customPlan,
      customAmount,
      customPlanActive: store?.customPlanActive || Boolean(customAmount),
      currencyCode: store.currencyCode || "USD",
    };
    selectPlanCache.set(cacheKey, { data: result, timestamp: Date.now() });
    console.log(`✅ Fast path free plan → ${cacheKey}`);
    return { ...result, returnTo };
  }

  const billingAny = billing as any;
  const { hasActivePayment, appSubscriptions } = await billingAny.check({
    plans: [PAID_PLAN, PLAN_99, CUSTOM_PLAN] as any,
    isTest,
  });

  // ✅ Always sync + redirect when returning from billing
  if (isReturnFromBilling || isPendingReturn) {
    // Use fast sync to avoid blocking redirect with Shopify API calls
    await syncStoreSubscriptionStateFast(shop, appSubscriptions || []);
    clearAdminCompaniesCache(shop);
    clearDashboardStatsCache(shop);
    clearSelectPlanCache(shop);

    console.log("✅ Billing return synced (fast), redirecting to", returnTo);
    throw redirect(returnTo || '/app'); // Use returnTo or default to /app
  }

  // Normal flow (not returning from billing)
  if (hasActivePayment) {
    const activeSubscription = (appSubscriptions || []).find(
      (s: any) => s.status === "ACTIVE",
    );

    // Compare stored plan with active subscription name (now we store the name directly, not converted)
    if (
      store.plan !== activeSubscription?.name ||
      store.planKey !== activeSubscription?.id
    ) {
      await syncStoreSubscriptionState(shop, appSubscriptions || [], admin);
      clearAdminCompaniesCache(shop);
      clearDashboardStatsCache(shop);
      clearSelectPlanCache(shop);
    }
  }

  const customPlan = getCustomPlanConfig(
    store?.customPlanKey,
    store?.planKey,
    store?.customAmount,
    store?.customPlanActive,
  );
  const result = {
    isTest,
    hasActivePayment: hasActivePayment || hasExplicitFreePlan || Boolean(customPlan),
    currentPlan: store?.plan || null,
    currentPlanKey: store?.planKey || store?.customPlanKey || null,
    customPlan,
    customAmount: store?.customAmount || null,
    customPlanActive: store?.customPlanActive || false,
    currencyCode: store?.currencyCode || "USD",
    activePlans: (appSubscriptions || []).map((s: any) => ({
      id: s.id,
      name: s.name,
      status: s.status,
    })),
  };

  selectPlanCache.set(cacheKey, { data: result, timestamp: Date.now() });
  console.log(`✅ Cache SET → ${cacheKey}`);

  return { ...result, returnTo };
};
export const action = async ({ request }: ActionFunctionArgs) => {
  const { authenticate } = await import("../shopify.server");
  const { billing, session, admin } = await authenticate.admin(request);
  
  // 🧹 CLEAR CACHE IMMEDIATELY at start of plan change action
  // This ensures fresh data is fetched when user returns from billing
  clearSelectPlanCache(session.shop);
  clearAppLayoutCache(session.shop);
  clearAdminCompaniesCache(session.shop);
  clearDashboardStatsCache(session.shop);
  
  const billingAny = billing as any;
  const formData = await request.formData();
  console.log("FormData:", formData);
  const plan = String(formData.get("plan") || "") as any;
  const returnToRaw = String(formData.get("returnTo") || "/app");
  console.log("Return to raw:", returnToRaw);

  const normalizeReturnTo = (value: string) => {
    try {
      const url = new URL(value, "https://example.com");
      const path = url.pathname;
      if (path === "/app" || path.startsWith("/app/")) {
        return path;
      }
    } catch (error) {
      console.warn("Invalid returnTo value", value, error);
    }
    return "/app";
  };

  let returnTo = normalizeReturnTo(returnToRaw);
  if (returnTo.length > 100) {
    console.warn("returnTo path too long, falling back to /app", returnTo);
    returnTo = "/app";
  }


  // eslint-disable-next-line no-undef
const isTest = process.env.SHOPIFY_BILLING_TEST === "true";


  try {
    if (plan !== FREE_PLAN && plan !== PAID_PLAN && plan !== PLAN_99 && plan !== CUSTOM_PLAN) {
      return { ok: false, message: "Invalid plan" };
    }

    if (plan === FREE_PLAN) {
      let billingCheck;
      try {
        billingCheck = await billingAny.check({
          plans: [PAID_PLAN, PLAN_99, CUSTOM_PLAN] as any,
          isTest,
        });
      } catch (checkError) {
        console.error("Billing check failed while downgrading to free plan", checkError);
        await setStoreFreePlan(session.shop, admin);
        clearAdminCompaniesCache(session.shop);
        clearDashboardStatsCache(session.shop);
        clearSelectPlanCache(session.shop);
        clearAppLayoutCache(session.shop);
        return { ok: false, billingUnsupported: true, message: "Unable to reach Shopify Billing API. Your plan was reset locally to free while this issue is investigated." };
      }

      const activeSubscription = (billingCheck.appSubscriptions || []).find(
        (s: any) => s.status === "ACTIVE",
      );

      if (billingCheck.hasActivePayment && activeSubscription) {
        console.log("Cancelling active paid subscription before downgrading to free plan", activeSubscription.id);
        await billing.cancel({
          subscriptionId: activeSubscription.id,
          isTest,
          prorate: true,
        });
      }

      await setStoreFreePlan(session.shop, admin);
      clearAdminCompaniesCache(session.shop);
      clearDashboardStatsCache(session.shop);
      clearSelectPlanCache(session.shop);
      clearAppLayoutCache(session.shop);
      return redirect(returnTo);
    }

    const shopName = session.shop.split(".")[0];
    const appHandle = "b2b-portal-public-dev";
   // Change your returnUrl to pass through select-plan first

    if (plan === CUSTOM_PLAN) {
      const store = await prisma.store.findUnique({
        where: { shopDomain: session.shop },
        select: { customAmount: true, currencyCode: true },
      });

      const customAmount = store?.customAmount;
      if (!customAmount || customAmount <= 0) {
        return { ok: false, message: "No custom amount configured for this store. Please contact support." };
      }

      const currencyCode = store?.currencyCode || "USD";
      let billingReturnUrl = `https://admin.shopify.com/store/${shopName}/apps/${appHandle}/app/?charge_id_pending=1&returnTo=${encodeURIComponent(returnTo)}`;
      const maxReturnUrlLength = 255;
      if (billingReturnUrl.length > maxReturnUrlLength) {
        billingReturnUrl = `https://admin.shopify.com/store/${shopName}/apps/${appHandle}/app/?charge_id_pending=1`;
      }

      console.log("Requesting custom billing for amount", customAmount, currencyCode, "returnUrl:", billingReturnUrl, "isTest:", isTest);

      const billingResponse = await billingAny.request({
        plan: CUSTOM_PLAN as any,
        isTest,
        returnUrl: billingReturnUrl,
        lineItems: [
          {
            amount: customAmount,
            currencyCode,
            interval: "EVERY_30_DAYS",
          },
        ],
      });

      console.log("Custom billing request sent", billingResponse);
      if (billingResponse instanceof Response) {
        clearSelectPlanCache(session.shop);
        clearDashboardStatsCache(session.shop);
        clearAppLayoutCache(session.shop);
        return billingResponse;
      }
      return { ok: true };
    }

    // Use the plan as-is (PLAN_99 is now configured in billing settings)
    const billingPlan = plan;
    let billingReturnUrl = `https://admin.shopify.com/store/${shopName}/apps/${appHandle}/app/?charge_id_pending=1&returnTo=${encodeURIComponent(returnTo)}`;
    const maxReturnUrlLength = 255;
    if (billingReturnUrl.length > maxReturnUrlLength) {
      console.warn("Full billing returnUrl too long, using admin app root fallback");
      billingReturnUrl = `https://admin.shopify.com/store/${shopName}/apps/${appHandle}/app/?charge_id_pending=1`;
    }
    console.log("Requesting billing for plan", billingPlan, "returnUrl:", billingReturnUrl, "isTest:", isTest);
    const billingResponse = await billingAny.request({
      plan: billingPlan as any,
      isTest,
      returnUrl: billingReturnUrl,
    });
    console.log("Billing request sent", billingResponse);
    if (billingResponse instanceof Response) {
      clearSelectPlanCache(session.shop);
      clearDashboardStatsCache(session.shop);
      clearAppLayoutCache(session.shop);
      return billingResponse;
    }
  } catch (err) {
    if (err instanceof Response) {
      clearSelectPlanCache(session.shop);
      clearDashboardStatsCache(session.shop);
      clearAppLayoutCache(session.shop);
      throw err;
    }

    const { billingUnsupported, message } = getBillingErrorMessage(err);
    console.error("Billing request failed", err);
    return { ok: false, plan, billingUnsupported, message };
  }
  // Cache already cleared at start of action, no need to clear again
  return { ok: true };
};

export default function SelectPlan() {
  const { isTest, hasActivePayment, activePlans, currentPlan, customPlan, customAmount, customPlanActive, currencyCode, returnTo } =
    useLoaderData();
  const actionData = useActionData();
  const cancelFetcher = useFetcher();
  const revalidator = useRevalidator();
  const navigation = useNavigation();

  const activePlanName = useMemo(() => {
    if (currentPlan === "free") {
      return FREE_PLAN;
    }

    // Priority 1: Check for active subscription from Shopify (most current)
    const active = activePlans.find((p: any) => p.status === "ACTIVE");
    if (active) {
      return active.name || null;
    }

    // Priority 2: Check current plan from DB (plan field)
    if (currentPlan && currentPlan !== "free" && currentPlan !== "approved payment") {
      return currentPlan;
    }

    // Priority 3: Check custom plan configuration
    if (customPlan) {
      return customPlan.name || CUSTOM_PLAN;
    }

    if (customPlanActive && customAmount && customAmount > 0) {
      return CUSTOM_PLAN;
    }

    // Default to free plan
    return currentPlan === "free" ? FREE_PLAN : null;
  }, [activePlans, currentPlan, customPlan, customPlanActive, customAmount]);

  const freePrice = useMemo(
    () => ({ amount: 0, currency: "USD", label: "$0 / month" }),
    [],
  );
  const paidPrice = useMemo(
    () => ({ amount: 49, currency: "USD", label: "$49 / month" }),
    [],
  );
  const plan99Price = useMemo(
    () => ({ amount: 99, currency: "USD", label: "$99 / month" }),
    [],
  );

  const selectedPriceLabel = useMemo(() => {
    if (activePlanName === FREE_PLAN) {
      return freePrice.label;
    }

    if (activePlanName === CUSTOM_PLAN || activePlanName === customPlan?.name) {
      return customPlan?.label || null;
    }

    if (activePlanName === PAID_PLAN) {
      return paidPrice.label;
    }

    if (activePlanName === PLAN_99) {
      return plan99Price.label;
    }

    return null;
  }, [activePlanName, customPlan, freePrice.label, paidPrice.label, plan99Price.label]);

  const hasShopifySubscription = activePlans.some(
    (plan: { status: string; }) => plan.status === "ACTIVE",
  );
  const showCustomPlanCard = Boolean(
    customPlan || customPlanActive || (customAmount && customAmount > 0),
  );
  const isCurrentCustomPlan = Boolean(
    activePlans.some((plan: any) => plan.status === "ACTIVE" && plan.name === (customPlan?.name || CUSTOM_PLAN)) ||
    activePlanName === CUSTOM_PLAN ||
    activePlanName === customPlan?.name,
  );
  const submittingPlan = navigation.formData?.get("plan");
  const isSubmitting = navigation.state !== "idle";
  const isCancelling = cancelFetcher.state !== "idle";
  const cancelResult = cancelFetcher.data;

  const submittingPlanLabel = useMemo(() => {
    if (submittingPlan === FREE_PLAN) return { name: "Free Plan", price: freePrice.label };
    if (submittingPlan === PAID_PLAN) return { name: "Plus Plan ($49/month)", price: paidPrice.label };
    if (submittingPlan === PLAN_99) return { name: "Plan 99 - Sales Portal Plan ($99/month)", price: plan99Price.label };
    if (submittingPlan === CUSTOM_PLAN) return { name: `Custom Plan ($${customAmount}/month)`, price: `$${customAmount} / month` };
    return null;
  }, [submittingPlan, freePrice.label, paidPrice.label, plan99Price.label, customAmount]);

  useEffect(() => {
    if (cancelFetcher.state === "idle" && cancelFetcher.data) {
      revalidator.revalidate();
    }
  }, [cancelFetcher.state, cancelFetcher.data, revalidator]);

  const pageShellStyle = {
    background: "#f1f2f4",
    minHeight: "100vh",
    padding: "24px",
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
  const contentPanelStyle = {
    width: "100%",
    maxWidth: 1200,
    margin: "0 auto",
    boxSizing: "border-box",
  } as const;
  const pricingGridStyle = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
    gap: "20px",
    alignItems: "stretch",
  } as const;
  const pricingCardStyle = {
    background: "#ffffff",
    border: "1px solid #dfe3e8",
    borderRadius: "18px",
    boxShadow: "0 8px 24px rgba(15, 23, 42, 0.08)",
    minHeight: "420px",
    display: "flex",
    flexDirection: "column" as const,
    overflow: "hidden",
  };
  const pricingCardBodyStyle = {
    padding: "28px 32px 20px",
    display: "flex",
    flexDirection: "column" as const,
    flex: 1,
  };
  const pricingCardFooterStyle = {
    borderTop: "1px solid #eef1f4",
    background: "#f7f7f8",
    padding: "14px 32px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    flexWrap: "wrap" as const,
  };
  const subscriptionButtonStyle = {
    minWidth: "132px",
    height: "40px",
    borderRadius: "9px",
    border: "none",
    fontSize: "14px",
    fontWeight: 600,
    cursor: "pointer",
    padding: "0 16px",
  } as const;

  return (
    <div style={pageShellStyle}>
      <div style={pageHeroStyle}>
        <Link
          to="/app"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            color: "#2c6ecb",
            textDecoration: "none",
            fontSize: "14px",
            fontWeight: 600,
            margin: "15px 15px 5px",
          }}
        >
          <svg
            viewBox="0 0 20 20"
            style={{ width: "16px", height: "16px" }}
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z"
              clipRule="evenodd"
            />
          </svg>
          Back to Dashboard
        </Link>
        <h1 style={pageHeroTitleStyle}>Plan Selection</h1>
        <p style={pageHeroTextStyle}>
          Compare available plans, subscribe, and manage your current billing status.
        </p>
      </div>
      <div style={contentPanelStyle}>
        {isSubmitting && submittingPlanLabel && (
          <div
            style={{
              background: "#e3f2fd",
              border: "2px solid #2c6ecb",
              borderRadius: 16,
              boxShadow: "0 2px 8px rgba(44, 110, 203, 0.15)",
              padding: "20px 24px",
              marginBottom: "20px",
              display: "flex",
              alignItems: "center",
              gap: "16px",
            }}
          >
            <svg
              style={{ width: "24px", height: "24px", color: "#2c6ecb", flexShrink: 0 }}
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            <div style={{ flex: 1 }}>
              <p style={{ margin: "0 0 4px", fontSize: "16px", fontWeight: 700, color: "#1976d2" }}>
                Subscribing to {submittingPlanLabel.name}
              </p>
              <p style={{ margin: 0, fontSize: "14px", color: "#1565c0" }}>
                Redirecting to payment confirmation...
              </p>
            </div>
            <svg
              style={{
                width: "20px",
                height: "20px",
                color: "#2c6ecb",
                animation: "spin 1s linear infinite",
                flexShrink: 0,
              }}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <circle cx="12" cy="12" r="10" strokeWidth="2" strokeDasharray="15.7" strokeDashoffset="0" />
            </svg>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}
       <div
          style={{
            background: "#ffffff",
            border: "1px solid #dfe3e8",
            borderRadius: 16,
            boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
            padding: "18px 20px",
          }}
        >
          <h2
            style={{
              margin: "0 0 14px",
              fontSize: "18px",
              fontWeight: 700,
              color: "#202223",
            }}
          >
            Selected plan
          </h2>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "16px",
              flexWrap: "wrap",
              background: "#f6f6f7",
              borderRadius: 12,
              padding: "16px 18px",
              border: "1px solid #e5e7eb",
            }}
          >
            <div>
              <p
                style={{
                  margin: 0,
                  fontSize: "16px",
                  fontWeight: 700,
                  color: "#111827",
                }}
              >
                {activePlanName || "No plan selected"}
              </p>
              {selectedPriceLabel && (
                <p style={{ margin: "6px 0 0", fontSize: "14px", color: "#5c5f62" }}>
                  {selectedPriceLabel}
                </p>
              )}
            </div>
            {hasShopifySubscription && activePlanName && (
              <cancelFetcher.Form method="post" action="/app/cancel-subscription">
                <button
                  type="submit"
                  disabled={isSubmitting || isCancelling}
                  style={{
                    minWidth: "160px",
                    height: "42px",
                    borderRadius: "10px",
                    border: "1px solid #dc2626",
                    background: isSubmitting || isCancelling ? "#fecaca" : "#ffffff",
                    color: "#dc2626",
                    fontSize: "14px",
                    fontWeight: 600,
                    cursor: "pointer",
                    padding: "0 18px",
                  }}
                >
                  {isCancelling ? "Cancelling..." : "Cancel subscription"}
                </button>
              </cancelFetcher.Form>
            )}
            {!hasShopifySubscription && (
              <p style={{ margin: 0, fontSize: "14px", color: "#5c5f62" }}>
                No cancellation available
              </p>
            )}
          </div>
        </div>
      </div>
      <div style={contentPanelStyle}>
        <div style={{ marginBottom: "22px" }}>
          <h2
            style={{
              fontSize: "18px",
              fontWeight: 700,
              color: "#202223",
              margin: "0 0 18px",
            }}
          >
            {/* Pricing */}
          </h2>

          <div style={pricingGridStyle}>
           

            {/* Standard plans are always displayed below the custom plan */}
            <div style={pricingCardStyle}>
              <div style={pricingCardBodyStyle}>
                <p
                  style={{
                    margin: 0,
                    fontSize: "15px",
                    fontWeight: 600,
                    color: "#5c5f62",
                  }}
                >
                  Free To Install
                </p>
                <div style={{ marginTop: "12px" }}>
                  <span
                    style={{
                      fontSize: "38px",
                      lineHeight: 1,
                      fontWeight: 700,
                      color: "#111827",
                    }}
                  >
                    Free
                  </span>
                </div>

                <div style={{ marginTop: "56px" }}>
                  <h3
                    style={{
                      margin: "0 0 12px",
                      fontSize: "16px",
                      fontWeight: 700,
                      color: "#111827",
                    }}
                  >
                    Features
                  </h3>
                  <ul
                    style={{
                      margin: 0,
                      paddingLeft: "22px",
                      color: "#5c5f62",
                      fontSize: "14px",
                      lineHeight: 1.65,
                    }}
                  >
                    <li>Custom Registration Form</li>
                    <li>One-Click Approval</li>
                    <li>Self-Service Portal</li>
                    <li>Quick Order</li>
                    <li>10 companies and 100 orders</li>
                  </ul>
                </div>
              </div>

              <div style={pricingCardFooterStyle}>
                <span
                  style={{
                    fontSize: "13px",
                    color: "#5c5f62",
                    fontWeight: 500,
                  }}
                >
                  {activePlanName === FREE_PLAN ? "Current plan selected" : "Start with free access"}
                </span>
                <Form method="post">
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <input type="hidden" name="plan" value={FREE_PLAN} />
                  <button
                    type="submit"
                    disabled={activePlanName === FREE_PLAN || isSubmitting}
                    style={{
                      ...subscriptionButtonStyle,
                      background:
                        activePlanName === FREE_PLAN || isSubmitting
                          ? "#d1d5db"
                          : "#111827",
                      color: "#ffffff",
                      fontSize: "14px",
                    }}
                  >
                    {isSubmitting && submittingPlan === FREE_PLAN
                      ? "Loading..."
                      : activePlanName === FREE_PLAN
                        ? "Current plan"
                        : "Subscribe"}
                  </button>
                </Form>
              </div>
            </div>

            <div style={pricingCardStyle}>
              <div style={pricingCardBodyStyle}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "12px",
                  }}
                >
                  <p
                    style={{
                      margin: 0,
                      fontSize: "15px",
                      fontWeight: 600,
                      color: "#5c5f62",
                    }}
                  >
                    Plus Plan
                  </p>
                  <span
                    style={{
                      padding: "6px 10px",
                      borderRadius: "999px",
                      background: "#e7f7ed",
                      color: "#157347",
                      fontSize: "12px",
                      fontWeight: 700,
                    }}
                  >
                    Recommended
                  </span>
                </div>

                <div
                  style={{
                    marginTop: "12px",
                    display: "flex",
                    alignItems: "flex-end",
                    gap: "8px",
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    style={{
                      fontSize: "40px",
                      lineHeight: 0.95,
                      fontWeight: 700,
                      color: "#111827",
                    }}
                  >
                    $49
                  </span>
                  <span
                    style={{
                      fontSize: "16px",
                      color: "#6b7280",
                      marginBottom: "5px",
                    }}
                  >
                    / month
                  </span>
                </div>
                <div style={{ marginTop: "42px" }}>
                  <h3
                    style={{
                      margin: "0 0 12px",
                      fontSize: "16px",
                      fontWeight: 700,
                      color: "#111827",
                    }}
                  >
                    Features
                  </h3>
                  <ul
                    style={{
                      margin: 0,
                      paddingLeft: "22px",
                      color: "#5c5f62",
                      fontSize: "14px",
                      lineHeight: 1.65,
                    }}
                  >
                    <li>All app features</li>
                    <li>Credit Management</li>
                    <li>Unlimited Orders</li>
                    <li>Unlimited Companies</li>
                  </ul>
                </div>
              </div>

              <div style={pricingCardFooterStyle}>
                <span
                  style={{
                    fontSize: "13px",
                    color: activePlanName === PAID_PLAN ? "#157347" : "#5c5f62",
                    fontWeight: 600,
                  }}
                >
                  14-day free trial
                </span>
                <Form method="post">
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <input type="hidden" name="plan" value={PAID_PLAN} />
                  <button
                    type="submit"
                    disabled={activePlanName === PAID_PLAN || isSubmitting}
                    style={{
                      ...subscriptionButtonStyle,
                      background:
                        activePlanName === PAID_PLAN || isSubmitting
                          ? "#d1d5db"
                          : "#111827",
                      color: "#ffffff",
                      fontSize: "14px",
                    }}
                  >
                    {isSubmitting && submittingPlan === PAID_PLAN
                      ? "Loading..."
                      : activePlanName === PAID_PLAN
                        ? "Current plan"
                        : "Subscribe"}
                  </button>
                </Form>
              </div>
            </div>

            <div style={pricingCardStyle}>
              <div style={pricingCardBodyStyle}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "12px",
                  }}
                >
                  <p
                    style={{
                      margin: 0,
                      fontSize: "15px",
                      fontWeight: 600,
                      color: "#5c5f62",
                    }}
                  >
                    Pro Plan
                  </p>
                  <span
                    style={{
                      padding: "6px 10px",
                      borderRadius: "999px",
                      background: "#f3eff7",
                      color: "#6f42c1",
                      fontSize: "12px",
                      fontWeight: 700,
                    }}
                  >
                    Best for B2B sales
                  </span>
                </div>

                <div
                  style={{
                    marginTop: "12px",
                    display: "flex",
                    alignItems: "flex-end",
                    gap: "8px",
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    style={{
                      fontSize: "40px",
                      lineHeight: 0.95,
                      fontWeight: 700,
                      color: "#111827",
                    }}
                  >
                    $99
                  </span>
                  <span
                    style={{
                      fontSize: "16px",
                      color: "#6b7280",
                      marginBottom: "5px",
                    }}
                  >
                    / month
                  </span>
                </div>
                <div style={{ marginTop: "42px" }}>
                  <h3
                    style={{
                      margin: "0 0 12px",
                      fontSize: "16px",
                      fontWeight: 700,
                      color: "#111827",
                    }}
                  >
                    Features
                  </h3>
                  <ul
                    style={{
                      margin: 0,
                      paddingLeft: "22px",
                      color: "#5c5f62",
                      fontSize: "14px",
                      lineHeight: 1.65,
                    }}
                  >
                    <li>Sales Portal access</li>
                    <li>Unlimited Companies</li>
                    <li>Unlimited Orders</li>
                    <li>Premium support</li>
                  </ul>
                </div>
              </div>

              <div style={pricingCardFooterStyle}>
                <span
                  style={{
                    fontSize: "13px",
                    color: activePlanName === PLAN_99 ? "#6f42c1" : "#5c5f62",
                    fontWeight: 600,
                  }}
                >
                  Sales Portal access
                </span>
                <Form method="post">
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <input type="hidden" name="plan" value={PLAN_99} />
                  <button
                    type="submit"
                    disabled={activePlanName === PLAN_99 || isSubmitting}
                    style={{
                      ...subscriptionButtonStyle,
                      background:
                        activePlanName === PLAN_99 || isSubmitting
                          ? "#d1d1db"
                          : "#111827",
                      color: "#ffffff",
                      fontSize: "14px",
                    }}
                  >
                    {isSubmitting && submittingPlan === PLAN_99
                      ? "Loading..."
                      : activePlanName === PLAN_99
                        ? "Current plan"
                        : "Subscribe"}
                  </button>
                </Form>
              </div>
            </div>

             {showCustomPlanCard && (
              <div style={pricingCardStyle}>
                <div style={pricingCardBodyStyle}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "12px",
                    }}
                  >
                    <p
                      style={{
                        margin: 0,
                        fontSize: "15px",
                        fontWeight: 600,
                        color: "#5c5f62",
                      }}
                    >
                      {customPlan?.name || "Custom Plan"}
                    </p>
                    {customPlan?.name ? (
                      <span
                        style={{
                          padding: "4px 12px",
                          borderRadius: "999px",
                          background: "#eef2ff",
                          color: "#3730a3",
                          fontSize: "12px",
                          fontWeight: 700,
                        }}
                      >
                        Custom pricing
                      </span>
                    ) : null}
                  </div>

                  <div style={{ marginTop: "18px" }}>
                    <span
                      style={{
                        display: "block",
                        fontSize: "40px",
                        lineHeight: 1,
                        fontWeight: 700,
                        color: "#111827",
                      }}
                    >
                      {customPlan?.amount != null ? `$${customPlan.amount}` : `$${customAmount || 0}`}
                    </span>
                    <span
                      style={{
                        fontSize: "16px",
                        color: "#6b7280",
                        marginTop: "4px",
                        display: "block",
                      }}
                    >
                      / month
                    </span>
                  </div>

                  <div style={{ marginTop: "42px" }}>
                    <h3
                      style={{
                        margin: "0 0 12px",
                        fontSize: "16px",
                        fontWeight: 700,
                        color: "#111827",
                      }}
                    >
                      Features
                    </h3>
                    <ul
                      style={{
                        margin: 0,
                        paddingLeft: "22px",
                        color: "#5c5f62",
                        fontSize: "14px",
                        lineHeight: 1.65,
                      }}
                    >
                      <li>All app features</li>
                    <li>Credit Management</li>
                    <li>Unlimited Orders</li>
                    <li>Unlimited Companies</li>
                    <li>Sales Portal access</li>
                    <li>Premium support</li>

                    </ul>
                  </div>
                </div>

                <div style={pricingCardFooterStyle}>
                  <span
                    style={{
                      fontSize: "13px",
                      color: isCurrentCustomPlan ? "#157347" : "#5c5f62",
                      fontWeight: 600,
                    }}
                  >
                    {isCurrentCustomPlan ? "Current plan selected" : "Custom pricing for your store"}
                  </span>
                  {isCurrentCustomPlan ? (
                    <button
                      disabled
                      style={{
                        ...subscriptionButtonStyle,
                        background: "#d1d5db",
                        color: "#4b5563",
                      }}
                    >
                      Current plan
                    </button>
                  ) : (
                    <Form method="post">
                      <input type="hidden" name="returnTo" value={returnTo} />
                      <input type="hidden" name="plan" value={CUSTOM_PLAN} />
                      <button
                        type="submit"
                        disabled={isSubmitting}
                        style={{
                          ...subscriptionButtonStyle,
                          background: isSubmitting ? "#d1d5db" : "#111827",
                          color: "#ffffff",
                          fontSize: "14px",
                        }}
                      >
                        {isSubmitting && submittingPlan === CUSTOM_PLAN
                          ? "Loading..."
                          : "Subscribe"}
                      </button>
                    </Form>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export const headers = (headersArgs:any) => boundary.headers(headersArgs);
