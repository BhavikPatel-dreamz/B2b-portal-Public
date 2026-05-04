import prisma from "app/db.server";

export const FREE_PLAN_MAX_COMPANIES = 10;
export const FREE_PLAN_MAX_REGISTRATIONS = 10;
export const FREE_PLAN_MAX_ORDERS = 100;

export function getSelectPlanPath(returnTo = "/app/companies") {
  return `/app/select-plan?returnTo=${encodeURIComponent(returnTo)}`;
}

export function getFreePlanCompaniesLimitMessage() {
  return `Free plan allows up to ${FREE_PLAN_MAX_COMPANIES} companies. Upgrade your plan to add more companies.`;
}

export function getFreePlanRegistrationsLimitMessage() {
  return `Free plan allows up to ${FREE_PLAN_MAX_REGISTRATIONS} registrations. Please upgrade the plan to accept more registrations.`;
}

export function getFreePlanOrdersLimitMessage() {
  return `Free plan allows up to ${FREE_PLAN_MAX_ORDERS} B2B orders. Please upgrade the plan to continue creating orders.`;
}

export async function getFreePlanUsage(storeId: string) {
  const [companyCount, registrationCount, orderCount] = await Promise.all([
    prisma.companyAccount.count({
      where: { shopId: storeId },
    }),
    prisma.registrationSubmission.count({
      where: {
        shopId: storeId,
        status: { in: ["PENDING", "APPROVED"] },
      },
    }),
    prisma.b2BOrder.count({
      where: {
        shopId: storeId,
        orderStatus: { not: "cancelled" },
      },
    }),
  ]);

  return {
    companyCount,
    registrationCount,
    orderCount,
    companyLimitReached: companyCount >= FREE_PLAN_MAX_COMPANIES,
    registrationLimitReached:
      registrationCount >= FREE_PLAN_MAX_REGISTRATIONS,
    orderLimitReached: orderCount >= FREE_PLAN_MAX_ORDERS,
  };
}
