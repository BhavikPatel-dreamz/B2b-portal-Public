import {
  ActionFunctionArgs,
  Form,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  useRevalidator,
} from "react-router";
import { useEffect, useMemo } from "react";
import { FREE_PLAN, PAID_PLAN } from "app/billing-plans.shared";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  setStoreFreePlan,
  syncStoreSubscriptionState,
} from "app/services/store.server";
import prisma from "app/db.server";
import { LoaderFunctionArgs } from "react-router";
import { clearAdminCompaniesCache } from "./app.companies";
import { clearDashboardStatsCache } from "app/utils/dashboard-cache.server";

function getBillingErrorMessage(error) {
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

  return {
    billingUnsupported: false,
    message: rawMessage,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { authenticate } = await import("../shopify.server");
  const { billing, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  console.log("Running loader for select-plan route", billing);

  // eslint-disable-next-line no-undef
  const isTest =
    // eslint-disable-next-line no-undef
    process.env.SHOPIFY_BILLING_TEST == "true" ||
    // eslint-disable-next-line no-undef
    process.env.NODE_ENV !== "production";

  const { hasActivePayment, appSubscriptions } = await billing.check({
    plans: [PAID_PLAN],
    isTest,
  });
  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
    select: { plan: true, planKey: true },
  });

  if (hasActivePayment) {
    await syncStoreSubscriptionState(session.shop, appSubscriptions || []);
    clearAdminCompaniesCache(session.shop);
    clearDashboardStatsCache(session.shop);
  }

  return {
    isTest,
    hasActivePayment: hasActivePayment || store?.plan === "free",
    currentPlan: store?.plan || null,
    currentPlanKey: store?.planKey || null,
    returnTo:
      url.searchParams.get("returnTo") &&
      url.searchParams.get("returnTo")?.startsWith("/app/")
        ? url.searchParams.get("returnTo")
        : "/app/billing-example",
    activePlans: (appSubscriptions || []).map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { authenticate } = await import("../shopify.server");
  const { billing, session } = await authenticate.admin(request);
  const formData = await request.formData();
  console.log("FormData:", formData);
  const plan = formData.get("plan");
  const returnToRaw = String(formData.get("returnTo") || "/app/home");
  console.log("Return to raw:", returnToRaw);
  const returnTo = returnToRaw.startsWith("/app/") ? returnToRaw : "/app/home";
  const requestUrl = new URL(request.url);
  console.log("Running action for select-plan route111",requestUrl);

  // eslint-disable-next-line no-undef
  const isTest =
    // eslint-disable-next-line no-undef
    process.env.SHOPIFY_BILLING_TEST == "true" ||
    // eslint-disable-next-line no-undef
    process.env.NODE_ENV !== "production";

  try {
    if (plan !== FREE_PLAN && plan !== PAID_PLAN) {
      return { ok: false, message: "Invalid plan" };
    }

    if (plan === FREE_PLAN) {
      await setStoreFreePlan(session.shop);
      clearAdminCompaniesCache(session.shop);
      clearDashboardStatsCache(session.shop);
      return {
        ok: true,
        message: "Free plan activated successfully.",
        redirectTo: returnTo,
      };
    }

    const appUrl = new URL(request.url).origin;
    const returnUrl = new URL(returnTo, appUrl);
    returnUrl.searchParams.set("shop", session.shop);

    const host = requestUrl.searchParams.get("host");
    if (host) {
      returnUrl.searchParams.set("host", host);
    }

    const embedded = requestUrl.searchParams.get("embedded");
    if (embedded) {
      returnUrl.searchParams.set("embedded", embedded);
    }

    console.log("Requesting billing for plan", appUrl, "isTest:", isTest);
    await billing.request({
      plan,
      isTest,
      returnUrl: returnUrl.toString(),
    });
    console.log("Billing request sent");
  } catch (err) {
    if (err instanceof Response) {
      throw err;
    }

    const { billingUnsupported, message } = getBillingErrorMessage(err);
    console.error("Billing request failed", err);
    return { ok: false, plan, billingUnsupported, message };
  }

  return { ok: true };
};

export default function SelectPlan() {
  const { isTest, hasActivePayment, activePlans, currentPlan, returnTo } =
    useLoaderData();
  const actionData = useActionData();
  const cancelFetcher = useFetcher();
  const revalidator = useRevalidator();
  const navigation = useNavigation();

  const activePlanName = useMemo(() => {
    // Prefer ACTIVE status if present; otherwise first subscription name.
    const active = activePlans.find((p) => p.status === "ACTIVE");
    if (active || activePlans[0]) {
      return (active || activePlans[0])?.name || null;
    }

    return currentPlan === "free" ? FREE_PLAN : null;
  }, [activePlans, currentPlan]);

  const freePrice = useMemo(
    () => ({ amount: 0, currency: "USD", label: "$0 / month" }),
    [],
  );
  const paidPrice = useMemo(
    () => ({ amount: 49, currency: "USD", label: "$49 / month" }),
    [],
  );

  const selectedPriceLabel = useMemo(() => {
    if (activePlanName === FREE_PLAN) {
      return freePrice.label;
    }

    if (activePlanName === PAID_PLAN) {
      return paidPrice.label;
    }

    return null;
  }, [activePlanName, freePrice.label, paidPrice.label]);
  const hasShopifySubscription = activePlans.some(
    (plan) => plan.status === "ACTIVE",
  );
  const submittingPlan = navigation.formData?.get("plan");
  const isSubmitting = navigation.state !== "idle";
  const isCancelling = cancelFetcher.state !== "idle";
  const cancelResult = cancelFetcher.data;

  useEffect(() => {
    if (cancelFetcher.state === "idle" && cancelResult?.ok) {
      revalidator.revalidate();
    }
  }, [cancelFetcher.state, cancelResult, revalidator]);

  useEffect(() => {
    if (actionData?.ok && actionData?.redirectTo) {
      window.location.href = actionData.redirectTo;
    }
  }, [actionData]);
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
    padding: "16px 22px",
    borderRadius: 14,
    border: "1px solid #dfe3e8",
    background: "linear-gradient(135deg, #ffffff 0%, #f4f8ff 55%, #eef6f3 100%)",
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
    margin: 0,
  } as const;
  const pageHeroTextStyle = {
    fontSize: "14px",
    color: "#5c5f62",
    margin: "8px 0 0",
  } as const;
  const contentPanelStyle = {
    width: "100%",
    maxWidth: 1200,
    margin: "0 auto",
    boxSizing: "border-box",
  } as const;

  return (
    <div style={pageShellStyle}>
      <div style={pageHeroStyle}>
        <h1 style={pageHeroTitleStyle}>Plan Selection</h1>
        <p style={pageHeroTextStyle}>
          Compare available plans, subscribe, and manage your current billing status.
        </p>
      </div>
      <div style={contentPanelStyle}>
      <div
        style={{
          background: "#ffffff",
          border: "1px solid #dfe3e8",
          borderRadius: 16,
          boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
          padding: "18px",
        }}
      >
      <s-section heading="Plans">
        <s-stack direction="inline" gap="base">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="base">
              <s-heading>Free</s-heading>
              <s-paragraph>
                <s-text emphasis="bold" size="large">
                  {freePrice.label}
                </s-text>
              </s-paragraph>
              <s-unordered-list>
                <s-list-item>Recurring Shopify subscription</s-list-item>
                <s-list-item>
                  Entry-level plan billed at $0 per month
                </s-list-item>
                <s-list-item>
                  Merchant approval happens in Shopify admin
                </s-list-item>
              </s-unordered-list>
              <Form method="post">
                <input type="hidden" name="returnTo" value={returnTo} />
                <input type="hidden" name="plan" value={FREE_PLAN} />
                <s-button
                  type="submit"
                  variant="secondary"
                  {...(isSubmitting && submittingPlan === FREE_PLAN
                    ? { loading: true }
                    : {})}
                  {...(activePlanName === FREE_PLAN || isSubmitting
                    ? { disabled: true }
                    : {})}
                >
                  {activePlanName === FREE_PLAN ? "Current plan" : "Subscribe"}
                </s-button>
              </Form>
            </s-stack>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="base" align="space-between">
                <s-heading>Paid</s-heading>
                <s-badge tone="success">Recommended</s-badge>
              </s-stack>
              <s-paragraph>
                <s-text emphasis="bold" size="large">
                  {paidPrice.label}
                </s-text>
              </s-paragraph>
              <s-unordered-list>
                <s-list-item>Recurring Shopify subscription</s-list-item>
                <s-list-item>Use this as your premium paid plan</s-list-item>
                <s-list-item>Approval happens inside Shopify admin</s-list-item>
              </s-unordered-list>

              <Form method="post">
                <input type="hidden" name="returnTo" value={returnTo} />
                <input type="hidden" name="plan" value={PAID_PLAN} />
                <s-button
                  type="submit"
                  variant="primary"
                  {...(isSubmitting && submittingPlan === PAID_PLAN
                    ? { loading: true }
                    : {})}
                  {...(activePlanName === PAID_PLAN || isSubmitting
                    ? { disabled: true }
                    : {})}
                >
                  {activePlanName === PAID_PLAN ? "Current plan" : "Subscribe"}
                </s-button>
              </Form>
            </s-stack>
          </s-box>
        </s-stack>
      </s-section>
      <s-section heading="Selected plan">
        <s-box
          padding="base"
          borderWidth="base"
          borderRadius="base"
          background="subdued"
        >
          <s-stack direction="inline" gap="base" align="space-between">
            <s-stack direction="block" gap="none">
              <s-paragraph>
                <s-text emphasis="bold">
                  {activePlanName || "No plan selected"}
                </s-text>
              </s-paragraph>
              {selectedPriceLabel && <s-paragraph>{selectedPriceLabel}</s-paragraph>}
            </s-stack>
            {hasShopifySubscription && activePlanName && (
              <cancelFetcher.Form
                method="post"
                action="/app/cancel-subscription"
              >
                <s-button
                  type="submit"
                  variant="secondary"
                  tone="critical"
                  {...(isCancelling ? { loading: true } : {})}
                  {...(isSubmitting ? { disabled: true } : {})}
                >
                  Cancel subscription
                </s-button>
              </cancelFetcher.Form>
            )}
            {!hasShopifySubscription && (
              <s-paragraph>
                <s-text>No cancellation available</s-text>
              </s-paragraph>
            )}
          </s-stack>
        </s-box>
      </s-section>
      </div>
      </div>
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
