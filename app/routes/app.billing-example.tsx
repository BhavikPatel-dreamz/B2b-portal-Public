import {
  Form,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { FREE_PLAN, PAID_PLAN, USAGE_PLAN } from "app/billing-plans.shared";
import { getIsTestBilling } from "app/utils/billing.server";

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

export const loader = async ({ request }) => {
  const { authenticate } = await import("../shopify.server");
  const { billing } = await authenticate.admin(request);
  const isTest = getIsTestBilling();

  const plansCheck = await billing.check({
    plans: [FREE_PLAN, PAID_PLAN, USAGE_PLAN],
    isTest,
  });
  const anyCheck = await billing.check({ isTest });

  return {
    isTest,
    plansCheck,
    anyCheck,
  };
};

export const action = async ({ request }) => {
  const { authenticate } = await import("../shopify.server");
  const { billing } = await authenticate.admin(request);
  const isTest = getIsTestBilling();
  const formData = await request.formData();
  const intent = formData.get("intent");

  try {
    if (intent === "check-plans") {
      const res = await billing.check({
        plans: [FREE_PLAN, PAID_PLAN, USAGE_PLAN],
        isTest,
      });
      return { ok: true, intent, result: res };
    }

    if (intent === "check-any") {
      const res = await billing.check({ isTest });
      return { ok: true, intent, result: res };
    }

    if (intent === "request-now") {
      const plan = formData.get("plan");
      if (plan !== FREE_PLAN && plan !== PAID_PLAN && plan !== USAGE_PLAN) {
        return { ok: false, intent, message: "Invalid plan" };
      }

      await billing.request({
        plan,
        isTest,
        returnUrl: new URL(
          "/app/billing-example",
          process.env.SHOPIFY_APP_URL || request.url,
        ).toString(),
      });
    }

    if (intent === "custom-return-url") {
      const returnUrl = String(formData.get("returnUrl") || "").trim();
      
      await billing.request({
        plan: PAID_PLAN,
        isTest,
        returnUrl: new URL(
          returnUrl || "/app/billing-example",
          process.env.SHOPIFY_APP_URL || request.url,
        ).toString(),
      });
    }

    if (intent === "override-plan-settings") {
      const trialDays = Number(formData.get("trialDays") || 0);
      await billing.request({
        plan: PAID_PLAN,
        isTest,
        ...(trialDays > 0 ? { trialDays } : {}),
        lineItems: [
          {
            interval: "EVERY_30_DAYS",
            discount: { value: { percentage: 0.1 } },
          },
        ],
        returnUrl: new URL(
          "/app/billing-example",
          process.env.SHOPIFY_APP_URL || request.url,
        ).toString(),
      });
    }

    if (intent === "create-usage-record") {
      const subscriptionLineItemId = String(
        formData.get("subscriptionLineItemId") || "",
      ).trim();
      if (!subscriptionLineItemId) {
        return { ok: false, intent, message: "subscriptionLineItemId is required" };
      }
      const amount = Number(formData.get("amount") || 1);
      const res = await billing.createUsageRecord({
        subscriptionLineItemId,
        description: "Usage record test",
        price: { amount, currencyCode: "USD" },
        isTest,
        idempotencyKey: `usage_${Date.now()}`,
      });
      return { ok: true, intent, result: res };
    }

    if (intent === "update-usage-cap") {
      const subscriptionLineItemId = String(
        formData.get("subscriptionLineItemId") || "",
      ).trim();
      const cappedAmount = Number(formData.get("cappedAmount") || 10);

      if (!subscriptionLineItemId) {
        return { ok: false, intent, message: "subscriptionLineItemId is required" };
      }

      await billing.updateUsageCappedAmount({
        subscriptionLineItemId,
        cappedAmount: { amount: cappedAmount, currencyCode: "USD" },
      });
    }

    return { ok: true, intent, message: "Done" };
  } catch (err) {
    if (err instanceof Response) {
      throw err;
    }

    const { billingUnsupported, message } = getBillingErrorMessage(err);
    return { ok: false, intent, billingUnsupported, message };
  }
};

export default function BillingExamples() {
  const { isTest, plansCheck, anyCheck } = useLoaderData();
  const actionData = useActionData();
  const fetcher = useFetcher();
  const navigation = useNavigation();
  const activeSubscription =
    plansCheck?.appSubscriptions?.find((plan) => plan.status === "ACTIVE") ||
    plansCheck?.appSubscriptions?.[0] ||
    anyCheck?.appSubscriptions?.find((plan) => plan.status === "ACTIVE") ||
    anyCheck?.appSubscriptions?.[0] ||
    null;
  const hasActivePayment =
    plansCheck?.hasActivePayment || anyCheck?.hasActivePayment || false;
  const submittingIntent = navigation.formData?.get("intent");
  const submittingPlan = navigation.formData?.get("plan");

  return (
    <s-page heading="Billing examples">
      <s-section>
        <s-paragraph>
          Mode: <s-text>{isTest ? "test" : "live"}</s-text>
        </s-paragraph>
      </s-section>

      <s-section heading="Current plan">
        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base" align="space-between">
              <s-heading>
                {activeSubscription?.name || "No active plan"}
              </s-heading>
              <s-badge tone={hasActivePayment ? "success" : "info"}>
                {hasActivePayment ? "Active" : "Inactive"}
              </s-badge>
            </s-stack>

            <s-paragraph>
              {activeSubscription
                ? "This shop already has a Shopify billing record for the app."
                : "No approved recurring subscription was found for this shop in the current billing mode."}
            </s-paragraph>

            {activeSubscription && (
              <s-stack direction="block" gap="tight">
                <s-paragraph>
                  Plan name: <s-text emphasis="bold">{activeSubscription.name}</s-text>
                </s-paragraph>
                <s-paragraph>
                  Status: <s-text>{activeSubscription.status}</s-text>
                </s-paragraph>
                <s-paragraph>
                  Subscription ID: <s-text>{activeSubscription.id}</s-text>
                </s-paragraph>
              </s-stack>
            )}
          </s-stack>
        </s-box>
      </s-section>

      <s-section heading="Current billing status">
        <s-stack direction="block" gap="base">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-heading>billing.check(plans)</s-heading>
            <pre style={{ margin: 0 }}>
              <code>{JSON.stringify(plansCheck, null, 2)}</code>
            </pre>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-heading>billing.check()</s-heading>
            <pre style={{ margin: 0 }}>
              <code>{JSON.stringify(anyCheck, null, 2)}</code>
            </pre>
          </s-box>
        </s-stack>
      </s-section>

      <s-section heading="Run examples">
        <s-stack direction="block" gap="base">
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="check-plans" />
            <s-button
              type="submit"
              {...(fetcher.state !== "idle" ? { loading: true } : {})}
            >
              Run billing.check(plans)
            </s-button>
          </fetcher.Form>

          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="check-any" />
            <s-button
              type="submit"
              variant="secondary"
              {...(fetcher.state !== "idle" ? { loading: true } : {})}
            >
              Run billing.check()
            </s-button>
          </fetcher.Form>

          <Form method="post">
            <input type="hidden" name="intent" value="request-now" />
            <input type="hidden" name="plan" value={PAID_PLAN} />
            <s-button
              type="submit"
              {...(
                submittingIntent === "request-now" &&
                submittingPlan === PAID_PLAN
                  ? { loading: true }
                  : {}
              )}
            >
              Request {PAID_PLAN} now
            </s-button>
          </Form>

          <Form method="post">
            <input type="hidden" name="intent" value="request-now" />
            <input type="hidden" name="plan" value={USAGE_PLAN} />
            <s-button
              type="submit"
              variant="secondary"
              {...(
                submittingIntent === "request-now" &&
                submittingPlan === USAGE_PLAN
                  ? { loading: true }
                  : {}
              )}
            >
              Request {USAGE_PLAN} now
            </s-button>
          </Form>

          <Form method="post">
            <input type="hidden" name="intent" value="custom-return-url" />
            <s-stack direction="inline" gap="base">
              <input
                name="returnUrl"
                placeholder="/app/billing-example"
                defaultValue="/app/billing-example"
              />
              <s-button
                type="submit"
                {...(
                  submittingIntent === "custom-return-url"
                    ? { loading: true }
                    : {}
                )}
              >
                Request (custom returnUrl)
              </s-button>
            </s-stack>
          </Form>

          <Form method="post">
            <input type="hidden" name="intent" value="override-plan-settings" />
            <s-stack direction="inline" gap="base">
              <input
                name="trialDays"
                type="number"
                min="0"
                placeholder="trialDays"
                defaultValue="14"
              />
              <s-button
                type="submit"
                {...(
                  submittingIntent === "override-plan-settings"
                    ? { loading: true }
                    : {}
                )}
              >
                Request (override plan settings)
              </s-button>
            </s-stack>
          </Form>

          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="create-usage-record" />
            <s-stack direction="inline" gap="base">
              <input
                name="subscriptionLineItemId"
                placeholder="Usage subscriptionLineItemId"
              />
              <input
                name="amount"
                type="number"
                min="0"
                step="0.01"
                defaultValue="1"
              />
              <s-button
                type="submit"
                {...(fetcher.state !== "idle" ? { loading: true } : {})}
              >
                Create usage record
              </s-button>
            </s-stack>
          </fetcher.Form>

          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="update-usage-cap" />
            <s-stack direction="inline" gap="base">
              <input
                name="subscriptionLineItemId"
                placeholder="Usage subscriptionLineItemId"
              />
              <input
                name="cappedAmount"
                type="number"
                min="0"
                step="0.01"
                defaultValue="10"
              />
              <s-button
                type="submit"
                variant="secondary"
                {...(fetcher.state !== "idle" ? { loading: true } : {})}
              >
                Update usage capped amount
              </s-button>
            </s-stack>
          </fetcher.Form>

          <fetcher.Form method="post" action="/app/cancel-subscription">
            <s-button
              type="submit"
              variant="tertiary"
              {...(fetcher.state !== "idle" ? { loading: true } : {})}
            >
              Cancel subscription (first active)
            </s-button>
          </fetcher.Form>
        </s-stack>
      </s-section>

      {(fetcher.data || actionData) && (
        <s-section heading="Last action result">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <pre style={{ margin: 0 }}>
              <code>{JSON.stringify(actionData || fetcher.data, null, 2)}</code>
            </pre>
          </s-box>
        </s-section>
      )}
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
