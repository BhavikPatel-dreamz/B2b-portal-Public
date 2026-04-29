import { PAID_PLAN } from "app/billing-plans.shared";

export function getIsTestBilling() {
  return process.env.SHOPIFY_BILLING_TEST == "true";
}

export const APP_BILLING_PLANS = [PAID_PLAN];
