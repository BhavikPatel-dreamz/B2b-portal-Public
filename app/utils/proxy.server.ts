import { redirect } from "react-router";
import { getStoreByDomain } from "../services/store.server";
import { checkCustomerIsB2BInShopifyByREST, getCustomerCompanyInfo } from "./b2b-customer.server";

/**
 * Gets proxy parameters from the request URL
 * @param request - The incoming request object
 * @returns Object containing shop, pathPrefix, timestamp, signature, and loggedInCustomerId
 */
export function getProxyParams(request: Request) {
  const url = new URL(request.url);

  return {
    shop: url.searchParams.get("shop"),
    pathPrefix: url.searchParams.get("path_prefix"),
    timestamp: url.searchParams.get("timestamp"),
    signature: url.searchParams.get("signature"),
    loggedInCustomerId: url.searchParams.get("logged_in_customer_id"),
  };
}

/**
 * Logs proxy request details for debugging
 * @param request - The incoming request object
 */
export function logProxyRequest(request: Request) {
  const params = getProxyParams(request);

  console.log("=== App Proxy Request ===");
  console.log("Shop:", params.shop);
  console.log("Path Prefix:", params.pathPrefix);
  console.log("Timestamp:", params.timestamp);
  console.log("Signature:", params.signature);
  console.log("Logged in customer:", params.loggedInCustomerId);
  console.log("Full URL:", request.url);
  console.log("========================");
}

/**
 * Validates that a customer is logged in via Shopify proxy
 * Checks for the logged_in_customer_id parameter from Shopify
 *
 * @param request - The incoming request object
 * @throws redirect to /login if customer is not logged in
 * @returns The logged in customer ID
 */
export async function requireLoggedInCustomer(request: Request): Promise<string> {
  console.log("✅ Checking customer login status");

  const url = new URL(request.url);
  const loggedInCustomerId = url.searchParams.get("logged_in_customer_id");

  if (!loggedInCustomerId) {
    console.log("⚠️ No logged_in_customer_id found, redirecting to login");
    throw redirect("/login");
  }

  console.log("✅ Customer logged in:", loggedInCustomerId);

  // Note: For B2B access validation (checking tags, company access, etc.),
  // use the functions from b2b-customer.server.ts in your route handlers

  return loggedInCustomerId;
}

/**
 * Complete B2B customer validation for proxy routes
 * This function handles all validation steps:
 * 1. Checks if customer is logged in
 * 2. Gets shop parameters
 * 3. Fetches store from database
 * 4. Checks Shopify directly for B2B access (tags + company metafield)
 * 5. Redirects to registration if no B2B access
 *
 * @param request - The incoming request object
 * @throws redirect to /login if not logged in
 * @throws redirect to /apps/b2b-portal/registration if no B2B access
 * @returns Object containing customerId and shop
 */
export async function validateB2BCustomerAccess(request: Request): Promise<{
  customerId: string;
  shop: string;
}> {
  // Step 1: Require customer to be logged in
  const customerId = await requireLoggedInCustomer(request);

  // Step 2: Get proxy parameters
  const { shop } = getProxyParams(request);

  if (!shop) {
    console.error("⚠️ No shop parameter found");
    throw redirect("/login");
  }

  // Step 3: Check Shopify directly for B2B access (company or B2B tags)
  const store = await getStoreByDomain(shop);

  if (store && store.accessToken) {

    //console.log("✅ Store found:", store);

    // 1. Check B2B access using GraphQL (CompanyContact association)
    // This is the primary method for B2B customers
    const customerCompanyInfo = await getCustomerCompanyInfo(customerId, shop, store.accessToken);
    ///console.log("Customer company info:", JSON.stringify(customerCompanyInfo, null, 2));

    if (customerCompanyInfo.hasCompany) {
      console.log("✅ Customer has B2B access via CompanyContact!");
      return { customerId, shop };
    }

    // 2. Fallback: Check Shopify directly using REST API (Tags or Metafields)
    // This supports legacy B2B setups or tag-based access
    const b2bCheck = await checkCustomerIsB2BInShopifyByREST(
      shop,
      customerId,
      store.accessToken
    );

    if (b2bCheck.success) {
      if (!b2bCheck.hasAccess) {
        console.log("⚠️ Customer does not have B2B access in Shopify (No CompanyContact, Tags, or Metafields)");
        console.log("  - Has B2B tags:", b2bCheck.hasTags);
        console.log("  - Has company metafield:", b2bCheck.hasCompanyMetafield);
        // Redirect to registration if no B2B access
        throw redirect("/apps/b2b-portal/registration");
      }

      console.log("✅ Customer has B2B access via Tags/Metafields!");
      console.log("  - Company:", b2bCheck.company);
      console.log("  - Tags:", b2bCheck.tags);
    } else {
      console.error("❌ Error checking B2B status:", b2bCheck.error);
      // Redirect on error to be safe
      throw redirect("/apps/b2b-portal/registration");
    }
  } else {
    console.error("⚠️ Store not found or no access token available");
    throw redirect("/apps/b2b-portal/registration");
  }

  return { customerId, shop };
}

/**
 * Validates that the current user is a Company Admin or Owner
 * This function:
 * 1. Validates basic B2B access
 * 2. Checks if the user is a Main Contact (Owner) or has Admin role
 *
 * @param request - The incoming request object
 * @throws redirect to /apps/b2b-portal/dashboard if not authorized
 * @returns Object containing customerId, shop, store, and companyInfo
 */
