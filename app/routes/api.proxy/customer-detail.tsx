import { LoaderFunctionArgs } from "react-router";
import { unauthenticated } from "../../shopify.server";
import { authenticateCustomerAccountSession } from "app/utils/customer-account-session.server";

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
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  try {
    const { shop, customerGid, customerId: numericCustomerId } =
      await authenticateCustomerAccountSession(request);

    if (!shop) {
      return Response.json({ error: "Missing shop" }, { status: 400 });
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
      return Response.json({ error: "Failed to fetch customer from Shopify" }, { status: 502 });
    }

    const result = (await response.json()) as CustomerDetailPayload;

    if (result.errors) {
      console.error("GraphQL Errors:", result.errors);
      return Response.json({ error: result.errors }, { status: 400 });
    }

    const customerData = result?.data?.customer;

    if (!customerData) {
      return Response.json({ error: "Customer not found" }, { status: 404 });
    }

    return Response.json({
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
      return Response.json(
        { error: error.statusText || "Unauthorized" },
        { status: error.status || 401 }
      );
    }

    console.error("❌ Error fetching customer detail:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
};
