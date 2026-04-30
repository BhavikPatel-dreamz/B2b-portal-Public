import prisma from "../db.server";
import { FREE_PLAN, PAID_PLAN } from "../billing-plans.shared";

export interface CreateStoreInput {
  shopDomain: string;
  shopName?: string;
  accessToken?: string;
  scope?: string;
  currencyCode?: string;
}

export interface UpdateStoreInput {
  shopName?: string;
  accessToken?: string;
  scope?: string;
  plan?: string | null;
  planKey?: string | null;
  isActive?: boolean;
  logo?: string | null;
  currencyCode?: string | null;
  submissionEmail?: string | null;
  companyWelcomeEmailTemplate?: string | null;
  companyWelcomeEmailEnabled?: boolean;
  contactEmail?: string | null;
  themeColor?: string | null;
  autoApproveB2BOnboarding?: boolean;
  defaultCompanyCreditLimit?: number | string | null;
  orderConfirmationToMainAccount?: boolean;
  allowQuickOrderForUser?: boolean;
  privacyPolicylink?: string | null;
  privacyPolicyContent?: string | null;
}

/**
 * Create or update a store (upsert on install)
 */
export async function upsertStore(data: CreateStoreInput) {
  return await prisma.store.upsert({
    where: { shopDomain: data.shopDomain },
    create: {
      shopDomain: data.shopDomain,
      shopName: data.shopName,
      accessToken: data.accessToken,
      scope: data.scope,
      currencyCode: data.currencyCode,
    },
    update: {
      shopName: data.shopName,
      accessToken: data.accessToken,
      scope: data.scope,
      currencyCode: data.currencyCode,
      isActive: true,
      uninstalledAt: null,
    },
  });
}

/**
 * Get store by shop domain
 */
export async function getStoreByDomain(shopDomain: string) {
  return await prisma.store.findUnique({
    where: { shopDomain },
    include: {
      users: true,
    },
  });
}

/**
 * Get store by ID
 */
export async function getStoreById(id: string) {
  return await prisma.store.findUnique({
    where: { id },
    include: {
      users: true,
    },
  });
}

/**
 * Get all stores
 */
export async function getAllStores() {
  return await prisma.store.findMany({
    where: { isActive: true },
    orderBy: { installedAt: "desc" },
    include: {
      _count: {
        select: { users: true },
      },
    },
  });
}

/**
 * Update store
 */
export async function updateStore(id: string, data: UpdateStoreInput) {
  return await prisma.store.update({
    where: { id },
    data: {
      ...data,
      updatedAt: new Date(),
    },
  });
}

function getStorePlanValue(subscriptionName?: string | null) {
  if (subscriptionName === FREE_PLAN) {
    return "free";
  }

  if (subscriptionName === PAID_PLAN) {
    return "approved payment";
  }

  return null;
}

type AppSubscriptionSummary = {
  id?: string | null;
  name?: string | null;
  status?: string | null;
};

export async function syncStoreSubscriptionState(
  shopDomain: string,
  appSubscriptions: AppSubscriptionSummary[] = [],
) {
  const activeSubscription =
    appSubscriptions.find((subscription) => subscription.status === "ACTIVE") ||
    null;

  return await prisma.store.updateMany({
    where: { shopDomain },
    data: {
      plan: getStorePlanValue(activeSubscription?.name),
      planKey: activeSubscription?.id ?? null,
      updatedAt: new Date(),
    },
  });
}

export async function setStoreFreePlan(shopDomain: string) {
  return await prisma.store.updateMany({
    where: { shopDomain },
    data: {
      plan: "free",
      planKey: "free",
      updatedAt: new Date(),
    },
  });
}

export async function clearStorePlan(shopDomain: string) {
  return await prisma.store.updateMany({
    where: { shopDomain },
    data: {
      plan: null,
      planKey: null,
      updatedAt: new Date(),
    },
  });
}

/**
 * Mark store as uninstalled
 */
export async function uninstallStore(shopDomain: string) {
  return await prisma.store.update({
    where: { shopDomain },
    data: {
      isActive: false,
      uninstalledAt: new Date(),
    },
  });
}

/**
 * Delete store and all associated users
 */
export async function deleteStore(shopDomain: string) {
  console.log(`Deleting store: ${shopDomain}`);
  return await prisma.store.update({
    where: { shopDomain },
    data: {
      shopName: null,
      accessToken: null,
      scope: null,
      isActive: false,
      autoApproveB2BOnboarding: false,
      orderConfirmationToMainAccount: false,
      allowQuickOrderForUser: false,
      contactEmail:null,
      submissionEmail: null,
      companyWelcomeEmailTemplate: null,
      companyWelcomeEmailEnabled: false,
      themeColor: null,
      privacyPolicylink: null,
      privacyPolicyContent: null,
      deletedAt: new Date(),
    },
  });
}
