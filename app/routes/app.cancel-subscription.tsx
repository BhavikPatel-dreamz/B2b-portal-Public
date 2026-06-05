import { PAID_PLAN } from "app/billing-plans.shared";
import { ActionFunctionArgs,redirect } from "react-router";
import { setStoreFreePlan } from "app/services/store.server";
import { clearAdminCompaniesCache } from "./app.companies";
import { clearDashboardStatsCache } from "app/utils/dashboard-cache.server";
import { clearSelectPlanCache } from "./app.select-plan"; 


export const action = async ({ request }: ActionFunctionArgs) => {
  const { authenticate } = await import("../shopify.server");
  const { billing, session, admin } = await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  const isTest = process.env.SHOPIFY_BILLING_TEST === "true";

  const billingCheck = await billing.check({
    plans: [PAID_PLAN],
    isTest,
  });

  const activeSubscription = (billingCheck.appSubscriptions || []).find(
    (s) => s.status === "ACTIVE",
  );
  console.log("Active subscription found:", activeSubscription);

  if (!billingCheck.hasActivePayment || !activeSubscription) {
    await setStoreFreePlan(session.shop, admin);
    clearSelectPlanCache(session.shop);
    clearAdminCompaniesCache(session.shop);
    clearDashboardStatsCache(session.shop);
    return { ok: false, message: "No active subscription found to cancel. Store has been downgraded to free plan." };
  }


  const cancelledSubscription = await billing.cancel({
    subscriptionId: activeSubscription.id,
    isTest,
    prorate: true,
  });
  console.log("Cancelled subscription:", cancelledSubscription);

  await setStoreFreePlan(session.shop, admin);
  clearSelectPlanCache(session.shop);
  clearAdminCompaniesCache(session.shop);
  clearDashboardStatsCache(session.shop);

  return redirect("/app/select-plan");
};
