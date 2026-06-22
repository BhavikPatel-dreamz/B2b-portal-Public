import { ActionFunctionArgs, LoaderFunction } from "react-router";
import { getProxyParams } from "app/utils/proxy.server";
import { authenticate } from "app/shopify.server";
import {
  sendCustomerRegistrationApprovalEmail,
  sendRegistrationEmailForAdmin,
  sendRegistrationEmailForCustomer,
} from "app/utils/email";
import { getStoreByDomain } from "app/services/store.server";
import prisma from "app/db.server";
import {
  getFreePlanRegistrationsLimitMessage,
  getFreePlanUsage,
} from "app/utils/free-plan-limits.server";

function getCorsHeaders(request: Request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "86400",
  };
}

const CORE_FIELD_KEYS = [
  "companyName",
  "email",
  "firstName",
  "lastName",
  "contactName",
  "contactTitle",
  "shopifyCustomerId",
  "customerEmail",
  "phone",
  "intent",
  "billSameAsShip",
];

type FormFields = Record<string, string>;
type AddressFields = Record<string, string>;
type GraphQLUserError = { field?: string[]; message?: string };
type GraphQLError = { message?: string };
type ShopifyCustomer = {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
};
type ShopifyCompany = {
  id: string;
  name: string;
};
type ShopifyLocation = {
  id: string;
  name: string;
};
type CompanyRoleEdge = {
  node?: {
    id?: string;
    name?: string;
  };
};
type AdminGraphQLClient = {
  graphql: (
    query: string,
    options?: {
      variables?: Record<string, unknown>;
    },
  ) => Promise<Response>;
};

type StoreRecord = NonNullable<Awaited<ReturnType<typeof getStoreByDomain>>>;

const COUNTRY_DIAL_CODES: Record<string, string> = {
  IN: "+91",
  US: "+1",
  CA: "+1",
  GB: "+44",
  AU: "+61",
  DE: "+49",
  FR: "+33",
  IT: "+39",
  ES: "+34",
  NL: "+31",
  CH: "+41",
  BE: "+32",
  AT: "+43",
  SE: "+46",
  NO: "+47",
  DK: "+45",
  FI: "+358",
  IE: "+353",
  NZ: "+64",
  SG: "+65",
  HK: "+852",
  JP: "+81",
  KR: "+82",
  MY: "+60",
  TH: "+66",
  AE: "+971",
  SA: "+966",
  ZA: "+27",
  BR: "+55",
  MX: "+52",
  IL: "+972",
  PL: "+48",
  PT: "+351",
  TR: "+90",
};

function formatPhone(phone?: string, countryCode?: string) {
  if (!phone) return undefined;

  const rawPhone = String(phone).trim();
  if (rawPhone.startsWith("+")) return rawPhone.replace(/[^\d+]/g, "");

  const cleaned = rawPhone.replace(/\D/g, "");
  if (!cleaned) return undefined;

  const code = (countryCode || "IN").toUpperCase();
  const dialCode = COUNTRY_DIAL_CODES[code];

  if (dialCode) {
    const dialDigits = dialCode.replace(/\D/g, "");
    if (cleaned.startsWith(dialDigits) && cleaned.length > dialDigits.length) {
      return `+${cleaned}`;
    }
    return `${dialCode}${cleaned}`;
  }

  return `+${cleaned}`;
}

function createAdminGraphQLClient(
  shop: string,
  accessToken: string,
): AdminGraphQLClient {
  return {
    graphql: async (
      query: string,
      options?: {
        variables?: Record<string, unknown>;
      },
    ) => {
      return fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query,
          variables: options?.variables ?? {},
        }),
      });
    },
  };
}

function parseFormFields(form: FormFields) {
  const location: AddressFields = {};
  const customFields: FormFields = {};

  Object.entries(form).forEach(([key, value]) => {
    if (key.startsWith("ship")) {
      location[key.replace("ship", "")] = value;
      return;
    }

    if (!CORE_FIELD_KEYS.includes(key)) {
      customFields[key] = value;
    }
  });

  return { location, customFields };
}

function normalizePhoneForComparison(
  phone?: string | null,
  countryCode?: string | null,
) {
  if (!phone) return "";

  const formatted = formatPhone(phone, countryCode || undefined) || String(phone);
  return formatted.replace(/\D/g, "");
}

