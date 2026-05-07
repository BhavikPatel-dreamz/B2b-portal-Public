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
  const { billing, session, admin } = await authenticate.admin(request);
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
    await syncStoreSubscriptionState(session.shop, appSubscriptions || [], admin);
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
        : "/app",
    activePlans: (appSubscriptions || []).map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { authenticate } = await import("../shopify.server");
  const { billing, session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  console.log("FormData:", formData);
  const plan = formData.get("plan");
  const returnToRaw = String(formData.get("returnTo") || "/app");
  console.log("Return to raw:", returnToRaw);
  const returnTo = returnToRaw.startsWith("/app/") ? returnToRaw : "/app";
  const requestUrl = new URL(request.url);
  console.log("Running action for select-plan route111", requestUrl);

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
      await setStoreFreePlan(session.shop, admin);
      clearAdminCompaniesCache(session.shop);
      clearDashboardStatsCache(session.shop);
      return redirect(returnTo);
    }

    const shopName = session.shop.split(".")[0];
    const appHandle = "b2b-portal-public-dev";
    const returnUrl = `https://admin.shopify.com/store/${shopName}/apps/${appHandle}${returnTo}`;

    console.log("Requesting billing for plan", returnUrl, "isTest:", isTest);
    await billing.request({
      plan,
      isTest,
      returnUrl: returnUrl,
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
    gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
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
        <div style={{ marginBottom: "22px" }}>
          <h2
            style={{
              fontSize: "18px",
              fontWeight: 700,
              color: "#202223",
              margin: "0 0 18px",
            }}
          >
            Pricing
          </h2>

          <div style={pricingGridStyle}>
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
                    <li>All app feature</li>
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
          </div>
        </div>

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
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
