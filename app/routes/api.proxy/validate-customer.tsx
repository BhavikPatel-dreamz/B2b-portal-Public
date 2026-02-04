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
export const loader = async ({ request }: LoaderFunctionArgs) => { 
  try {
    // Get proxy parameters
    const { shop, loggedInCustomerId } = getProxyParams(request);

    console.log("🔍 Validating customer:=", { shop, loggedInCustomerId });

    // STEP 1: Check if customer is logged in
    if (!loggedInCustomerId) {
      return Response.json({
        isLoggedIn: false,
        hasB2BAccess: false,
        customerStatus: null,
        customerId: null,
        redirectTo: "/account/login",
        message: "Please log in to access the B2B portal",
      });
    }

    // STEP 2: Check if shop parameter exists
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

    // STEP 3: Get store from database
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

    // STEP 4: Check user status in our database
    // Check both registrationSubmission table and User table
    const [registration, user] = await Promise.all([
      prisma.registrationSubmission.findFirst({
        where: {
          OR: [
            {
              shopifyCustomerId: `gid://shopify/Customer/${loggedInCustomerId}`,
            },
            { shopifyCustomerId: loggedInCustomerId },
          ],
        },
      }),
      prisma.user.findFirst({
        where: {
          OR: [
            {
              shopifyCustomerId: `gid://shopify/Customer/${loggedInCustomerId}`,
            },
            { shopifyCustomerId: loggedInCustomerId },
          ],
          shopId: store.id,
        },
        include: {
          company: true,
        },
      }),
    ]);

    // STEP 5: Check if customer has B2B access in Shopify
    // 5a. First check via CompanyContact (primary method for B2B customers)
    const customerCompanyInfo = await getCustomerCompanyInfo(
      loggedInCustomerId,
      shop,
      store.accessToken,
    );
 
    let hasB2BInShopify = false;
    let accessMethod = "";
    // If you know what properties might be in additionalInfo
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
      // 5b. Fallback: Check via tags or metafields (legacy B2B setups)
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

    // STEP 6: Check if user is disabled FIRST (before any other checks)
    if (registration?.isDisable === true) {
      const customerName =
        registration?.contactName ||
        (user ? `${user.firstName || ""} ${user.lastName || ""}`.trim() : "");

      return Response.json({
        isLoggedIn: true,
        hasB2BAccess: false,
        customerId: loggedInCustomerId,
        customerName,
        isDisable: registration?.isDisable,
        customerStatus: registration?.status || user?.status || null,
        redirectTo: "/apps/b2b-portal/registration",
        message:
          "Your company account has been deactivated. Please contact the support team.",
        alreadySubmitted: true,
      });
    }

    // STEP 7: Determine access based on B2B status, registration, and user records
    if (hasB2BInShopify) {
      // User is part of a company in Shopify

      // Check if user has approved access in either registration or user table
      const isApprovedViaRegistration = registration?.status === "APPROVED";
      const isApprovedViaUser = user?.status === "APPROVED" && user.isActive;

      if (isApprovedViaRegistration || isApprovedViaUser) {
        const customerName =
          registration?.contactName ||
          (user ? `${user.firstName || ""} ${user.lastName || ""}`.trim() : "");

        return Response.json({
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
        });
      }

      // EXISTS BUT NOT APPROVED
      if (registration || user) {
        const status = registration?.status || user?.status;
        const customerName =
          registration?.contactName ||
          (user ? `${user.firstName || ""} ${user.lastName || ""}`.trim() : "");

        return Response.json({
          isLoggedIn: true,
          hasB2BAccess: false,
          customerId: loggedInCustomerId,
          customerName,
          customerStatus: status,
          redirectTo: "/apps/b2b-portal/registration",
          message: "Your account exists but is not approved yet",
          alreadySubmitted: true,
        });
      }

      // No registration and no user record - redirect to register
      console.log(
        "⚠️ Customer has B2B in Shopify but not registered in our database",
      );
      return Response.json({
        isLoggedIn: true,
        hasB2BAccess: false,
        customerId: loggedInCustomerId,
        customerStatus: null,
        redirectTo: "/apps/b2b-portal/registration",
        message: "Please complete registration to access the B2B portal",
      });
    } else {
      // No B2B access in Shopify
      console.log("⚠️ Customer does not have B2B access in Shopify");

      if (registration || user) {
        // Has registration or user record but no B2B access in Shopify
        const status = registration?.status || user?.status;
        const customerName =
          registration?.contactName ||
          (user ? `${user.firstName || ""} ${user.lastName || ""}`.trim() : "");

        let message =
          "Your account has already been submitted and is under review";

        if (status === "APPROVED") {
          message =
            "Your account is approved, but B2B access is not yet configured in Shopify.";
        } else if (status === "REJECTED") {
          message =
            "Your account has been rejected. Please contact the support team.";
        }

        return Response.json({
          isLoggedIn: true,
          hasB2BAccess: false,
          customerStatus: status,
          customerId: loggedInCustomerId,
          customerName,
          redirectTo: "/apps/b2b-portal/registration",
          message,
          alreadySubmitted: true,
        });
      } else {
        // No registration and no B2B access - redirect to register
        return Response.json({
          isLoggedIn: true,
          hasB2BAccess: false,
          customerStatus: null,
          customerId: loggedInCustomerId,
          redirectTo: "/apps/b2b-portal/registration",
          message: "No B2B access. Please register for B2B account.",
        });
      }
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
  }
};
