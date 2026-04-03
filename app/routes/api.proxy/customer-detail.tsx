import { LoaderFunctionArgs } from "react-router";
import { getStoreByDomain } from "app/services/store.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Access-Control-Max-Age": "86400",
};

function json(data: unknown, init: ResponseInit = {}) {
  return Response.json(data, {
    ...init,
    headers: {
      ...CORS_HEADERS,
      ...(init.headers ?? {}),
    },
  });
}

// ─── LOADER ────────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    const url = new URL(request.url);
    const shop = url.searchParams.get("shop");
    const customerId = url.searchParams.get("customerId");

    if (!shop) {
      return json({ error: "Missing shop" }, { status: 400 });
    }

    if (!customerId) {
      return json({ error: "Missing customerId" }, { status: 400 });
    }

    const store = await getStoreByDomain(shop);

    if (!store) {
      return json({ error: "Store not found" }, { status: 404 });
    }

    if (!store.accessToken) {
      return json({ error: "Store access token not configured" }, { status: 500 });
    }

    // ─── Fetch customer from Shopify ───────────────────────────────────────
    const response = await fetch(
      `https://${shop}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": store.accessToken,
        },
        body: JSON.stringify({
          query: `
            query GetCustomerDetail($customerId: ID!) {
              customer(id: $customerId) {
                id
                email
                firstName
                lastName
                phone
                defaultAddress {
                  firstName
                  lastName
                  address1
                  address2
                  city
                  province
                  provinceCode
                  zip
                  country
                  countryCodeV2
                  phone
                }
              }
            }
          `,
          variables: {
            customerId: `gid://shopify/Customer/${customerId}`,
          },
        }),
      }
    );

    if (!response.ok) {
      return json({ error: "Failed to fetch customer from Shopify" }, { status: 502 });
    }

    const result = await response.json();

    if (result.errors) {
      console.error("GraphQL Errors:", result.errors);
      return json({ error: result.errors }, { status: 400 });
    }

    const customer = result?.data?.customer;

    if (!customer) {
      return json({ error: "Customer not found" }, { status: 404 });
    }

    return json({
      success: true,
      customer: {
        id: customerId,
        gid: customer.id,
        email: customer.email,
        firstName: customer.firstName,
        lastName: customer.lastName,
        phone: customer.phone,
        defaultAddress: customer.defaultAddress
          ? {
              firstName: customer.defaultAddress.firstName,
              lastName: customer.defaultAddress.lastName,
              address1: customer.defaultAddress.address1,
              address2: customer.defaultAddress.address2,
              city: customer.defaultAddress.city,
              province: customer.defaultAddress.province,
              provinceCode: customer.defaultAddress.provinceCode,
              zip: customer.defaultAddress.zip,
              country: customer.defaultAddress.country,
              countryCode: customer.defaultAddress.countryCodeV2,
              phone: customer.defaultAddress.phone,
            }
          : null,
      },
    });

  } catch (error) {
    console.error("❌ Error fetching customer detail:", error);
    return json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
};
