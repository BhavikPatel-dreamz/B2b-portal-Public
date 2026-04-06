import { LoaderFunctionArgs } from "react-router";
import { getProxyParams } from "../../utils/proxy.server";
import { getStoreByDomain } from "../../services/store.server";
import {
  getCustomerCompanyInfo,
  checkCustomerIsB2BInShopifyByREST,
} from "app/utils/b2b-customer.server";
import prisma from "app/db.server";

/**
 * API endpoint to validate if a customer is logged in and has B2B/company access
 * This is used by the embed.js to check access before rendering the dashboard
 *
 * Checks both the registrationSubmission table and User table to determine access.
 * Users can be approved through either:
 * 1. Registration submission process (registrationSubmission table)
 * 2. Direct user creation via admin/company flows (User table)
 *
 * Returns:
 * - isLoggedIn: boolean - if customer is logged in via Shopify
 * - hasB2BAccess: boolean - if customer has B2B/company access
 * - customerId: string - Shopify customer ID
 * - redirectTo: string - where to redirect if no access
 */

// ============================================================
// 🗂️  CACHE SETUP

// ============================================================

declare global {
  var __validateCustomerCache:
    | Map<string, { data: any; timestamp: number }>
    | undefined;
}

const cache: Map<string, { data: any; timestamp: number }> =
  globalThis.__validateCustomerCache ??
  (globalThis.__validateCustomerCache = new Map());

const CACHE_TTL = 2 * 60 * 1000; // 2 min — shorter because this is an access check

// ============================================================
// 🧹 CACHE HELPERS
// ============================================================

// Call this whenever a user's access/status changes (approve, reject, disable, etc.)
export const clearValidateCustomerCache = (shop: string, customerId: string) => {
  // Try both raw and prefixed customerId formats
  const keys = [
    `validate-${shop}-${customerId}`,
    `validate-${shop}-gid://shopify/Customer/${customerId}`,
  ];
  for (const key of keys) {
    if (cache.has(key)) {
      cache.delete(key);
      console.log("🧹 Validate cache cleared for:", key);
    }
  }
};

