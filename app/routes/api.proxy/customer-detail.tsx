import { LoaderFunctionArgs } from "react-router";
import { unauthenticated } from "../../shopify.server";
import { authenticateCustomerAccountSession } from "app/utils/customer-account-session.server";

function getCorsHeaders(request: Request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data: unknown, init: ResponseInit = {}, request?: Request) {
  const corsHeaders = request ? getCorsHeaders(request) : {};
  return Response.json(data, {
    ...init,
    headers: {
      ...corsHeaders,
      ...(init.headers ?? {}),
    },
  });
}

type CustomerDetailPayload = {
  errors?: unknown;
  data?: {
    customer?: {
      id: string;
      email: string | null;
      firstName: string | null;
      lastName: string | null;
      phone: string | null;
      defaultAddress?: {
        firstName: string | null;
        lastName: string | null;
        address1: string | null;
        address2: string | null;
        city: string | null;
        province: string | null;
        provinceCode: string | null;
        zip: string | null;
        country: string | null;
        countryCodeV2: string | null;
        phone: string | null;
      } | null;
    } | null;
  };
};

// ─── LOADER ────────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getCorsHeaders(request) });
  }

  const respond = (data: unknown, init: ResponseInit = {}) =>
    json(data, init, request);

  try {
    const { shop, customerGid, customerId: numericCustomerId } =
      await authenticateCustomerAccountSession(request);

    if (!shop) {
      return respond({ error: "Missing shop" }, { status: 400 });
    }

    const { admin } = await unauthenticated.admin(shop);

    // ─── Fetch customer from Shopify ───────────────────────────────────────
    const response = await admin.graphql(
      `#graphql
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
      }`,
      {
        variables: {
          customerId: customerGid,
        },
      }
    );

    if (!response.ok) {
      return respond({ error: "Failed to fetch customer from Shopify" }, { status: 502 });
    }

    const result = (await response.json()) as CustomerDetailPayload;

    if (result.errors) {
      console.error("GraphQL Errors:", result.errors);
      return respond({ error: result.errors }, { status: 400 });
    }

    const customerData = result?.data?.customer;

    if (!customerData) {
      return respond({ error: "Customer not found" }, { status: 404 });
    }

    return respond({
      success: true,
      customer: {
        id: numericCustomerId,
        gid: customerData.id,
        email: customerData.email,
        firstName: customerData.firstName,
        lastName: customerData.lastName,
        phone: customerData.phone,
        defaultAddress: customerData.defaultAddress
          ? {
              firstName: customerData.defaultAddress.firstName,
              lastName: customerData.defaultAddress.lastName,
              address1: customerData.defaultAddress.address1,
              address2: customerData.defaultAddress.address2,
              city: customerData.defaultAddress.city,
              province: customerData.defaultAddress.province,
              provinceCode: customerData.defaultAddress.provinceCode,
              zip: customerData.defaultAddress.zip,
              country: customerData.defaultAddress.country,
              countryCode: customerData.defaultAddress.countryCodeV2,
              phone: customerData.defaultAddress.phone,
            }
          : null,
      },
    });

  } catch (error) {
    if (error instanceof Response) {
      return respond(
        { error: error.statusText || "Unauthorized" },
        { status: error.status || 401 }
      );
    }

    console.error("❌ Error fetching customer detail:", error);
    return respond(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
};
