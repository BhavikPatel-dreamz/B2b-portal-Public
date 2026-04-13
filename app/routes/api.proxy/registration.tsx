import { ActionFunctionArgs, LoaderFunction } from "react-router";
import { getProxyParams } from "app/utils/proxy.server";
import {
  sendCustomerRegistrationApprovalEmail,
  sendRegistrationEmailForAdmin,
  sendRegistrationEmailForCustomer,
} from "app/utils/email";
import { getStoreByDomain } from "app/services/store.server";
import prisma from "app/db.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Access-Control-Max-Age": "86400", // cache preflight for 24 h
};

const CORE_FIELD_KEYS = [
  "companyName",
  "email",
  "firstName",
  "lastName",
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

function formatPhone(phone?: string, countryCode?: string) {
  if (!phone) return undefined;

  if (phone.startsWith("+")) return phone;

  const cleaned = phone.replace(/\D/g, "");
  if (!cleaned) return undefined;

  if (countryCode === "IN") {
    if (cleaned.length === 10) return `+91${cleaned}`;
    if (cleaned.length === 11 && cleaned.startsWith("0")) {
      return `+91${cleaned.slice(1)}`;
    }
    return undefined;
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
  const shipping: AddressFields = {};
  const billing: AddressFields = {};
  const customFields: FormFields = {};

  Object.entries(form).forEach(([key, value]) => {
    if (key.startsWith("ship")) {
      shipping[key.replace("ship", "")] = value;
      return;
    }

    if (key.startsWith("bill")) {
      billing[key.replace("bill", "")] = value;
      return;
    }

    if (!CORE_FIELD_KEYS.includes(key)) {
      customFields[key] = value;
    }
  });

  return { shipping, billing, customFields };
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
  shipping?: unknown;
  billing?: unknown;
  customFields?: unknown;
}) {
  const shippingPhone = getAddressFieldValue(submission.shipping, "Phone", "phone");
  const shippingCountry = getAddressFieldValue(
    submission.shipping,
    "Country",
    "country",
  );
  const billingPhone = getAddressFieldValue(submission.billing, "Phone", "phone");
  const billingCountry = getAddressFieldValue(
    submission.billing,
    "Country",
    "country",
  );
  const customPhone = getAddressFieldValue(submission.customFields, "phone");

  return [
    normalizePhoneForComparison(customPhone, shippingCountry || billingCountry),
    normalizePhoneForComparison(shippingPhone, shippingCountry),
    normalizePhoneForComparison(billingPhone, billingCountry),
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
) : Promise<{ customer: ShopifyCustomer; created: boolean }> {
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
    return { customer: customerNode, created: false };
  }

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
  shipping: AddressFields,
  billing: AddressFields,
  fallbackFirstName: string,
  fallbackLastName: string,
) {
  const isSameAsShipping = billing?.SameAsShip === "true";
  const shippingAddress = buildAddress(
    shipping,
    fallbackFirstName,
    fallbackLastName,
  );

  if (shippingAddress) {
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
          address: shippingAddress,
          addressTypes: isSameAsShipping ? ["SHIPPING", "BILLING"] : ["SHIPPING"],
        },
      },
    );

    const shippingPayload = await shippingResponse.json();
    const shippingErrors = getGraphQLMessages(shippingPayload, [
      "data",
      "companyLocationAssignAddress",
    ]);
    if (shippingErrors.length > 0) {
      throw new Error(`Shipping address failed: ${shippingErrors.join(", ")}`);
    }
  }

  if (billing && !isSameAsShipping) {
    const billingAddress = buildAddress(
      billing,
      fallbackFirstName,
      fallbackLastName,
    );

    if (!billingAddress) {
      return;
    }

    const billingResponse = await admin.graphql(
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
          address: billingAddress,
          addressTypes: ["BILLING"],
        },
      },
    );

    const billingPayload = await billingResponse.json();
    const billingErrors = getGraphQLMessages(billingPayload, [
      "data",
      "companyLocationAssignAddress",
    ]);
    if (billingErrors.length > 0) {
      throw new Error(`Billing address failed: ${billingErrors.join(", ")}`);
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

function json(data: unknown, init: ResponseInit = {}) {
  return Response.json(data, {
    ...init,
    headers: {
      ...CORS_HEADERS,
      ...(init.headers ?? {}),
    },
  });
}

function handlePreflight(request: Request): Response | null {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }
  return null;
}