export async function validateCompanyAdminAccess(request: Request) {
  // Step 1: Validate basic B2B access
  const { customerId, shop } = await validateB2BCustomerAccess(request);

  // Step 2: Get store and access token
  const store = await getStoreByDomain(shop);
  if (!store || !store.accessToken) {
    console.error("⚠️ Store not found or no access token available during admin check");
    throw redirect("/login");
  }

  // Step 3: Get customer company info
  const companyInfo = await getCustomerCompanyInfo(customerId, shop, store.accessToken);

  if (!companyInfo.hasCompany) {
    console.log("⚠️ Customer has no company association");
    throw redirect("/apps/b2b-portal/dashboard");
  }

  // Step 4: Check if user is authorized (Main Contact or Admin)
  interface CompanyData { mainContact?: { id: string }; isAdmin?: boolean }
  const isCompanyOwner = companyInfo.companies.some((c: CompanyData) => c.mainContact?.id === `gid://shopify/Customer/${customerId}`);
  const isAdmin = companyInfo.companies.some((c: CompanyData) => c.isAdmin);

  if (!isCompanyOwner && !isAdmin) {
    console.log("⚠️ User is not a Company Admin or Owner");
    throw redirect("/apps/b2b-portal/dashboard");
  }

  return {
    customerId,
    shop,
    store,
    companyInfo,
    isCompanyOwner,
    isAdmin
  };
}

/**
 * Authenticates API proxy requests with full B2B validation
 * This middleware function:
 * 1. Validates Shopify app proxy authentication
 * 2. Validates customer is logged in
 * 3. Validates customer has B2B/company access
 * 4. Returns all necessary data for API operations
 *
 * Use this for ALL API proxy routes to ensure only authenticated B2B customers can access them
 *
 * @param request - The incoming request object
 * @throws Response with 401 if not authenticated
 * @throws Response with 403 if no B2B access
 * @throws Response with 404 if store not found
 * @returns Object containing customerId, shop, store, and companyInfo
 */
export async function authenticateApiProxyRequest(request: Request) {
  try {
    // Step 1: Authenticate Shopify app proxy (validates request comes from Shopify)
    const { authenticate } = await import("../shopify.server");
    await authenticate.public.appProxy(request);

    // Step 2: Get proxy parameters
    const url = new URL(request.url);
    const customerId = url.searchParams.get("logged_in_customer_id");
    const shop = url.searchParams.get("shop");

    // Step 3: Validate customer is logged in
    if (!customerId) {
      throw Response.json(
        { error: "Authentication required. Please log in to access this API." },
        { status: 401 }
      );
    }

    // Step 4: Validate shop parameter
    if (!shop) {
      throw Response.json(
        { error: "Shop parameter is required" },
        { status: 400 }
      );
    }

    // Step 5: Get store from database
    const store = await getStoreByDomain(shop);
    if (!store || !store.accessToken) {
      throw Response.json(
        { error: "Store not found or unauthorized" },
        { status: 404 }
      );
    }

    // Step 6: Validate customer has B2B/company access
    const companyInfo = await getCustomerCompanyInfo(
      customerId,
      shop,
      store.accessToken
    );

    if (!companyInfo.hasCompany || !companyInfo.companies || companyInfo.companies.length === 0) {
      // Customer is logged in but doesn't have B2B access
      throw Response.json(
        {
          error: "B2B access required. Please contact your administrator.",
          hasAccess: false
        },
        { status: 403 }
      );
    }

    // Success - return all necessary data
    return {
      customerId,
      shop,
      store,
      companyInfo,
      companyId: companyInfo.companies[0].companyId,
    };
  } catch (error) {
    // If error is already a Response, re-throw it
    if (error instanceof Response) {
      throw error;
    }

    // Otherwise, wrap in a 500 error
    console.error("❌ API authentication error:", error);
    throw Response.json(
      {
        error: "Authentication failed",
        details: error instanceof Error ? error.message : "Unknown error"
      },
      { status: 500 }
    );
  }
}

/**
 * Authenticates API proxy requests with full B2B validation AND user context with permissions
 * This enhanced middleware function:
 * 1. Performs all authenticateApiProxyRequest checks
 * 2. Fetches user context with roles and permissions
 * 3. Returns user context for permission-based access control
 *
 * Use this for API proxy routes that need role/permission-based access control
 *
 * @param request - The incoming request object
 * @throws Response with 401 if not authenticated
 * @throws Response with 403 if no B2B access or permission denied
 * @throws Response with 404 if store not found
 * @returns Object containing customerId, shop, store, companyInfo, and userContext
 */
export async function authenticateApiProxyWithPermissions(request: Request) {
  // First, do standard authentication
  const authData = await authenticateApiProxyRequest(request);

  // Import permission utilities
  const { getUserContext } = await import("./permissions.server");

  // Ensure accessToken exists
  if (!authData.store.accessToken) {
    throw Response.json(
      { error: "Store access token not available" },
      { status: 500 }
    );
  }

  // Get user context with permissions
  const userContext = await getUserContext(
    authData.customerId,
    authData.shop,
    authData.store.accessToken
  );

  return {
    ...authData,
    userContext,
  };
}