function getAddressFieldValue(
  address: unknown,
  ...keys: string[]
) {
  if (!address || typeof address !== "object") return "";

  for (const key of keys) {
    const value = (address as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function getSubmissionPhoneCandidates(submission: {
  location?: unknown;
  customFields?: unknown;
}) {
  const locationPhone = getAddressFieldValue(submission.location, "Phone", "phone");
  const locationCountry = getAddressFieldValue(
    submission.location,
    "Country",
    "country",
  );
  const customPhone = getAddressFieldValue(submission.customFields, "phone");

  return [
    normalizePhoneForComparison(customPhone, locationCountry),
    normalizePhoneForComparison(locationPhone, locationCountry),
  ].filter(Boolean);
}

function normalizeFieldKey(key: string) {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function getFieldValueByKeyMatch(
  fields: FormFields,
  targetKey: string,
  options: { startsWith?: boolean; endsWith?: boolean; includes?: boolean } = {
    startsWith: true,
    endsWith: true,
  },
) {
  const normalizedTarget = normalizeFieldKey(targetKey);
  const matchingKey = Object.keys(fields).find((key) => {
    const normalizedKey = normalizeFieldKey(key);

    if (normalizedKey === normalizedTarget) return true;
    if (options.startsWith && normalizedKey.startsWith(normalizedTarget)) return true;
    if (options.endsWith && normalizedKey.endsWith(normalizedTarget)) return true;
    if (options.includes && normalizedKey.includes(normalizedTarget)) return true;

    return false;
  });

  return matchingKey ? fields[matchingKey] : "";
}

function buildAddress(
  address: AddressFields | undefined,
  fallbackFirstName: string,
  fallbackLastName: string,
) {
  if (!address) return null;

  const payload = {
    address1: address.Addr1 || "",
    address2: address.Addr2 || "",
    city: address.City || "",
    zip: address.Zip || "",
    countryCode: address.Country || "",
    zoneCode: address.State || "",
    phone: formatPhone(address.Phone, address.Country),
    firstName: address.FirstName || fallbackFirstName || "",
    lastName: address.LastName || fallbackLastName || "",
    recipient:
      `${address.FirstName || fallbackFirstName || ""} ${address.LastName || fallbackLastName || ""}`.trim(),
  };

  if (!payload.address1 && !payload.city && !payload.zip && !payload.countryCode) {
    return null;
  }

  return payload;
}

function getNestedValue(payload: unknown, path: string[]) {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  return path.reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, payload);
}

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function collectUserErrors(payload: unknown, path: string[]) {
  const target = getNestedValue(payload, path) as
    | { userErrors?: GraphQLUserError | GraphQLUserError[] | string | null }
    | undefined;
  const userErrors = toArray(target?.userErrors);

  return userErrors
    .map((error) => {
      if (typeof error === "string") {
        return error.trim();
      }

      if (!error || typeof error !== "object") {
        return "";
      }

      const fieldPath =
        Array.isArray(error.field) && error.field.length > 0
          ? error.field.join(".")
          : "general";

      return `${fieldPath}: ${error.message || "Unknown error"}`;
    })
    .filter((message): message is string => Boolean(message));
}

function collectTopLevelGraphQLErrors(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const errors = toArray(
    (payload as { errors?: GraphQLError | GraphQLError[] | string | null }).errors,
  );

  return errors
    .map((error) => {
      if (typeof error === "string") return error.trim();
      if (!error || typeof error !== "object") return "";
      return error?.message?.trim() || "";
    })
    .filter((message): message is string => Boolean(message));
}

function getGraphQLMessages(payload: unknown, path: string[]) {
  return [
    ...collectTopLevelGraphQLErrors(payload),
    ...collectUserErrors(payload, path),
  ];
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  if (error && typeof error === "object") {
    const candidate = error as {
      message?: unknown;
      error?: unknown;
      errors?: unknown;
      cause?: unknown;
    };

    if (typeof candidate.message === "string" && candidate.message.trim()) {
      return candidate.message;
    }

    if (typeof candidate.error === "string" && candidate.error.trim()) {
      return candidate.error;
    }

    if (Array.isArray(candidate.errors) && candidate.errors.length > 0) {
      const messages = candidate.errors
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object" && "message" in item) {
            const message = (item as { message?: unknown }).message;
            return typeof message === "string" ? message : "";
          }
          return "";
        })
        .filter(Boolean);

      if (messages.length > 0) {
        return messages.join(", ");
      }
    }

    if (candidate.cause) {
      const causeMessage: string = extractErrorMessage(candidate.cause);
      if (causeMessage && causeMessage !== "Something went wrong.") {
        return causeMessage;
      }
    }

    try {
      return JSON.stringify(error);
    } catch {
      return "Something went wrong.";
    }
  }

  return "Something went wrong.";
}