export const loader: LoaderFunction = async ({ request }) => {
  // ✅ Handle CORS preflight
  const preflight = handlePreflight(request);
  if (preflight) return preflight;

  const { shop, loggedInCustomerId: shopifyCustomerId } = getProxyParams(request);

  if (!shop) {
    return json({ success: false, error: "Store identification failed." }, { status: 400 });
  }

  if (!shopifyCustomerId) {
    return json({ success: false, error: "Shopify customer ID is required." }, { status: 400 });
  }

  const store = await getStoreByDomain(shop);
  if (!store) {
    return json({ success: false, error: "Store not found." }, { status: 404 });
  }

  const data = await prisma.registrationSubmission.findFirst({
    where: {
      shopifyCustomerId: `gid://shopify/Customer/${shopifyCustomerId}`,
      shopId: store.id,
    },
  });
 
  return json({
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
  try {
    const url = new URL(request.url);
    const shop = url.searchParams.get("shop");

    if (!shop) {
      return json({ success: false, error: "Store identification failed." }, { status: 400 });
    }

    const store = await getStoreByDomain(shop);
    if (!store) {
      return json({ success: false, error: "Store not found." }, { status: 404 });
    }
    if (!store.accessToken) {
      return json(
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
 
    // ✅ Extract main fields
    const companyName = getFieldValueByKeyMatch(allFields, "companyName", {
      startsWith: true,
      endsWith: true,
      includes: true,
    });
    const email =
      allFields.email ||
      allFields.customerEmail ||
      getFieldValueByKeyMatch(allFields, "email", {
        startsWith: true,
        endsWith: true,
        includes: true,
      });
    const firstName = getFieldValueByKeyMatch(allFields, "firstName");
    const lastName = getFieldValueByKeyMatch(allFields, "lastName");
    const contactTitle = getFieldValueByKeyMatch(allFields, "contactTitle");


    // ✅ Basic validation
    if (!companyName) {
      return json(
        { success: false, error: "Company name is required." },
        { status: 400 }
      );
    }
    if(!email) {
      return json(
        { success: false, error: "Email is required." },
        { status: 400 }
      );
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return json({ success: false, error: "Invalid email format." }, { status: 400 });
    }
 
    // ✅ Duplicate email check
    const existing = await prisma.registrationSubmission.findFirst({
      where: { shopId: store.id, email },
    });
    console.log("✅ Existing Registration:", existing);
 
    if (existing) {
      return json({ success: false, error: "Email already registered." }, { status: 409 });
    }

    const { shipping, billing, customFields } = parseFormFields(allFields);
    const phone = formatPhone(
      allFields.phone || shipping.Phone || billing.Phone,
      shipping.Country || billing.Country,
    );
    const normalizedPhone = normalizePhoneForComparison(
      phone,
      shipping.Country || billing.Country,
    );

    if (phone) {
      customFields.phone = phone;
    }

    if (normalizedPhone) {
      const existingPhoneRegistrations = await prisma.registrationSubmission.findMany({
        where: { shopId: store.id },
        select: {
          id: true,
          shipping: true,
          billing: true,
          customFields: true,
        },
      });

      const hasDuplicatePhone = existingPhoneRegistrations.some((submission) =>
        getSubmissionPhoneCandidates(submission).includes(normalizedPhone),
      );

      if (hasDuplicatePhone) {
        return json(
          { success: false, error: "Phone number already registered." },
          { status: 409 },
        );
      }
    }

    const regitrationData = await prisma.registrationSubmission.findFirst({
      where: { shopId: store.id, email },
    });

    if (regitrationData?.companyName === companyName) {
      return json({ success: false, error: "Company already registered." }, { status: 409 });
    }

    const { customer } = await createOrFindCustomer(admin, {
      email,
      firstName,
      lastName,
      phone,
    });

    const { company } = await createOrFindCompany(admin, companyName);
    const location = await getOrCreateCompanyLocation(
      admin,
      company.id,
      companyName,
    );

    await assignCustomerToCompany(admin, company.id, customer.id, location.id);
    await assignLocationAddresses(
      admin,
      location.id,
      shipping,
      billing,
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
        shipping,
        billing,
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

        if (store.submissionEmail) {
          const adminEmailResult = await sendRegistrationEmailForAdmin(
            store.id,
            store.submissionEmail,
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

    return json({
      success: true,
      message: autoApproved
        ? "Registration submitted and approved successfully!"
        : "Registration submitted successfully!",
      autoApproved,
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
    return json({ success: false, error: message }, { status: 500 });
  }
};
 
