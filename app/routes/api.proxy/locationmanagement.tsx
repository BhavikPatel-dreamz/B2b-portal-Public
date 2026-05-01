import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticateApiProxyWithPermissions } from "../../utils/proxy.server";
import { requirePermission } from "../../utils/permissions.server";
import {
  getCompanyLocations,
  updateCompanyLocation,
  deleteCompanyLocation,
  createLocationAndAssignToContact,
  checkLocationExists,
  checkLocationHasOrders,
  checkLocationHasUsers,
} from "../../utils/b2b-customer.server";


// ============================================================
// 🗂️  CACHE SETUP 
// ============================================================

declare global {
  var __locationCompanyIdCache:
    | Map<string, { companyId: string; timestamp: number }>
    | undefined;

  var __locationDataCache:
    | Map<string, { data: any; timestamp: number }>
    | undefined;
}

// Layer 1 — companyId lookup (10 min TTL)
const companyIdCache: Map<string, { companyId: string; timestamp: number }> =
  globalThis.__locationCompanyIdCache ??
  (globalThis.__locationCompanyIdCache = new Map());

// Layer 2 — response data (5 min TTL)
const cache: Map<string, { data: any; timestamp: number }> =
  globalThis.__locationDataCache ??
  (globalThis.__locationDataCache = new Map());

const CACHE_TTL        = 5  * 60 * 1000; // 5 min
const COMPANY_ID_TTL   = 10 * 60 * 1000; // 10 min

// ============================================================
// 🧹 CACHE HELPERS
// ============================================================

export const clearCompanyLocationsCache = (shop: string, companyId: string) => {
  const prefix = `company-locations-${shop}-${companyId}`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
  console.log("🧹 Locations cache cleared for:", prefix);
};

function buildCacheKey(shop: string, companyId: string) {
  return `company-locations-${shop}-${companyId}`;
}

