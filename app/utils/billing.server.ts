import { PAID_PLAN, PLAN_99, CUSTOM_PLAN } from "app/billing-plans.shared";

export function getIsTestBilling() {
  return process.env.SHOPIFY_BILLING_TEST == "false";
}

export const APP_BILLING_PLANS: string[] = [PAID_PLAN, PLAN_99, CUSTOM_PLAN];
 