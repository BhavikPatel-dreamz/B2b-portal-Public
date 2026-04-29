import {
  ActionFunctionArgs,
  Form,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  useRevalidator,
} from "react-router";
import { useEffect, useMemo, useState } from "react";
import { FREE_PLAN, PAID_PLAN } from "app/billing-plans.shared";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  setStoreFreePlan,
  syncStoreSubscriptionState,
} from "app/services/store.server";
import prisma from "app/db.server";
import { LoaderFunctionArgs } from "react-router";

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
  const plan = formData.get("plan");
  const returnToRaw = String(formData.get("returnTo") || "/app/home");
  const returnTo = returnToRaw.startsWith("/app/") ? returnToRaw : "/app/home";

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
      return {
        ok: true,
        message: "Free plan activated successfully.",
        redirectTo: returnTo,
      };
    }

    const appUrl = new URL(request.url).origin;
    console.log("Requesting billing for plan", appUrl, "isTest:", isTest);
    await billing.request({
      plan,
      isTest,
      returnUrl: new URL(returnTo, appUrl).toString(),
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
  const [billingCycle, setBillingCycle] = useState("monthly");
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

  const selectedPlan = billingCycle === "annual" ? PAID_PLAN : FREE_PLAN;
  const selectedPrice = billingCycle === "annual" ? paidPrice : freePrice;
  const isSelectedActive = selectedPlan === activePlanName;
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

  return (
    <s-page heading="Select a plan">
      <s-section>
        <s-box
          padding="base"
          borderWidth="base"
          borderRadius="base"
          background="subdued"
        >
          <s-stack direction="block" gap="base">
            <s-heading>Pick the plan that fits your store</s-heading>
            <s-paragraph>
              Both plans go through Shopify approval, and both are subscription
              plans. Choose the $0 entry subscription or the $49 premium
              subscription.
            </s-paragraph>

            <s-stack direction="inline" gap="base" align="space-between">
              <s-paragraph>
                Environment: <s-text>{isTest ? "test" : "live"}</s-text>
              </s-paragraph>
              <s-paragraph>
                Billing:{" "}
                <s-text>{hasActivePayment ? "active" : "inactive"}</s-text>
              </s-paragraph>
            </s-stack>

            {activePlanName ? (
              <s-paragraph>
                Current plan: <s-text emphasis="bold">{activePlanName}</s-text>
              </s-paragraph>
            ) : (
              <s-paragraph>
                Current plan: <s-text>No approved plan yet</s-text>
              </s-paragraph>
            )}

            {actionData?.ok === true && actionData?.message && (
              <s-box
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="success-subdued"
              >
                <s-paragraph>{actionData.message}</s-paragraph>
              </s-box>
            )}

            {cancelResult?.ok === true && (
              <s-box
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="success-subdued"
              >
                <s-paragraph>
                  {cancelResult?.message ||
                    "Subscription cancelled successfully."}
                </s-paragraph>
              </s-box>
            )}

            {actionData?.ok === false && actionData?.message && (
              <s-box
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="critical-subdued"
              >
                <s-stack direction="block" gap="tight">
                  <s-paragraph>
                    <s-text emphasis="bold">Billing error</s-text>
                  </s-paragraph>
                  <s-paragraph>{actionData.message}</s-paragraph>
                  {actionData.billingUnsupported && (
                    <s-paragraph>
                      This usually means Shopify Billing API is not available
                      for this app installation or store type.
                    </s-paragraph>
                  )}
                </s-stack>
              </s-box>
            )}

            {cancelResult?.ok === false && cancelResult?.message && (
              <s-box
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="critical-subdued"
              >
                <s-stack direction="block" gap="tight">
                  <s-paragraph>
                    <s-text emphasis="bold">Billing error</s-text>
                  </s-paragraph>
                  <s-paragraph>{cancelResult.message}</s-paragraph>
                </s-stack>
              </s-box>
            )}

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
          </s-stack>
        </s-box>
      </s-section>

      <s-section heading="Billing cycle">
        <s-box padding="base" borderWidth="base" borderRadius="base">
          <s-stack direction="inline" gap="base" align="space-between">
            <s-paragraph>
              Plan type: {billingCycle === "annual" ? "paid" : "free"}
            </s-paragraph>
            <s-stack direction="inline" gap="base">
              <s-button
                variant={billingCycle === "monthly" ? "primary" : "secondary"}
                onClick={() => setBillingCycle("monthly")}
              >
                Free
              </s-button>
              <s-button
                variant={billingCycle === "annual" ? "primary" : "secondary"}
                onClick={() => setBillingCycle("annual")}
              >
                Paid
              </s-button>
            </s-stack>
          </s-stack>
        </s-box>
      </s-section>

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

          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background={billingCycle === "annual" ? "subdued" : undefined}
          >
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
                <s-text emphasis="bold">{selectedPlan}</s-text>
              </s-paragraph>
              <s-paragraph>{selectedPrice.label}</s-paragraph>
            </s-stack>
            <Form method="post">
              <input type="hidden" name="returnTo" value={returnTo} />
              <input type="hidden" name="plan" value={selectedPlan} />
              <s-button
                type="submit"
                variant="primary"
                {...(isSubmitting && submittingPlan === selectedPlan
                  ? { loading: true }
                  : {})}
                {...(isSelectedActive || isSubmitting
                  ? { disabled: true }
                  : {})}
              >
                {isSelectedActive
                  ? "Already subscribed"
                  : "Continue to approval"}
              </s-button>
            </Form>
          </s-stack>
        </s-box>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
