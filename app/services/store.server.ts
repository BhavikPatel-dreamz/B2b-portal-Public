import prisma from "../db.server";
import { FREE_PLAN, PAID_PLAN, PLAN_99 } from "../billing-plans.shared";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { registerCartValidationFunction } from "./cartValidationRegistration.server";

export interface CreateStoreInput {
  shopDomain: string;
  shopName?: string;
  accessToken?: string;
  scope?: string;
  currencyCode?: string;
  contactEmail?: string;
  storeOwnerName?: string | null;
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
  invoiceTemplate?: string | null;
  companyWelcomeEmailEnabled?: boolean;
  contactEmail?: string | null;
  themeColor?: string | null;
  autoApproveB2BOnboarding?: boolean;
  defaultCompanyCreditLimit?: number | string | null;
  orderConfirmationToMainAccount?: boolean;
  allowQuickOrderForUser?: boolean;
  blockOrderWhenCreditUnavailable?: boolean;
  showDashboardPage?: boolean;
  showLocationsPage?: boolean;
  showUsersPage?: boolean;
  showOrdersPage?: boolean;
  showQuickOrderPage?: boolean;
  showWishlistsPage?: boolean;
  showCreditManagementPage?: boolean;
  showNotificationsPage?: boolean;
  showReportsPage?: boolean;
  privacyPolicylink?: string | null;
  privacyPolicyContent?: string | null;
  defaultTaxRate?: number | string | null;
}

/**
 * Create or update a store (upsert on install)
 */
