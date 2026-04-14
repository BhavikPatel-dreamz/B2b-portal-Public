import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticateApiProxyWithPermissions } from "../../utils/proxy.server";
import { requirePermission } from "../../utils/permissions.server";
import {
  getCompanyCustomers,
  createCompanyCustomer,
  getCompanyRoles,
  getCompanyLocations,
  updateCompanyCustomer,
  deleteCompanyCustomer,
  getCompanyContactEmail,
} from "../../utils/b2b-customer.server";
import prisma from "app/db.server";
import { sendEmployeeAssignmentEmail } from "app/utils/email";

/**
 * API Proxy Route for User Management
 *
 * Endpoints:
 * - GET: List users with pagination
 * - POST: Create, Edit, Delete users based on action type
 *
 * Access via: /apps/b2b-portal/api/proxy/usermanagement
 *
 * Required Permission: canManageUsers
 * Allowed Roles: Company Admin, Main Contact
 */


// ============================================================
// 🗂️  CACHE SETUP 

// ============================================================

declare global {
  // Layer 1 — maps "shop+customerId" → companyId  (so we never call Shopify just for the key)
  var __companyIdCache:
    | Map<string, { companyId: string; timestamp: number }>
    | undefined;

  // Layer 2 — maps the full cache key → actual API response data
  var __companyUsersCache:
    | Map<string, { data: any; timestamp: number }>
    | undefined;
}

// Layer 1 — companyId lookup (10 min TTL)
const companyIdCache: Map<string, { companyId: string; timestamp: number }> =
  globalThis.__companyIdCache ??
  (globalThis.__companyIdCache = new Map());

// Layer 2 — response data (5 min TTL)
const cache: Map<string, { data: any; timestamp: number }> =
  globalThis.__companyUsersCache ??
  (globalThis.__companyUsersCache = new Map());

const CACHE_TTL = 5 * 60 * 1000;        // 5 min  — response data
const COMPANY_ID_TTL = 10 * 60 * 1000;  // 10 min — companyId lookup

// ============================================================
// 🧹 CACHE HELPERS
// ============================================================

export const clearCompanyUsersCache = (shop: string, companyId: string) => {
  const prefix = `company-users-${shop}-${companyId}`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
  console.log("🧹 Cache cleared for:", prefix);
};

// Builds the full data cache key (used in both fast-path and slow-path)
function buildCacheKey(
  shop: string,
  companyId: string,
  action: string | null,
  after: string,
  sortParam: string,
  query: string,
) {
  return action === "roles" || action === "locations"
    ? `company-users-${shop}-${companyId}-${action}`
    : `company-users-${shop}-${companyId}-list-${after}-${sortParam}-${query}`;
}

