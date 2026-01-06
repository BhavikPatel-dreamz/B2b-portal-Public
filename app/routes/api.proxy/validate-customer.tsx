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

    const registrations = await prisma.registrationSubmission.findFirst({
      where: {
        OR: [
          { shopifyCustomerId: `gid://shopify/Customer/${loggedInCustomerId}` },
          { shopifyCustomerId: loggedInCustomerId },
        ],
      },
    });

    // Check if customer is logged in
    if (!loggedInCustomerId) {
      return Response.json({
        isLoggedIn: false,
        hasB2BAccess: false,
        customerStatus: registrations?.status,
        customerId: null,
        redirectTo: "/account/login",
        message: "Please log in to access the B2B portal",
      });
    }

    // Check if shop parameter exists
    if (!shop) {
      return Response.json({
        isLoggedIn: true,
        hasB2BAccess: false,
        customerId: loggedInCustomerId,
        customerStatus: registrations?.status,
        redirectTo: "/apps/b2b-portal/registration",
        message: "Shop parameter missing",
      });
    }

    // Get store from database
    const store = await getStoreByDomain(shop);

    if (!store || !store.accessToken) {
      return Response.json({
        isLoggedIn: true,
        hasB2BAccess: false,
        customerId: loggedInCustomerId,
        customerStatus: registrations?.status || "PENDING",
        redirectTo: "/apps/b2b-portal/registration",
        message: "Store not found or not configured",
      });
    }

    // Check if customer has B2B access
    // 1. First check via CompanyContact (primary method for B2B customers)
    const customerCompanyInfo = await getCustomerCompanyInfo(
      loggedInCustomerId,
      shop,
      store.accessToken,
    );

    if (
      customerCompanyInfo.hasCompany) {
      console.log("✅ Customer has B2B access via CompanyContact");
      return Response.json({
        isLoggedIn: true,
        hasB2BAccess:true,
        //  registrations?.status === "APPROVED" ? true : false,
        logo: store.logo,
        email: store.contactEmail,
        customerId: loggedInCustomerId,
        customerName: registrations?.contactName || "",
        customerStatus: registrations?.status || "PENDING",
        accessMethod: "company_contact",
        companyInfo: customerCompanyInfo,
        message: "Access granted",
      });
    }

    // 2. Fallback: Check via tags or metafields (legacy B2B setups)
    const b2bCheck = await checkCustomerIsB2BInShopifyByREST(
      shop,
      loggedInCustomerId,
      store.accessToken,
    );

    if (
      b2bCheck.success && b2bCheck.hasAccess) {
      console.log("✅ Customer has B2B access via Tags/Metafields");
      return Response.json({
        isLoggedIn: true,
        hasB2BAccess: true,
        //  registrations?.status === "APPROVED" ? true : false,
        customerId: loggedInCustomerId,
        customerStatus: registrations?.status || "PENDING",
        customerName: registrations?.contactName || "",
        logo: store.logo,
        accessMethod: "tags_metafields",
        hasTags: b2bCheck.hasTags,
        hasCompanyMetafield: b2bCheck.hasCompanyMetafield,
        tags: b2bCheck.tags,
        company: b2bCheck.company,
        message: "Access granted",
      });
    }

    // No B2B access found
    console.log("⚠️ Customer does not have B2B access");
    if (registrations?.shopifyCustomerId === loggedInCustomerId) {
      return Response.json({
        isLoggedIn: true,
        hasB2BAccess: false,
        customerStatus: registrations?.status || "PENDING",
        customerId: loggedInCustomerId,
        redirectTo: "/apps/b2b-portal/registration",
        message: "No B2B access. Please register for B2B account.",
      });
    } else {
      return Response.json({
        isLoggedIn: true,
        hasB2BAccess: false,
        customerStatus: registrations?.status,
        customerId: loggedInCustomerId,
        redirectTo: "/apps/b2b-portal/registration",
        message: "No B2B access. Please register for B2B account.",
      });
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