// ============================================================
// 📦 LOADER — GET request
// ============================================================

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const startTime = Date.now();

  try {
    // shop + loggedInCustomerId are FREE — plain URL params, no auth or DB needed
    const { shop, loggedInCustomerId } = getProxyParams(request);

    console.log("🔍 Validating customer:", { shop, loggedInCustomerId });

    // ── FAST PATH — check cache before any DB or Shopify calls ──
    if (shop && loggedInCustomerId) {
      const cacheKey = `validate-${shop}-${loggedInCustomerId}`;
      const cached = cache.get(cacheKey);

      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        console.log(`⚡ Cache HIT (skipped all DB+Shopify calls) → ${cacheKey}`);
        console.log(`🚀 Total API Time: ${Date.now() - startTime}ms`);
        return Response.json(cached.data);
      }
    }

    console.log("🐢 Cache MISS → running full validation");

    // Helper to cache a result and return it
    // Only cache positive access grants + stable negative states (APPROVED, REJECTED, DISABLED)
    // Do NOT cache transient states (PENDING) so status changes reflect quickly
    const respond = (data: object, shouldCache = false) => {
      if (shop && loggedInCustomerId && shouldCache) {
        const cacheKey = `validate-${shop}-${loggedInCustomerId}`;
        cache.set(cacheKey, { data, timestamp: Date.now() });
        console.log(`✅ Cache SET → ${cacheKey}`);
      }
      return Response.json(data);
    };

    // ── STEP 1: Check if customer is logged in ──────────────
    if (!loggedInCustomerId) {
      // Not logged in — always fast, no need to cache
      return Response.json({
        isLoggedIn: false,
        hasB2BAccess: false,
        customerStatus: null,
        customerId: null,
        redirectTo: "/account/login",
        message: "Please log in to access the B2B portal",
      });
    }

    // ── STEP 2: Check if shop parameter exists ──────────────
    if (!shop) {
      return Response.json({
        isLoggedIn: true,
        hasB2BAccess: false,
        customerId: loggedInCustomerId,
        customerStatus: null,
        redirectTo: "/apps/b2b-portal/registration",
        message: "Shop parameter missing",
      });
    }

    // ── STEP 3: Get store from database ─────────────────────
    const store = await getStoreByDomain(shop);

    if (!store || !store.accessToken) {
      return Response.json({
        isLoggedIn: true,
        hasB2BAccess: false,
        customerId: loggedInCustomerId,
        customerStatus: null,
        redirectTo: "/apps/b2b-portal/registration",
        message: "Store not found or not configured",
      });
    }

    // ── STEP 4: Check user status in our database ───────────
    const [registration, user] = await Promise.all([
      prisma.registrationSubmission.findFirst({
        where: {
          OR: [
            { shopifyCustomerId: `gid://shopify/Customer/${loggedInCustomerId}` },
            { shopifyCustomerId: loggedInCustomerId },
          ],
        },
      }),
      prisma.user.findFirst({
        where: {
          OR: [
            { shopifyCustomerId: `gid://shopify/Customer/${loggedInCustomerId}` },
            { shopifyCustomerId: loggedInCustomerId },
          ],
          shopId: store.id,
        },
        include: { company: true },
      }),
    ]);

    // ── STEP 5: Check if customer has B2B access in Shopify ─
    const customerCompanyInfo = await getCustomerCompanyInfo(
      loggedInCustomerId,
      shop,
      store.accessToken,
    );

    let hasB2BInShopify = false;
    let accessMethod = "";

    interface AdditionalInfo {
      [key: string]: string | number | boolean | null | object | undefined;
    }
    let additionalInfo: AdditionalInfo = {};

    if (customerCompanyInfo.hasCompany) {
      console.log("✅ Customer has B2B access via CompanyContact");
      hasB2BInShopify = true;
      accessMethod = "company_contact";
      additionalInfo = { companyInfo: customerCompanyInfo };
    } else {
      // Fallback: check via tags or metafields (legacy B2B setups)
      const b2bCheck = await checkCustomerIsB2BInShopifyByREST(
        shop,
        loggedInCustomerId,
        store.accessToken,
      );

      if (b2bCheck.success && b2bCheck.hasAccess) {
        console.log("✅ Customer has B2B access via Tags/Metafields");
        hasB2BInShopify = true;
        accessMethod = "tags_metafields";
        additionalInfo = {
          hasTags: b2bCheck.hasTags,
          hasCompanyMetafield: b2bCheck.hasCompanyMetafield,
          tags: b2bCheck.tags,
          company: b2bCheck.company,
        };
      }
    }

    // ── STEP 6: Check if user is disabled ───────────────────
    if (registration?.isDisable === true) {
      const customerName =
        `${registration?.firstName || ""} ${registration?.lastName || ""}`.trim() ||
        (user ? `${user.firstName || ""} ${user.lastName || ""}`.trim() : "");

      // ✅ Cache — disabled state is stable, won't flip without admin action
      return respond(
        {
          isLoggedIn: true,
          hasB2BAccess: false,
          customerId: loggedInCustomerId,
          customerName,
          isDisable: registration?.isDisable,
          customerStatus: registration?.status || user?.status || null,
          redirectTo: "/apps/b2b-portal/registration",
          message: "Your company account has been deactivated. Please contact the support team.",
          alreadySubmitted: true,
        },
        true, // cache it
      );
    }

    // ── STEP 7: Determine access ─────────────────────────────
    if (hasB2BInShopify) {
      const isApprovedViaRegistration = registration?.status === "APPROVED";
      const isApprovedViaUser = user?.status === "APPROVED" && user.isActive;

      if (isApprovedViaRegistration || isApprovedViaUser) {
        const customerName =
          `${registration?.firstName || ""} ${registration?.lastName || ""}`.trim() ||
          (user ? `${user.firstName || ""} ${user.lastName || ""}`.trim() : "");

        // ✅ Cache — approved access is stable
        return respond(
          {
            isLoggedIn: true,
            hasB2BAccess: true,
            logo: store.logo,
            email: store.contactEmail,
            storeName: store.shopName,
            themeColor: store.themeColor,
            customerId: loggedInCustomerId,
            customerName,
            customerStatus: isApprovedViaRegistration
              ? registration.status
              : user?.status,
            accessMethod,
            ...additionalInfo,
            message: "Access granted",
          },
          true, // cache it
        );
      }

      // Exists but not approved (PENDING) — don't cache, status may change soon
      if (registration || user) {
        const status = registration?.status || user?.status;
        const customerName =
          `${registration?.firstName || ""} ${registration?.lastName || ""}`.trim() ||
          (user ? `${user.firstName || ""} ${user.lastName || ""}`.trim() : "");

        return respond({
          isLoggedIn: true,
          hasB2BAccess: false,
          customerId: loggedInCustomerId,
          customerName,
          customerStatus: status,
          redirectTo: "/apps/b2b-portal/registration",
          message: "Your account exists but is not approved yet",
          alreadySubmitted: true,
        });
        // ❌ not cached — PENDING status changes frequently
      }

      // No registration and no user record
      console.log("⚠️ Customer has B2B in Shopify but not registered in our database");
      return respond({
        isLoggedIn: true,
        hasB2BAccess: false,
        customerId: loggedInCustomerId,
        customerStatus: null,
        redirectTo: "/apps/b2b-portal/registration",
        message: "Please complete registration to access the B2B portal",
      });
      // ❌ not cached — they might register any second
    } else {
      // No B2B access in Shopify
      console.log("⚠️ Customer does not have B2B access in Shopify");

      if (registration || user) {
        const status = registration?.status || user?.status;
        const customerName =
          `${registration?.firstName || ""} ${registration?.lastName || ""}`.trim() ||
          (user ? `${user.firstName || ""} ${user.lastName || ""}`.trim() : "");

        let message = "Your account has already been submitted and is under review";

        if (status === "APPROVED") {
          message = "Your account is approved, but B2B access is not yet configured in Shopify.";
        } else if (status === "REJECTED") {
          message = "Your account has been rejected. Please contact the support team.";
        }

        // ✅ Cache REJECTED (stable). Don't cache PENDING/APPROVED (may change soon).
        const isStableState = status === "REJECTED";

        return respond(
          {
            isLoggedIn: true,
            hasB2BAccess: false,
            customerStatus: status,
            customerId: loggedInCustomerId,
            customerName,
            redirectTo: "/apps/b2b-portal/registration",
            message,
            alreadySubmitted: true,
          },
          isStableState,
        );
      }

      // No registration and no B2B access
      return respond({
        isLoggedIn: true,
        hasB2BAccess: false,
        customerStatus: null,
        customerId: loggedInCustomerId,
        redirectTo: "/apps/b2b-portal/registration",
        message: "No B2B access. Please register for B2B account.",
      });
      // ❌ not cached — they might register any second
    }
  } catch (error) {
    console.error("❌ Error validating customer:", error);
    return Response.json(
      {
        isLoggedIn: false,
        hasB2BAccess: false,
        customerId: null,
        redirectTo: "/apps/b2b-portal/registration",
        message: "Error validating customer access",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  } finally {
    console.log(`🚀 Total API Time: ${Date.now() - startTime}ms`);
  }
};