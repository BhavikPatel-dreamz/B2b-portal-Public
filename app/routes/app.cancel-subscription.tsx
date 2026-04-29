import { PAID_PLAN } from "app/billing-plans.shared";
import { ActionFunctionArgs } from "react-router";
import { clearStorePlan } from "app/services/store.server";


export const action = async ({ request }: ActionFunctionArgs) => {
  const { authenticate } = await import("../shopify.server");
  const { billing, session } = await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  const isTest =
    // eslint-disable-next-line no-undef
    process.env.SHOPIFY_BILLING_TEST == "true" ||
    // eslint-disable-next-line no-undef
    process.env.NODE_ENV !== "production";

  const billingCheck = await billing.check({
    plans: [PAID_PLAN],
    isTest,
  });

  const activeSubscription = (billingCheck.appSubscriptions || []).find(
    (s) => s.status === "ACTIVE",
  );
  console.log("Active subscription found:", activeSubscription);

  if (!billingCheck.hasActivePayment || !activeSubscription) {
    await clearStorePlan(session.shop);
    return { ok: false, message: "No active subscription found to cancel." };
  }


  const cancelledSubscription = await billing.cancel({
    subscriptionId: activeSubscription.id,
    isTest,
    prorate: true,
  });
  console.log("Cancelled subscription:", cancelledSubscription);

  await clearStorePlan(session.shop);

  return { ok: true, cancelledSubscription };
};