export async function upsertStore(data: CreateStoreInput) {
  const updateData: any = {
    isActive: true,
    uninstalledAt: null,
    updatedAt: new Date(),
  };

  if (data.shopName !== undefined) updateData.shopName = data.shopName;
  if (data.accessToken !== undefined) updateData.accessToken = data.accessToken;
  if (data.scope !== undefined) updateData.scope = data.scope;
  if (data.currencyCode !== undefined)
    updateData.currencyCode = data.currencyCode;
  if (data.contactEmail !== undefined)
    updateData.contactEmail = data.contactEmail;
  if (data.storeOwnerName !== undefined)
    updateData.storeOwnerName = data.storeOwnerName;

  return await prisma.store.upsert({
    where: { shopDomain: data.shopDomain },
    create: {
      shopDomain: data.shopDomain,
      shopName: data.shopName,
      accessToken: data.accessToken,
      scope: data.scope,
      currencyCode: data.currencyCode,
      contactEmail: data.contactEmail,
      storeOwnerName: data.storeOwnerName,
      themeColor: "#0f172a",
    },
    update: updateData,
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

export function getStorePlanValue(subscriptionName?: string | null) {
  if (subscriptionName === FREE_PLAN) {
    return "free";
  }

  if (subscriptionName === PAID_PLAN || subscriptionName === PLAN_99) {
    return "approved payment";
  }

  return null;
}

type AppSubscriptionSummary = {
  id?: string | null;
  name?: string | null;
  status?: string | null;
};

/**
 * Update smartb2b shop metafields used by checkout validation
 */
export async function setShopValidationMetafields(
  admin: AdminApiContext,
  {
    enabled,
    blockOrderWhenCreditUnavailable = false,
  }: {
    enabled: boolean;
    blockOrderWhenCreditUnavailable?: boolean;
  },
) {
  try {
    // 1. Get Shop ID
    const shopRes = await admin.graphql(`
      query {
        shop {
          id
        }
      }
    `);
    const shopData = await shopRes.json();
    const shopId = shopData.data?.shop?.id;

    if (!shopId) {
      console.error("❌ Could not fetch Shop ID to set metafield");
      return;
    }

    // 2. Set Metafield
    console.log(
      `🏷️ Setting validation metafields (enabled: ${enabled}, blockOrderWhenCreditUnavailable: ${blockOrderWhenCreditUnavailable}) for ${shopId}`,
    );
    const metafieldRes = await admin.graphql(
      `
      mutation SetMetafield($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            key
            value
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
      {
        variables: {
          metafields: [
            {
              namespace: "smartb2b",
              key: "validation_enabled",
              type: "single_line_text_field",
              value: enabled ? "true" : "false",
              ownerId: shopId,
            },
            {
              namespace: "smartb2b",
              key: "block_orders_when_credit_unavailable",
              type: "single_line_text_field",
              value: blockOrderWhenCreditUnavailable ? "true" : "false",
              ownerId: shopId,
            },
          ],
        },
      },
    );

    const metafieldData = await metafieldRes.json();
    if (metafieldData.data?.metafieldsSet?.userErrors?.length > 0) {
      console.error(
        "❌ Error setting shop metafield:",
        metafieldData.data.metafieldsSet.userErrors[0].message,
      );
    } else {
      console.log("✅ Shop validation metafields updated");
    }
  } catch (error) {
    console.error("❌ Exception setting shop metafield:", error);
  }
}

/**
 * Sync payment terms for all companies in a store based on the plan
 * If plan is paid, restore terms from DB to Shopify
 * If plan is free, nullify terms in Shopify but keep them in DB
 */
export async function syncStorePaymentTerms(
  storeId: string,
  admin: AdminApiContext,
  isPaid: boolean,
) {
  const companies = await prisma.companyAccount.findMany({
    where: { shopId: storeId },
    select: { shopifyCompanyId: true, paymentTerm: true },
  });

  for (const company of companies) {
    if (!company.shopifyCompanyId) continue;

    try {
      // Fetch locations for each company
      const locationRes = await admin.graphql(
        `#graphql
        query getCompanyLocations($companyId: ID!) {
          company(id: $companyId) {
            locations(first: 50) {
              edges {
                node {
                  id
                }
              }
            }
          }
        }`,
        { variables: { companyId: company.shopifyCompanyId } },
      );

      const locationJson = await locationRes.json();
      const locations = locationJson.data?.company?.locations?.edges || [];

      // Determine what to set in Shopify
      // If paid, use the stored paymentTerm from DB. If free, use null.
      const targetPaymentTerm = isPaid ? company.paymentTerm || null : null;

      for (const edge of locations) {
        const locationId = edge.node.id;
        await admin.graphql(
          `#graphql
          mutation UpdateCompanyLocation($companyLocationId: ID!, $paymentTermsTemplateId: ID) {
            companyLocationUpdate(
              companyLocationId: $companyLocationId
              input: {
                buyerExperienceConfiguration: {
                  paymentTermsTemplateId: $paymentTermsTemplateId
                }
              }
            ) {
              userErrors { field message }
            }
          }`,
          {
            variables: {
              companyLocationId: locationId,
              paymentTermsTemplateId: targetPaymentTerm,
            },
          },
        );
      }
    } catch (error) {
      console.error(
        `Error syncing Shopify payment terms for company ${company.shopifyCompanyId}:`,
        error,
      );
    }
  }
}

export async function syncStoreSubscriptionState(
  shopDomain: string,
  appSubscriptions: AppSubscriptionSummary[] = [],
  admin?: AdminApiContext,
) {
  const activeSubscription =
    appSubscriptions.find((subscription) => subscription.status === "ACTIVE") ||
    null;

  // For Shopify's Paid subscription, we need to check if it's Plan 99 or regular paid
  // Store the subscription name directly to preserve tier information
  const plan = activeSubscription?.name ? activeSubscription.name : "free";
  const isPaid = plan === PAID_PLAN || plan === PLAN_99;

  const store = await prisma.store.findUnique({
    where: { shopDomain },
    select: { id: true },
  });

  const updatedStore = await prisma.store.updateMany({
    where: { shopDomain },
    data: {
      plan: plan,
      planKey: activeSubscription?.id ?? null,
      updatedAt: new Date(),
    },
  });

  // Always ensure cart validation is registered and set the metafield based on the plan
  if (admin && store) {
    console.log(
      `🔄 Syncing store plan (${plan}) and updating cart validation...`,
    );
    await registerCartValidationFunction(admin);
    const currentStore = await prisma.store.findUnique({
      where: { shopDomain },
      select: { blockOrderWhenCreditUnavailable: true },
    });
    await setShopValidationMetafields(admin, {
      enabled: isPaid,
      blockOrderWhenCreditUnavailable:
        currentStore?.blockOrderWhenCreditUnavailable ?? false,
    });

    // Sync payment terms visibility in Shopify
    console.log(
      `🔄 Syncing payment terms visibility for ${shopDomain} (isPaid: ${isPaid})...`,
    );
    await syncStorePaymentTerms(store.id, admin, isPaid);
  }

  return updatedStore;
}

/**
 * Fast version of syncStoreSubscriptionState that only updates the database
 * Used during redirects to avoid blocking the UI with Shopify API calls
 */
export async function syncStoreSubscriptionStateFast(
  shopDomain: string,
  appSubscriptions: AppSubscriptionSummary[] = [],
) {
  const activeSubscription =
    appSubscriptions.find((subscription) => subscription.status === "ACTIVE") ||
    null;

  // Store the subscription name directly to preserve tier information (PAID_PLAN vs PLAN_99)
  const plan = activeSubscription?.name ? activeSubscription.name : "free";

  const updatedStore = await prisma.store.updateMany({
    where: { shopDomain },
    data: {
      plan: plan,
      planKey: activeSubscription?.id ?? null,
      updatedAt: new Date(),
    },
  });

  console.log(`⚡ Fast sync: Updated store ${shopDomain} plan to ${plan}`);

  return updatedStore;
}

export async function setStoreFreePlan(
  shopDomain: string,
  admin?: AdminApiContext,
) {
  const store = await prisma.store.findUnique({
    where: { shopDomain },
    select: { id: true },
  });

  if (store) {
    // Update Shopify if admin client is provided
    if (admin) {
      // Ensure cart validation is registered but disabled on free plan
      console.log(
        `🧹 Store ${shopDomain} set to free plan, ensuring cart validation is registered but disabled...`,
      );
      await registerCartValidationFunction(admin);
      await setShopValidationMetafields(admin, {
        enabled: false,
        blockOrderWhenCreditUnavailable: false,
      });

      // Hide payment terms in Shopify but keep in DB
      console.log(
        `🧹 Hiding payment terms in Shopify for store ${shopDomain}...`,
      );
      await syncStorePaymentTerms(store.id, admin, false);
    }
  }

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
 * Mark store as uninstalled and cleanup company data
 */
export async function uninstallStore(shopDomain: string) {
  const store = await prisma.store.findUnique({
    where: { shopDomain },
    select: { id: true },
  });

  if (store) {
    console.log(`Cleaning up all data for store: ${shopDomain} (${store.id})`);

    // Comprehensive cleanup of all shop-related data
    // Cascading deletes handle related records, but we'll be explicit for core data
    await prisma.$transaction([
      // Delete all credit transactions
      prisma.creditTransaction.deleteMany({
        where: { company: { shopId: store.id } },
      }),

      // Delete all company accounts (this also deletes approved users linked to them)
      prisma.companyAccount.deleteMany({ where: { shopId: store.id } }),

      // Delete ONLY approved users (Pending/Rejected stay as requested)
      prisma.user.deleteMany({
        where: {
          shopId: store.id,
          status: "APPROVED",
        },
      }),

      // Delete ONLY approved registration submissions (Pending/Rejected stay as requested)
      prisma.registrationSubmission.deleteMany({
        where: {
          shopId: store.id,
          status: "APPROVED",
        },
      }),

      prisma.notification.deleteMany({ where: { shopId: store.id } }),
      prisma.wishlist.deleteMany({ where: { shop: shopDomain } }),
      prisma.formFieldConfig.deleteMany({ where: { shopId: store.id } }),
      prisma.b2BOrder.deleteMany({ where: { shopId: store.id } }),
      
      // Reset all email notification toggles
      prisma.emailTemplates.updateMany({
        where: { shopId: store.id },
        data: {
          customerRegistration: false,
          customerRegistrationApproved: false,
          customerRegistrationRejected: false,
          adminRequest: false,
        },
      }),
    ]);
  }

  return await prisma.store.update({
    where: { shopDomain },
    data: {
      isActive: false,
      uninstalledAt: new Date(),
      setupFinished: false,
      completedSetupSteps: [],
      autoApproveB2BOnboarding: false,
      orderConfirmationToMainAccount: false,
      allowQuickOrderForUser: false,
      blockOrderWhenCreditUnavailable: false,
      companyWelcomeEmailEnabled: false,
      smtpSecure: false,
      contactEmail: "",
      submissionEmail: "",
      smtpFromEmail: "",
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
      setupFinished: false,
      completedSetupSteps: [],
      autoApproveB2BOnboarding: false,
      orderConfirmationToMainAccount: false,
      allowQuickOrderForUser: false,
      blockOrderWhenCreditUnavailable: false,
      contactEmail: null,
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