// ============================================================
// 📦 LOADER — GET request
// ============================================================

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const startTime = Date.now();

  try {
    const url = new URL(request.url);

    // ── FAST PATH ───────────────────────────────────────────
    // shop + customerId are FREE — plain URL params, no auth needed
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
      const dataCacheKey = buildCacheKey(shopFromUrl, cachedCompanyId.companyId);
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

    const { companyId, store, shop } =
      await authenticateApiProxyWithPermissions(request);

    // ✅ Cache the companyId — next request skips auth entirely
    companyIdCache.set(companyIdCacheKey, {
      companyId,
      timestamp: Date.now(),
    });

    const cacheKey = buildCacheKey(shop, companyId);

    if (!store.accessToken) {
      return Response.json(
        { error: "Store access token not available" },
        { status: 500 },
      );
    }

    const locationsData = await getCompanyLocations(companyId, shop, store.accessToken);
    console.log("🚀 ~ loader ~ locationsData:", locationsData);

    if (locationsData.error) {
      return Response.json(
        { error: "Failed to fetch locations" },
        { status: 500 },
      );
    }

    // Fetch shipping zones + provinces from Shopify
    const graphqlRes = await fetch(
      `https://${shop}/admin/api/2024-10/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": store.accessToken,
        },
        body: JSON.stringify({
          query: `
            query {
              shop {
                countriesInShippingZones {
                  countryCodes
                  includeRestOfWorld
                }
              }
              deliveryProfiles(first: 10) {
                nodes {
                  profileLocationGroups {
                    locationGroupZones(first: 100) {
                      nodes {
                        zone {
                          countries {
                            code { countryCode }
                            name
                            provinces { code name }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          `,
        }),
      },
    );

    const gql = await graphqlRes.json();

    if (gql.errors) {
      console.error("GraphQL Error:", gql.errors);
      return Response.json(
        { error: "Failed to fetch shipping data" },
        { status: 500 },
      );
    }

    const validCodes = new Set<string>(
      gql.data?.shop?.countriesInShippingZones?.countryCodes || [],
    );

    const provincesData: {
      countryCode: string;
      countryName: string;
      provinces: { value: string; label: string }[];
    }[] = [];

    for (const profile of gql.data?.deliveryProfiles?.nodes || []) {
      for (const group of profile.profileLocationGroups || []) {
        for (const zoneNode of group.locationGroupZones?.nodes || []) {
          for (const country of zoneNode.zone?.countries || []) {
            const code = country.code?.countryCode;

            if (!code || !validCodes.has(code)) continue;

            const provinces = (country.provinces || []).map(
              (p: { code: string; name: string }) => ({
                value: p.code,
                label: p.name,
              }),
            );

            const existing = provincesData.find((c) => c.countryCode === code);

            if (existing) {
              const existingCodes = new Set(existing.provinces.map((p) => p.value));
              for (const p of provinces) {
                if (!existingCodes.has(p.value)) existing.provinces.push(p);
              }
            } else {
              provincesData.push({
                countryCode: code,
                countryName: country.name,
                provinces,
              });
            }
          }
        }
      }
    }

    for (const c of provincesData) {
      c.provinces.sort((a, b) => a.label.localeCompare(b.label));
    }
    provincesData.sort((a, b) => a.countryName.localeCompare(b.countryName));

    const result = {
      success: true,
      locations: locationsData.locations || [],
      companyName: locationsData.companyName,
      ShippingAddressProvince: provincesData,
    };

    // ✅ Store in cache
    cache.set(cacheKey, { data: result, timestamp: Date.now() });
    console.log("✅ Cache SET →", cacheKey);

    return Response.json(result);
  } catch (error) {
    console.error("Loader error:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
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
      "canManageLocations",
      "You do not have permission to manage locations. Only Company Admins and Main Contacts can create, edit, or delete locations.",
    );

    if (!store.accessToken) {
      return Response.json(
        { error: "Store access token not available" },
        { status: 500 },
      );
    }

    const body = await request.json();
    console.log("🚀 ~ action ~ body:", body);
    const { action: actionType } = body;

    switch (actionType) {
      // ── CREATE ──────────────────────────────────────────────
      case "create": {
        const {
          name, externalId, country, firstName, lastName,
          address1, address2, city, province, zip, phone,
          recipient, billingSameAsShipping,
        } = body;

        const validations = [
          { field: "name",       value: name,       message: "Location name is required" },
          { field: "firstName",  value: firstName,  message: "First name is required" },
          { field: "lastName",   value: lastName,   message: "Last name is required" },
          { field: "address1",   value: address1,   message: "Street address is required" },
          { field: "address2",   value: address2,   message: "Apartment, suite, etc is required" },
          { field: "recipient",  value: recipient,  message: "Company/Attention is required" },
          { field: "city",       value: city,       message: "City is required" },
          { field: "province",   value: province,   message: "Province/State is required" },
          { field: "country",    value: country,    message: "Country is required" },
          { field: "zip",        value: zip,        message: "Zip/Postal code is required" },
        ];

        for (const v of validations) {
          if (!v.value || v.value.toString().trim() === "") {
            return Response.json({ error: v.message }, { status: 400 });
          }
        }

        const alreadyExists = await checkLocationExists(
          companyId, shop, store.accessToken, name,
        );

        if (alreadyExists) {
          return Response.json({
            success: false,
            error: "Already exist this location in this company",
          });
        }

        const result = await createLocationAndAssignToContact(
          companyId,
          `gid://shopify/Customer/${userContext.customerId}`,
          shop,
          store.accessToken,
          {
            name: name || "",
            externalId: externalId || "",
            country: country || "IN",
            firstName: firstName?.trim() || "",
            lastName: lastName?.trim() || "",
            address1: address1 || "",
            address2: address2 || "",
            city: city || "",
            province: province || "GJ",
            zip: zip || "",
            phone: phone && phone.trim() !== "" ? phone : "",
            recipient: recipient || "",
            billingSameAsShipping,
          },
        );

        if (result.error) {
          return Response.json(
            { error: result.error, details: result.details },
            { status: 400 },
          );
        }

        // ✅ Bust cache so next GET returns fresh locations
        clearCompanyLocationsCache(shop, companyId);

        return Response.json({ success: true, locationId: result.locationId });
      }

      // ── EDIT ────────────────────────────────────────────────
      case "edit": {
  const {
    locationId, name, externalId, country, firstName, lastName,
    address1, address2, city, province, zip, phone,
    recipient, billingSameAsShipping, isDefault, // ✅ Added
  } = body;

  if (!locationId) {
    return Response.json(
      { error: "Location ID is required for editing" },
      { status: 400 },
    );
  }

  // Treat empty string as null (clear the field), undefined as "don't update"
  const phoneValue =
    phone === undefined ? undefined : phone === "" ? null : phone;
  const externalIdValue =
    externalId === undefined ? undefined : externalId === "" ? null : externalId;
  const recipientValue =
    recipient === undefined ? undefined : recipient === "" ? null : recipient;

  // ✅ Convert isDefault to boolean or undefined (don't update if not provided)
  const isDefaultValue =
    isDefault === undefined ? undefined : isDefault === true || isDefault === "true";

  // ── UNSET OTHER DEFAULTS ──────────────────────────────
  // If we're setting THIS location as default, we must unset others
  if (isDefaultValue === true) {
    try {
      const locationsRes = await getCompanyLocations(companyId, shop, store.accessToken);
      const otherDefaultLocations = (locationsRes.locations || []).filter(
        (loc: any) => loc.isDefault && loc.id !== locationId
      );

      if (otherDefaultLocations.length > 0) {
        console.log(`🔄 Unsetting default for ${otherDefaultLocations.length} other locations`);
        await Promise.all(
          otherDefaultLocations.map((loc: any) =>
            updateCompanyLocation(loc.id, shop, store.accessToken, { isDefault: false })
          )
        );
      }
    } catch (err) {
      console.warn("⚠️ Failed to unset other default locations:", err);
      // Continue with main update anyway
    }
  }

  const result = await updateCompanyLocation(
    locationId, shop, store.accessToken,
    {
      name:                  name || undefined,
      externalId:            externalIdValue,
      country:               country || undefined,
      firstName:             firstName?.trim() || undefined,
      lastName:              lastName?.trim() || undefined,
      address1:              address1 || undefined,
      address2:              address2 || undefined,
      city:                  city || undefined,
      province:              province || undefined,
      zip:                   zip || undefined,
      phone:                 phoneValue,
      recipient:             recipientValue,
      billingSameAsShipping: billingSameAsShipping || undefined,
      isDefault:             isDefaultValue, // ✅ Added
    },
  );

  if (result.error) {
    return Response.json(
      { error: result.error, userErrors: result.userErrors },
      { status: 400 },
    );
  }

  // ✅ Bust cache so next GET returns updated data
  clearCompanyLocationsCache(shop, companyId);

  return Response.json({ success: true });
}

      // ── DELETE ──────────────────────────────────────────────
      case "delete": {
        const { locationId } = body;

        if (!locationId) {
          return Response.json(
            { error: "Location ID is required for deletion" },
            { status: 400 },
          );
        }

        const orderCheck = await checkLocationHasOrders(
          locationId, shop, store.accessToken,
        );

        if (orderCheck.error) {
          return Response.json(
            { error: orderCheck.message || "Failed to verify location status" },
            { status: 500 },
          );
        }

        if (orderCheck.hasOrders) {
          return Response.json(
            {
              error: `Cannot delete location "${orderCheck.locationName}". This location has ${orderCheck.ordersCount} order(s) are existing.`,
              ordersCount: orderCheck.ordersCount,
              totalSpent:  orderCheck.totalSpent,
            },
            { status: 400 },
          );
        }

        const userCheck = await checkLocationHasUsers(
          locationId, shop, store.accessToken,
        );

        if (userCheck.error) {
          return Response.json(
            { error: "Failed to verify location status" },
            { status: 500 },
          );
        }

        const isUserAssignedToLocation =
          userContext?.customerEmail &&
          userCheck?.assignedEmails?.includes(userContext.customerEmail);

        const canDelete =
          !userCheck.hasUsers ||
          (userContext?.isMainContact === true &&
            isUserAssignedToLocation &&
            userCheck.userCount === 1);

        if (!canDelete) {
          return Response.json(
            {
              error: `Cannot delete location "${userCheck.locationName}". It has ${userCheck.userCount} assigned user(s). Please unassign all users before deleting.`,
              assignedUsers: userCheck.userCount,
            },
            { status: 400 },
          );
        }

        const result = await deleteCompanyLocation(locationId, shop, store.accessToken);

        if (result.error) {
          return Response.json(
            {
              error: result.error.message || result.error,
              type:  result.error.type || "DELETE_FAILED",
            },
            { status: 400 },
          );
        }

        // ✅ Bust cache so next GET reflects deletion
        clearCompanyLocationsCache(shop, companyId);

        return Response.json({ success: true, deletedId: result.deletedId });
      }

      default:
        return Response.json({ error: "Invalid action type" }, { status: 400 });
    }
  } catch (error) {
    console.error("Proxy error (POST):", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
};