// ─── ✅ FIXED: createOrFindCustomer now updates existing customer if fields are missing ───
async function createOrFindCustomer(
  admin: AdminGraphQLClient,
  {
    email,
    firstName,
    lastName,
    phone,
  }: {
    email: string;
    firstName: string;
    lastName: string;
    phone?: string;
  },
): Promise<{ customer: ShopifyCustomer; created: boolean }> {
  // Step 1: Look up existing customer by email
  const existingResponse = await admin.graphql(
    `#graphql
    query CustomerByEmail($query: String!) {
      customers(first: 1, query: $query) {
        nodes {
          id
          email
          firstName
          lastName
          phone
        }
      }
    }`,
    {
      variables: {
        query: `email:${email}`,
      },
    },
  );

  const existingPayload = await existingResponse.json();
  const existingCustomer = (existingPayload as Record<string, unknown>)?.data as
    | {
        customers?: {
          nodes?: ShopifyCustomer[];
        };
      }
    | undefined;
  const customerNode = existingCustomer?.customers?.nodes?.[0];

  if (customerNode) {
    // ✅ FIX: Check if Shopify customer is missing firstName, lastName, or phone.
    // If so, update them with the values from the registration form.
    const needsUpdate =
      (!customerNode.firstName && firstName) ||
      (!customerNode.lastName && lastName) ||
      (!customerNode.phone && phone);

    if (needsUpdate) {
      console.log("🔄 Existing customer found but missing fields — updating...");

      const updateResponse = await admin.graphql(
        `#graphql
        mutation UpdateCustomer($input: CustomerInput!) {
          customerUpdate(input: $input) {
            customer {
              id
              email
              firstName
              lastName
              phone
            }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            input: {
              id: customerNode.id,
              // Only fill in fields that are currently blank in Shopify
              firstName: customerNode.firstName || firstName || undefined,
              lastName: customerNode.lastName || lastName || undefined,
              phone: customerNode.phone || phone || undefined,
            },
          },
        },
      );

      const updatePayload = await updateResponse.json();
      const updateErrors = getGraphQLMessages(updatePayload, [
        "data",
        "customerUpdate",
      ]);

      if (updateErrors.length > 0) {
        // Log the warning but don't throw — registration can still proceed
        console.warn("⚠️ Customer update had errors:", updateErrors.join(", "));
      } else {
        const updatedCustomer = (
          (updatePayload as Record<string, unknown>)?.data as {
            customerUpdate?: { customer?: ShopifyCustomer };
          }
        )?.customerUpdate?.customer;

        if (updatedCustomer) {
          console.log("✅ Customer updated successfully:", updatedCustomer);
          return { customer: updatedCustomer, created: false };
        }
      }
    }

    return { customer: customerNode, created: false };
  }

  // Step 2: Customer not found — create a new one
  const createResponse = await admin.graphql(
    `#graphql
    mutation CreateCustomer($input: CustomerInput!) {
      customerCreate(input: $input) {
        customer {
          id
          email
          firstName
          lastName
          phone
        }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        input: {
          email,
          firstName,
          lastName: lastName || undefined,
          phone,
        },
      },
    },
  );

  const createPayload = await createResponse.json();
  const errors = getGraphQLMessages(createPayload, ["data", "customerCreate"]);
  if (errors.length > 0) {
    throw new Error(errors.join(", "));
  }

  return {
    customer: ((createPayload as Record<string, unknown>)?.data as {
      customerCreate?: { customer?: ShopifyCustomer };
    })?.customerCreate?.customer as ShopifyCustomer,
    created: true,
  };
}

async function createOrFindCompany(
  admin: AdminGraphQLClient,
  companyName: string,
): Promise<{ company: ShopifyCompany; created: boolean }> {
  const escapedCompanyName = companyName.replace(/'/g, "\\'");
  const existingResponse = await admin.graphql(
    `#graphql
    query CompaniesByName($query: String!) {
      companies(first: 1, query: $query) {
        nodes {
          id
          name
          locations(first: 1) {
            nodes {
              id
              name
            }
          }
        }
      }
    }`,
    {
      variables: {
        query: `name:'${escapedCompanyName}'`,
      },
    },
  );

  const existingPayload = await existingResponse.json();
  const existingCompany = ((existingPayload as Record<string, unknown>)?.data as {
    companies?: {
      nodes?: (ShopifyCompany & { locations?: { nodes?: ShopifyLocation[] } })[];
    };
  })?.companies?.nodes?.[0];

  if (existingCompany) {
    return { company: existingCompany, created: false };
  }

  const createResponse = await admin.graphql(
    `#graphql
    mutation CompanyCreate($input: CompanyCreateInput!) {
      companyCreate(input: $input) {
        company { id name }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        input: {
          company: { name: companyName },
        },
      },
    },
  );

  const createPayload = await createResponse.json();
  const errors = getGraphQLMessages(createPayload, ["data", "companyCreate"]);
  if (errors.length > 0) {
    throw new Error(errors.join(", "));
  }

  return {
    company: ((createPayload as Record<string, unknown>)?.data as {
      companyCreate?: { company?: ShopifyCompany };
    })?.companyCreate?.company as ShopifyCompany,
    created: true,
  };
}

async function getOrCreateCompanyLocation(
  admin: AdminGraphQLClient,
  companyId: string,
  locationName: string,
): Promise<ShopifyLocation> {
  const locationResponse = await admin.graphql(
    `#graphql
    query GetCompanyLocation($companyId: ID!) {
      company(id: $companyId) {
        locations(first: 1) {
          nodes { id name }
        }
      }
    }`,
    { variables: { companyId } },
  );

  const locationPayload = await locationResponse.json();
  const existingLocation = ((locationPayload as Record<string, unknown>)?.data as {
    company?: {
      locations?: {
        nodes?: ShopifyLocation[];
      };
    };
  })?.company?.locations?.nodes?.[0];

  if (existingLocation) {
    return existingLocation;
  }

  const createLocationResponse = await admin.graphql(
    `#graphql
    mutation CompanyLocationCreate($companyId: ID!, $input: CompanyLocationInput!) {
      companyLocationCreate(companyId: $companyId, input: $input) {
        companyLocation {
          id
          name
        }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        companyId,
        input: {
          name: locationName || "Main Location",
        },
      },
    },
  );

  const createLocationPayload = await createLocationResponse.json();
  const errors = getGraphQLMessages(createLocationPayload, [
    "data",
    "companyLocationCreate",
  ]);
  if (errors.length > 0) {
    throw new Error(errors.join(", "));
  }

  return ((createLocationPayload as Record<string, unknown>)?.data as {
    companyLocationCreate?: { companyLocation?: ShopifyLocation };
  })?.companyLocationCreate?.companyLocation as ShopifyLocation;
}

async function assignCustomerToCompany(
  admin: AdminGraphQLClient,
  companyId: string,
  customerId: string,
  locationId: string,
) {
  const assignContactResponse = await admin.graphql(
    `#graphql
    mutation AssignCustomerAsContact($companyId: ID!, $customerId: ID!) {
      companyAssignCustomerAsContact(companyId: $companyId, customerId: $customerId) {
        companyContact {
          id
        }
        userErrors { field message }
      }
    }`,
    {
      variables: { companyId, customerId },
    },
  );

  const assignContactPayload = await assignContactResponse.json();
  const assignErrors = getGraphQLMessages(assignContactPayload, [
    "data",
    "companyAssignCustomerAsContact",
  ]);

  const companyContactId = ((assignContactPayload as Record<string, unknown>)?.data as {
    companyAssignCustomerAsContact?: {
      companyContact?: {
        id?: string;
      };
    };
  })?.companyAssignCustomerAsContact?.companyContact?.id;

  if (!companyContactId && assignErrors.length > 0) {
    const duplicateContact = assignErrors.some((error: string) =>
      error.toLowerCase().includes("already"),
    );

    if (!duplicateContact) {
      throw new Error(assignErrors.join(", "));
    }

    return;
  }

  if (!companyContactId) {
    return;
  }

  const rolesResponse = await admin.graphql(
    `#graphql
    query GetCompanyRoles($companyId: ID!) {
      company(id: $companyId) {
        contactRoles(first: 10) {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    }`,
    {
      variables: { companyId },
    },
  );

  const rolesPayload = await rolesResponse.json();
  const roles = (((rolesPayload as Record<string, unknown>)?.data as {
    company?: {
      contactRoles?: {
        edges?: CompanyRoleEdge[];
      };
    };
  })?.company?.contactRoles?.edges || []) as CompanyRoleEdge[];
  const roleId =
    roles.find((edge) => edge?.node?.name?.toLowerCase() === "company admin")
      ?.node?.id || roles[0]?.node?.id;

  if (roleId) {
    const assignRoleResponse = await admin.graphql(
      `#graphql
      mutation AssignCompanyRole($companyContactId: ID!, $companyContactRoleId: ID!, $companyLocationId: ID!) {
        companyContactAssignRole(
          companyContactId: $companyContactId
          companyContactRoleId: $companyContactRoleId
          companyLocationId: $companyLocationId
        ) {
          companyContactRoleAssignment { id }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          companyContactId,
          companyContactRoleId: roleId,
          companyLocationId: locationId,
        },
      },
    );

    const assignRolePayload = await assignRoleResponse.json();
    const roleErrors = getGraphQLMessages(assignRolePayload, [
      "data",
      "companyContactAssignRole",
    ]);

    const nonDuplicateRoleErrors = roleErrors.filter(
      (error: string) => !error.toLowerCase().includes("already"),
    );

    if (nonDuplicateRoleErrors.length > 0) {
      throw new Error(nonDuplicateRoleErrors.join(", "));
    }
  }

  const mainContactResponse = await admin.graphql(
    `#graphql
    mutation AssignMainContact($companyId: ID!, $companyContactId: ID!) {
      companyAssignMainContact(companyId: $companyId, companyContactId: $companyContactId) {
        company { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        companyId,
        companyContactId,
      },
    },
  );

  const mainContactPayload = await mainContactResponse.json();
  const mainContactErrors = getGraphQLMessages(mainContactPayload, [
    "data",
    "companyAssignMainContact",
  ]).filter((error: string) => !error.toLowerCase().includes("already"));

  if (mainContactErrors.length > 0) {
    throw new Error(mainContactErrors.join(", "));
  }
}

async function assignLocationAddresses(
  admin: AdminGraphQLClient,
  locationId: string,
  location: AddressFields,
  fallbackFirstName: string,
  fallbackLastName: string,
) {
  // ✅ Skip if no valid country code (prevents GraphQL error)
  // Shopify requires a valid countryCode if the address input is provided.
  if (!location.Country) {
    console.log("⚠️ assignLocationAddresses: No country code provided, skipping address assignment.");
    return;
  }

  const locationAddress = buildAddress(
    location,
    fallbackFirstName,
    fallbackLastName,
  );

  if (locationAddress) {
    const shippingResponse = await admin.graphql(
      `#graphql
      mutation AssignAddress($locationId: ID!, $address: CompanyAddressInput!, $addressTypes: [CompanyAddressType!]!) {
        companyLocationAssignAddress(
          locationId: $locationId
          address: $address
          addressTypes: $addressTypes
        ) {
          addresses { id address1 city zip countryCode }
          userErrors { field message code }
        }
      }`,
      {
        variables: {
          locationId,
          address: locationAddress,
          addressTypes: ["SHIPPING", "BILLING"],
        },
      },
    );

    const shippingPayload = await shippingResponse.json();
    const shippingErrors = getGraphQLMessages(shippingPayload, [
      "data",
      "companyLocationAssignAddress",
    ]);
    if (shippingErrors.length > 0) {
      throw new Error(`Company location failed: ${shippingErrors.join(", ")}`);
    }
  }
}

async function autoApproveRegistrationSubmission({
  store,
  registrationId,
  company,
  customer,
  companyName,
  email,
  firstName,
  lastName,
}: {
  store: StoreRecord;
  registrationId: string;
  company: ShopifyCompany;
  customer: ShopifyCustomer;
  companyName: string;
  email: string;
  firstName: string;
  lastName: string;
}) {
  const contactName = `${firstName || ""} ${lastName || ""}`.trim() || null;
  const defaultCreditLimit = store.defaultCompanyCreditLimit ?? 0;

  return prisma.$transaction(async (tx) => {
    const companyAccount = await tx.companyAccount.upsert({
      where: {
        shopId_shopifyCompanyId: {
          shopId: store.id,
          shopifyCompanyId: company.id,
        },
      },
      update: {
        name: companyName,
        contactName,
        contactEmail: email || null,
      },
      create: {
        shopId: store.id,
        shopifyCompanyId: company.id,
        name: companyName,
        contactName,
        contactEmail: email || null,
        creditLimit: defaultCreditLimit,
      },
    });

    const existingUser = await tx.user.findFirst({
      where: {
        shopId: store.id,
        OR: [{ email }, { shopifyCustomerId: customer.id }],
      },
      orderBy: { createdAt: "desc" },
    });

    if (existingUser) {
      await tx.user.update({
        where: { id: existingUser.id },
        data: {
          email,
          firstName: firstName || null,
          lastName: lastName || null,
          shopifyCustomerId: customer.id,
          companyId: companyAccount.id,
          companyRole: "admin",
          role: "STORE_ADMIN",
          status: "APPROVED",
          isActive: true,
        },
      });
    } else {
      await tx.user.create({
        data: {
          email,
          firstName: firstName || null,
          lastName: lastName || null,
          password: "",
          shopifyCustomerId: customer.id,
          shopId: store.id,
          companyId: companyAccount.id,
          companyRole: "admin",
          role: "STORE_ADMIN",
          status: "APPROVED",
          isActive: true,
        },
      });
    }

    const registration = await tx.registrationSubmission.update({
      where: { id: registrationId },
      data: {
        companyName,
        firstName,
        lastName,
        shopifyCustomerId: customer.id,
        status: "APPROVED",
        workflowCompleted: true,
        reviewedAt: new Date(),
      },
    });

    return { companyAccount, registration };
  });
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

function handlePreflight(request: Request): Response | null {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(request),
    });
  }
  return null;
}

export const loader: LoaderFunction = async ({ request }) => {
  // ✅ Handle CORS preflight
  const preflight = handlePreflight(request);
  if (preflight) return preflight;

  const respond = (data: unknown, init: ResponseInit = {}) =>
    json(data, init, request);

  const { shop, loggedInCustomerId: shopifyCustomerId } = getProxyParams(request);

  if (!shop) {
    return respond({ success: false, error: "Store identification failed." }, { status: 400 });
  }

  if (!shopifyCustomerId) {
    return respond({ success: false, error: "Shopify customer ID is required." }, { status: 400 });
  }

  const store = await getStoreByDomain(shop);
  if (!store) {
    return respond({ success: false, error: "Store not found." }, { status: 404 });
  }

  const data = await prisma.registrationSubmission.findFirst({
    where: {
      shopifyCustomerId: `gid://shopify/Customer/${shopifyCustomerId}`,
      shopId: store.id,
    },
  });

  return respond({
    success: true,
    message: "Registration details fetched successfully.",
    data,
  });
};

// ─── ACTION (POST) ─────────────────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("📝 Registration API called");
  
  // ✅ Handle CORS preflight
  const preflight = handlePreflight(request);
  if (preflight) return preflight;

  const respond = (data: unknown, init: ResponseInit = {}) =>
    json(data, init, request);

  let authenticatedShop: string | null = null;
  const authenticatedCustomerId: string | null = null;

  try {
    const { session } = await authenticate.public.appProxy(request);
    authenticatedShop = session.shop;
    // Note: session for App Proxy might contain more info depending on Shopify version
  } catch (e) {
    console.warn("⚠️ [Registration] App Proxy authentication failed or skipped:", e);
  }

  try {
    const url = new URL(request.url);
    const shop = authenticatedShop || url.searchParams.get("shop");

    if (!shop) {
      return respond({ success: false, error: "Store identification failed." }, { status: 400 });
    }

    const store = await getStoreByDomain(shop);
    if (!store) {
      return respond({ success: false, error: "Store not found." }, { status: 404 });
    }
    if (!store.accessToken) {
      return respond(
        { success: false, error: "Store access token is missing." },
        { status: 400 },
      );
    }

    const admin = createAdminGraphQLClient(shop, store.accessToken);

    // ✅ Parse dynamic form data
    const formData = await request.formData();
    const allFields: FormFields = {};
    for (const [key, value] of formData.entries()) {
      allFields[key] = typeof value === "string" ? value : value.name;
    }
    console.log("🔍 [Registration] All form fields:", JSON.stringify(allFields));

    // ✅ Extract main fields
    const companyName = getFieldValueByKeyMatch(allFields, "companyName", {
      startsWith: true,
      endsWith: true,
      includes: true,
    });
    let email =
      allFields.email ||
      allFields.customerEmail ||
      getFieldValueByKeyMatch(allFields, "email", {
        startsWith: true,
        endsWith: true,
        includes: true,
      });

    // ✅ Session-based Email Fallback ("directly get")
    const loggedInCustomerId = 
      url.searchParams.get("logged_in_customer_id") || 
      request.headers.get("x-shopify-customer-id") ||
      allFields.shopifyCustomerId || 
      allFields.customerId ||
      allFields.customer_id;
    
    console.log("🔍 [Registration] Attempting email fallback. Found customerId:", loggedInCustomerId);
    
    if (!email && loggedInCustomerId) {
      try {
        const customerResponse = await admin.graphql(
          `#graphql
          query GetCustomerEmail($id: ID!) {
            customer(id: $id) {
              email
              firstName
              lastName
            }
          }`,
          {
            variables: {
              id: String(loggedInCustomerId).startsWith("gid://")
                ? String(loggedInCustomerId)
                : `gid://shopify/Customer/${loggedInCustomerId}`,
            },
          },
        );
        const customerPayload = (await customerResponse.json()) as any;
        console.log("🔍 [Registration] Shopify customer payload:", JSON.stringify(customerPayload));
        const customerData = customerPayload?.data?.customer;
        if (customerData?.email) {
          email = customerData.email;
          console.log("🔍 [Registration] Found email from session:", email);
          // Also fallback for names if missing
          if (!allFields.firstName && customerData.firstName) allFields.firstName = customerData.firstName;
          if (!allFields.lastName && customerData.lastName) allFields.lastName = customerData.lastName;
        } else {
          console.warn("⚠️ [Registration] Customer email not found in Shopify data for id:", loggedInCustomerId);
        }
      } catch (err) {
        console.error("❌ [Registration] Failed to fetch session customer email:", err);
      }
    }

    // ✅ Final Safety Net: Scan all fields for anything that looks like an email
    if (!email) {
      for (const value of Object.values(allFields)) {
        if (typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
          email = value.trim();
          console.log("🔍 [Registration] Found email-like string in unknown field:", email);
          break;
        }
      }
    }

    if (!email) {
      console.warn("⚠️ [Registration] No email in form, no customer ID found, and no email-like strings in form data.");
    }

    let firstName = getFieldValueByKeyMatch(allFields, "firstName");
    let lastName = getFieldValueByKeyMatch(allFields, "lastName");
    const contactName = getFieldValueByKeyMatch(allFields, "contactName");

    if (contactName && !firstName && !lastName) {
      const parts = contactName.trim().split(/\s+/);
      firstName = parts[0] || "";
      lastName = parts.slice(1).join(" ") || "";
    }

    const contactTitle = getFieldValueByKeyMatch(allFields, "contactTitle");

    // ✅ Basic validation
    if (!companyName) {
      return respond(
        { success: false, error: "Company name is required." },
        { status: 400 },
      );
    }
    if (!email) {
      const errorMsg = loggedInCustomerId 
        ? "Could not retrieve your account email. Please ensure you are logged in or contact support."
        : "Email is required. Please log in to your account first.";
      
      return respond(
        { success: false, error: errorMsg },
        { status: 400 },
      );
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return respond({ success: false, error: "Invalid email format." }, { status: 400 });
    }

    // ✅ Duplicate email check
    const existing = await prisma.registrationSubmission.findFirst({
      where: { shopId: store.id, email },
    });
    console.log("✅ Existing Registration:", existing);

    if (existing) {
      return respond({ success: false, error: "Email already registered." }, { status: 409 });
    }

    const { location, customFields } = parseFormFields(allFields);
    const countryCode = (allFields.shipCountry || allFields.shCountry || allFields.phone_country || "IN") as string;
    const phone = formatPhone(
      allFields.phone || location.Phone,
      countryCode,
    );
    const normalizedPhone = normalizePhoneForComparison(
      phone,
      countryCode,
    );

    if (phone) {
      customFields.phone = phone;
    }

    if (normalizedPhone) {
      const existingPhoneRegistrations = await prisma.registrationSubmission.findMany({
        where: { shopId: store.id },
        select: {
          id: true,
          location: true,
          customFields: true,
        },
      });

      const hasDuplicatePhone = existingPhoneRegistrations.some((submission) =>
        getSubmissionPhoneCandidates(submission).includes(normalizedPhone),
      );

      if (hasDuplicatePhone) {
        return respond(
          { success: false, error: "Phone number already registered." },
          { status: 409 },
        );
      }
    }

    const RegistrationData = await prisma.registrationSubmission.findFirst({
      where: { shopId: store.id, email },
    });

    if (RegistrationData?.companyName === companyName) {
      return respond({ success: false, error: "Company already registered." }, { status: 409 });
    }

    // ✅ FIX: createOrFindCustomer now updates existing customer if firstName/lastName/phone are null
    const { customer } = await createOrFindCustomer(admin, {
      email,
      firstName,
      lastName,
      phone,
    });

    if (store.plan === "free") {
      const usage = await getFreePlanUsage(store.id);

      if (usage.registrationLimitReached) {
        return respond(
          {
            success: false,
            error: getFreePlanRegistrationsLimitMessage(),
          },
          { status: 403 },
        );
      }
    }

    const { company } = await createOrFindCompany(admin, companyName);
    const shopifyLocation = await getOrCreateCompanyLocation(
      admin,
      company.id,
      companyName,
    );

    await assignCustomerToCompany(admin, company.id, customer.id, shopifyLocation.id);
    await assignLocationAddresses(
      admin,
      shopifyLocation.id,
      location,
      firstName,
      lastName,
    );

    const registration = await prisma.registrationSubmission.create({
      data: {
        companyName,
        email,
        firstName,
        lastName,
        contactTitle,
        location,
        customFields,
        shopId: store.id,
        shopifyCustomerId: customer?.id || allFields.shopifyCustomerId || null,
      },
    });

    let finalRegistration = registration;
    let autoApproved = false;

    if (store.autoApproveB2BOnboarding) {
      const result = await autoApproveRegistrationSubmission({
        store,
        registrationId: registration.id,
        company,
        customer,
        companyName,
        email,
        firstName,
        lastName,
      });

      finalRegistration = result.registration;
      autoApproved = true;
    }

    if (email) {
      if (autoApproved) {
        const approvalEmailResult = await sendCustomerRegistrationApprovalEmail({
          storeId: store.id,
          email,
          storeOwnerName: store.storeOwnerName || "Store Owner",
          companyName,
          contactName: `${finalRegistration?.firstName || ""} ${finalRegistration?.lastName || ""}`.trim(),
        });

        if (!approvalEmailResult.success) {
          console.warn(
            "⚠️ Failed to send approval email:",
            "error" in approvalEmailResult ? approvalEmailResult.error : "Unknown error",
          );
        }
      } else {
        const emailResult = await sendRegistrationEmailForCustomer(
          store.id,
          email,
          store.storeOwnerName || "",
          email,
          companyName,
          `${registration?.firstName || ""} ${registration?.lastName || ""}`,
        );

        const adminNotificationEmail =
          store.contactEmail || store.submissionEmail;
        if (adminNotificationEmail) {
          const adminEmailResult = await sendRegistrationEmailForAdmin(
            store.id,
            adminNotificationEmail,
            store.storeOwnerName || "",
            email,
            companyName,
            `${registration?.firstName || ""} ${registration?.lastName || ""}`,
          );

          if (!adminEmailResult.success) {
            console.warn(
              "⚠️ Failed to send admin registration email:",
              "error" in adminEmailResult ? adminEmailResult.error : "Unknown error",
            );
          }
        }

        if (emailResult.success) {
          console.log("✅ Customer registration email sent successfully");
        } else {
          console.warn(
            "⚠️ Failed to send customer registration email:",
            "error" in emailResult ? emailResult.error : "Unknown error",
          );
        }
      }
    }

    return respond({
      success: true,
      message: autoApproved
        ? "Registration submitted and approved successfully!"
        : "Registration submitted successfully!",
      autoApproved,
      redirectTo: autoApproved
        ? `https://${store.shopDomain}/apps/b2b-portal-public/smartb2b`
        : null,
      registrationdata: finalRegistration,
      customer,
      company: {
        id: company.id,
        name: company.name,
        locationId: location.id,
      },
    });
  } catch (error) {
    const message = extractErrorMessage(error);
    console.error("❌ Registration error:", error);
    return respond({ success: false, error: message }, { status: 500 });
  }
};