// ============================================================
// 📦 LOADER — GET requests
// ============================================================

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const startTime = Date.now();

  try {
    const url = new URL(request.url);
    const action    = url.searchParams.get("action");
    const after     = url.searchParams.get("after") || "";
    const query     = url.searchParams.get("query") || "";
    const sortParam = url.searchParams.get("sort") || "Sort: Name";

    // ── FAST PATH ───────────────────────────────────────────
    // shop + customerId are FREE — they're plain URL params, no auth needed
    const shopFromUrl       = url.searchParams.get("shop") || "";
    const customerIdFromUrl = url.searchParams.get("logged_in_customer_id") || "";
    const companyIdCacheKey = `${shopFromUrl}-${customerIdFromUrl}`;

    const cachedCompanyId = companyIdCache.get(companyIdCacheKey);

    if (
      shopFromUrl &&
      customerIdFromUrl &&
      cachedCompanyId &&
      Date.now() - cachedCompanyId.timestamp < COMPANY_ID_TTL
    ) {
      const dataCacheKey = buildCacheKey(
        shopFromUrl,
        cachedCompanyId.companyId,
        action,
        after,
        sortParam,
        query,
      );

      const cached = cache.get(dataCacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        // 🎉 Zero auth, zero Shopify API calls
        console.log(`⚡ Cache HIT (skipped auth) → ${dataCacheKey}`);
        console.log(`🚀 API Time: ${Date.now() - startTime}ms`);
        return Response.json(cached.data);
      }
    }

    // ── SLOW PATH — cache miss, run full auth ───────────────
    console.log("🐢 Cache MISS → running auth + fetch");

    const { companyId, store, shop, userContext } =
      await authenticateApiProxyWithPermissions(request);

    // ✅ Cache the companyId — next request skips auth entirely
    companyIdCache.set(companyIdCacheKey, {
      companyId,
      timestamp: Date.now(),
    });

    const cacheKey = buildCacheKey(shop, companyId, action, after, sortParam, query);

    // Permission check
    requirePermission(userContext, "canManageUsers", "No permission");

    if (!store.accessToken) {
      return Response.json(
        { success: false, error: "No token" },
        { status: 500 },
      );
    }

    const companyData = await prisma.companyAccount.findFirst({
      where: { shopifyCompanyId: companyId },
    });

    if (!companyData) {
      return Response.json(
        { success: false, error: "Company not found" },
        { status: 404 },
      );
    }

    const storeAdmin = await prisma.user.findFirst({
      where: { companyId: companyData.id, role: "STORE_ADMIN" },
    });

    const storeAdminEmail = storeAdmin?.email;

    // ── ACTION: roles ───────────────────────────────────────
    if (action === "roles") {
      const roles = await getCompanyRoles();
      const result = { success: true, roles };
      cache.set(cacheKey, { data: result, timestamp: Date.now() });
      console.log("✅ Cache SET →", cacheKey);
      return Response.json(result);
    }

    // ── ACTION: locations ───────────────────────────────────
    if (action === "locations") {
      const locationsData = await getCompanyLocations(companyId, shop, store.accessToken);
      const result = { success: true, locations: locationsData.locations || [] };
      cache.set(cacheKey, { data: result, timestamp: Date.now() });
      console.log("✅ Cache SET →", cacheKey);
      return Response.json(result);
    }

    // ── ACTION: user list (default) ─────────────────────────
    const customersData = await getCompanyCustomers(
      companyId, shop, store.accessToken,
      { first: 10, after: after || undefined, query, sortKey: "NAME", reverse: false },
    );

    if (customersData.error) {
      return Response.json(
        { success: false, error: "Something went wrong" },
        { status: 500 },
      );
    }

    const customerIds = customersData.customers.map((c: any) => `${c.customer.id}`);

    const registrations = await prisma.registrationSubmission.findMany({
      where: { shopifyCustomerId: { in: customerIds } },
    });

    const registrationMap = new Map(
      registrations.map((r) => [
        r.shopifyCustomerId,
        `${r.firstName || ""} ${r.lastName || ""}`,
      ]),
    );

    const users = customersData.customers.map((c: any) => {
      const firstName = c.customer.firstName?.trim();
      const lastName  = c.customer.lastName?.trim();
      const registrationName = registrationMap.get(`${c.customer.id}`) || "";
      const name =
        (firstName && lastName ? `${firstName} ${lastName}` : firstName) ||
        registrationName;

      const isStoreAdmin =
        storeAdmin?.role === "STORE_ADMIN" &&
        c.customer.email === storeAdminEmail;

      const locationRoles =
        c.customer.roleAssignments?.edges?.map((edge: any) => ({
          roleName: isStoreAdmin ? "Company Admin" : (edge.node.role?.name ?? ""),
          locationName: edge.node.companyLocation?.name || null,
        })) || [];

      return {
        id: c.customer.id,
        name,
        email: c.customer.email,
        company: customersData.companyName,
        isGlobalAdmin: isStoreAdmin,
        locationRoles,
      };
    });

    const result = {
      success: true,
      users,
      pageInfo: customersData.pageInfo,
      companyName: customersData.companyName,
    };

    cache.set(cacheKey, { data: result, timestamp: Date.now() });
    console.log("✅ Cache SET →", cacheKey);

    return Response.json(result);
  } catch (error) {
    console.error("❌ Loader Error:", error);
    return Response.json(
      { success: false, error: "Something went wrong" },
      { status: 500 },
    );
  } finally {
    console.log(`🚀 API Time: ${Date.now() - startTime}ms`);
  }
};

// ============================================================
// ✏️  ACTION — POST requests (create / edit / delete)
// ============================================================

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const { companyId, store, shop, userContext } =
      await authenticateApiProxyWithPermissions(request);

    requirePermission(
      userContext,
      "canManageUsers",
      "You do not have permission to manage users. Only Company Admins and Main Contacts can create, edit, or delete users.",
    );

    if (!store.accessToken) {
      return Response.json(
        { error: "Store access token not available" },
        { status: 500 },
      );
    }

    const body = await request.json();
    const { action: actionType } = body;

    switch (actionType) {
      // ── CREATE ──────────────────────────────────────────────
      case "create": {
        const { name, email, locationRoles, credit } = body;

        if (!name || !email) {
          return Response.json(
            { error: "Name and email are required" },
            { status: 400 },
          );
        }

        const [firstName, ...lastNameParts] = name.trim().split(" ");
        const lastName = lastNameParts.join(" ");

        const result = await createCompanyCustomer(
          companyId, shop, store.accessToken,
          {
            firstName: firstName || "",
            lastName: lastName || "",
            email,
            locationRoles: locationRoles || [],
            credit: parseFloat(credit) || 0,
          },
        );

        if (result.error) {
          return Response.json(
            { success: false, error: result.error },
            { status: 400 },
          );
        }

        await sendEmployeeAssignmentEmail({
          contactName: `${firstName} ${lastName}`,
          email,
          adminName: userContext?.customerName || "",
          role: locationRoles[0]?.roleName || "",
          companyName: userContext?.companyName || "",
          shopName: store.shopName || "",
          shopDomain: store.shopDomain || "",
        });

        clearCompanyUsersCache(shop, companyId);
        return Response.json({
          success: true,
          customerId: result.customerId,
          contactId: result.contactId,
        });
      }

      // ── EDIT ────────────────────────────────────────────────
   case "edit": {
  const { userId, name, email, locationRoles, credit } = body;

  if (!userId) {
    return Response.json(
      { error: "User ID is required for editing" },
      { status: 400 },
    );
  }

  const [firstName, ...lastNameParts] = (name || "").trim().split(" ");
  const lastName = lastNameParts.join(" ");

  // userId may be a Customer GID, CompanyContact GID, or plain numeric CompanyContact ID.
  // updateCompanyCustomer now handles all three cases automatically.
  const result = await updateCompanyCustomer(
    userId,       // passed as-is — function resolves the correct GID internally
    companyId,
    shop,
    store.accessToken,
    {
      firstName: firstName || undefined,
      lastName: lastName || undefined,
      email,
      locationRoles: locationRoles || undefined,
      credit: credit !== undefined ? parseFloat(credit) : undefined,
    },
  );

  if (result.error) {
    return Response.json({ error: result.error }, { status: 500 });
  }

  clearCompanyUsersCache(shop, companyId);
  return Response.json({ success: true, result });
}

      // ── DELETE ──────────────────────────────────────────────
     case "delete": {
  const { userId } = body;

  if (!userId) {
    return Response.json(
      { error: "User ID is required" },
      { status: 400 },
    );
  }

  // getCompanyContactEmail also needs the same fix — pass companyId so it
  // can resolve a Customer GID to a CompanyContact GID internally.
  const contactEmail = await getCompanyContactEmail(
    userId,
    companyId,          // ← pass companyId for GID resolution
    shop,
    store.accessToken,
  );

  if (!contactEmail) {
    return Response.json(
      { error: "Company contact not found" },
      { status: 404 },
    );
  }

  if (
    userContext.customerEmail &&
    contactEmail.toLowerCase() === userContext.customerEmail.toLowerCase()
  ) {
    return Response.json(
      { error: "You cannot delete your own account" },
      { status: 403 },
    );
  }

  // Pass companyId so deleteCompanyCustomer can resolve Customer GID → CompanyContact GID
  const result = await deleteCompanyCustomer(
    userId,
    companyId,          // ← added
    shop,
    store.accessToken,
  );

  if (!result.ok) {
    return Response.json(
      { error: result.message },
      { status: result.status },
    );
  }

  const userData = await prisma.user.findFirst({
    where: { email: contactEmail },
  });

  const registration = await prisma.registrationSubmission.findFirst({
    where: { email: contactEmail },
  });

  if (registration) {
    await prisma.registrationSubmission.delete({
      where: { id: registration.id },
    });
  }

  if (!userData) {
    return Response.json(
      { error: "User not found in local database" },
      { status: 404 },
    );
  }

  await prisma.user.delete({ where: { id: userData.id } });
  clearCompanyUsersCache(shop, companyId);

  return Response.json({
    success: true,
    deletedId: result.data.deletedId,
    message: "User deleted successfully",
  });
}

      default:
        return Response.json({ error: "Invalid action type" }, { status: 400 });
    }
  } catch (error) {
    console.error("❌ Action Error:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
};