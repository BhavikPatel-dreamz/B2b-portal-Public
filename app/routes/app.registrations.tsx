import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
  useFetcher,
  useLoaderData,
  useRevalidator,
  useSearchParams,
} from "react-router";

import { useAppBridge } from "@shopify/app-bridge-react";
import {
  boundary,
  AdminApiContext,
} from "@shopify/shopify-app-react-router/server";
import {fetchAllCatalogs,fetchPriceLists} from "app/utils/b2b-customer.server";
import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { sendCompanyAssignmentEmail } from "app/utils/email";
import { updateCompanyMetafield } from "app/services/company.server";
import EditDetailsModal, {
  type CountryOption,
  type FormField,
  type FormSection,
} from "app/components/registrations/EditDetailsModal";
import {
  DEFAULT_CONFIG,
  SECTION_LABELS,
  deserializeConfig,
  type FieldDef,
  type FormConfig,
  type FieldWidth,
  type StoredConfig,
} from "./app.regitration-form";

interface RegistrationSubmission {
  paymentTermsTemplateId: string;
  id: string;
  companyName: string;
  firstName: string;
  lastName: string;
  creditLimit: string;
  email: string;
  phone: string;
  shipping: {
    phone: string;
  };
  businessType: string;
  website: string | null;
  additionalInfo: string | null;
  shopifyCustomerId: string | null;
  status: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNotes: string | null;
  workflowCompleted: boolean;
  createdAt: string;
}

interface ActionJson {
  existsInDb: boolean;
  intent: string;
  success: boolean;
  message?: string;
  errors?: string[];
  submission?: any;
  customer?: {
    id: string;
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    phone?: string | null;
  } | null;
  company?: {
    id: string;
    name: string;
    locationId?: string;
    locationName?: string;
    paymentTermsTemplateId?: string | null; // ✅ add
    creditLimit?: number | null;
    zip?: string | null;
    address1?: string | null;
    city?: string | null;
    countryCode?: string | null;
    phone?: string | null;
  } | null;
  data?: {
    customerCreate?: { userErrors: { message: string; field?: string[] }[] };
    companyCreate?: { userErrors: { message: string; field?: string[] }[] };
    companyContactCreate?: {
      userErrors: { message: string; field?: string[] }[];
    };
    companyAssignMainContact?: {
      userErrors: { message: string; field?: string[] }[];
    };
    companyAssignCustomerAsContact?: {
      userErrors: { message: string; field?: string[] }[];
    };
  };
}

const normalizeCustomerId = (id?: string | null) => {
  if (!id) return null;
  return id.startsWith("gid://") ? id : `gid://shopify/Customer/${id}`;
};

export function buildUserErrorList(payload: any) {
  const errors: string[] = [];
  if (payload?.errors?.length) {
    errors.push(
      ...payload.errors.map((err: { message: string } | string) =>
        typeof err === "string" ? err : err.message || "Unknown error",
      ),
    );
  }

  const userErrors =
    payload?.data?.customerCreate?.userErrors ||
    payload?.data?.companyCreate?.userErrors ||
    payload?.data?.companyContactCreate?.userErrors ||
    payload?.data?.companyAssignMainContact?.userErrors ||
    payload?.data?.companyAssignCustomerAsContact?.userErrors ||
    [];

  if (userErrors.length) {
    errors.push(
      ...userErrors.map(
        (err: { message: string; field?: string[] }) =>
          err?.message || (err?.field || []).join(".") || "Error",
      ),
    );
  }

  return errors;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!store) {
    return Response.json(
      { submissions: [], storeMissing: true },
      { status: 404 },
    );
  }

  const formFieldConfig = await prisma.formFieldConfig.findUnique({
    where: { shopId: store.id },
  });

  let config = DEFAULT_CONFIG;
  if (formFieldConfig?.fields) {
    try {
      const stored = formFieldConfig.fields as unknown as StoredConfig;
      if (
        Array.isArray(stored) &&
        stored.length > 0 &&
        stored.every(
          (g) =>
            g.step?.id &&
            g.step?.label &&
            Array.isArray(g.fields) &&
            g.fields.every((f) => f.key && f.label && f.type !== undefined),
        )
      ) {
        config = deserializeConfig(stored);
      }
    } catch {
      config = DEFAULT_CONFIG;
    }
  }

  const [pendingSubmissions, approvedSubmissions, rejectedSubmissions] =
    await Promise.all([
      prisma.registrationSubmission.findMany({
        where: {
          shopId: store.id,
          status: "PENDING",
          shopifyCustomerId: { not: null },
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.registrationSubmission.findMany({
        where: {
          shopId: store.id,
          status: "APPROVED",
          shopifyCustomerId: { not: null },
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.registrationSubmission.findMany({
        where: {
          shopId: store.id,
          status: "REJECTED",
          shopifyCustomerId: { not: null },
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);

  const submissions = [
    ...pendingSubmissions,
    ...approvedSubmissions,
    ...rejectedSubmissions,
  ];

  const companies = await prisma.companyAccount.findMany({
    where: { shopId: store.id },
    orderBy: { name: "asc" },
  });

  const companiesWithLocations = await Promise.all(
    companies.map(async (c) => {
      if (!c.shopifyCompanyId)
        return { ...c, locationId: null, locationName: null };
      try {
        const locationResp = await admin.graphql(
          `#graphql
          query GetCompanyLocation($companyId: ID!) {
            company(id: $companyId) {
              locations(first: 1) { nodes { id name } }
            }
          }`,
          { variables: { companyId: c.shopifyCompanyId } },
        );
        const locationJson = await locationResp.json();
        const loc = locationJson?.data?.company?.locations?.nodes?.[0] || null;
        return {
          ...c,
          locationId: loc?.id || null,
          locationName: loc?.name || null,
        };
      } catch (err) {
        console.warn("Unable to fetch location for company", c.id, err);
        return { ...c, locationId: null, locationName: null };
      }
    }),
  );

  const paymentTermsResponse = await admin.graphql(
    `#graphql
    query { paymentTermsTemplates { id name paymentTermsType dueInDays description translatedName } }`,
  );
  const paymentTermsData = await paymentTermsResponse.json();
  const paymentTermsTemplates = paymentTermsData.data.paymentTermsTemplates;

  const shippingCountriesResponse = await admin.graphql(
    `#graphql
    query GetShippingCountriesWithProvinces {
      deliveryProfiles(first: 1) {
        nodes {
          profileLocationGroups {
            locationGroupZones(first: 50) {
              nodes {
                zone {
                  countries {
                    code { countryCode }
                    provinces { code name }
                  }
                }
              }
            }
          }
        }
      }
      shop {
        countriesInShippingZones { countryCodes includeRestOfWorld }
      }
    }`,
  );
  const shippingCountriesPayload = await shippingCountriesResponse.json();
  const validCountryCodes = new Set<string>(
    shippingCountriesPayload?.data?.shop?.countriesInShippingZones
      ?.countryCodes || [],
  );

  type ProvinceOption = { value: string; label: string };
  const countryProvincesMap = new Map<string, ProvinceOption[]>();
  const profiles =
    shippingCountriesPayload?.data?.deliveryProfiles?.nodes || [];
  for (const profile of profiles) {
    for (const group of profile.profileLocationGroups || []) {
      for (const zoneNode of group.locationGroupZones?.nodes || []) {
        for (const country of zoneNode.zone?.countries || []) {
          const countryCode: string = country.code?.countryCode;
          if (!countryCode || !validCountryCodes.has(countryCode)) continue;
          const provinces: ProvinceOption[] = (country.provinces || []).map(
            (p: { code: string; name: string }) => ({
              value: p.code,
              label: p.name,
            }),
          );
          if (countryProvincesMap.has(countryCode)) {
            const existing = countryProvincesMap.get(countryCode)!;
            const existingCodes = new Set(existing.map((e) => e.value));
            for (const p of provinces) {
              if (!existingCodes.has(p.value)) existing.push(p);
            }
          } else {
            countryProvincesMap.set(countryCode, provinces);
          }
        }
      }
    }
  }

  const shippingCountryOptions: CountryOption[] = Array.from(
    validCountryCodes,
  ).map((countryCode: string) => ({
    value: countryCode,
    label:
      new Intl.DisplayNames(["en"], { type: "region" }).of(countryCode) ||
      countryCode,
  }));
  const shippingProvincesByCountry = Object.fromEntries(countryProvincesMap);

  // ── NEW: fetch catalogs + price lists in parallel ──
  const [allCatalogs, priceLists] = await Promise.all([
    fetchAllCatalogs(admin),
    fetchPriceLists(admin),
  ]);

  return Response.json({
    submissions: submissions.map((s) => ({
      ...s,
      createdAt: s.createdAt.toISOString(),
    })),
    companies: companiesWithLocations.map((company) => ({
      ...company,
      creditLimit: company.creditLimit.toString(),
      updatedAt: company.updatedAt.toISOString(),
    })),
    formConfig: config,
    shippingCountryOptions:
      shippingCountryOptions.length > 0
        ? [{ value: "", label: "Country" }, ...shippingCountryOptions]
        : DEFAULT_COUNTRY_OPTIONS,
    shippingProvincesByCountry,
    paymentTermsTemplates,
    // ── NEW ──
    allCatalogs,
    priceLists,
    storeMissing: false,
  });
};

const parseForm = async (request: Request) => {
  const formData = await request.formData();
  return Object.fromEntries(formData);
};

export async function assignCompanyToCustomer(
  admin: AdminApiContext,
  customerId: string,
  companyId: string,
  companyLocationId: string,
) {
  if (!customerId || !companyId || !companyLocationId) {
    return {
      success: false,
      error: "Company, customer and location are required",
      step: "validation",
    };
  }

  try {
    /* 1️⃣ Get contact roles AND assign customer as contact IN PARALLEL */
    const [companyRolesRes, contactRes] = await Promise.all([
      // Get company contact roles
      admin.graphql(
        `#graphql
        query getCompany($companyId: ID!) {
          company(id: $companyId) {
            contactRoles(first: 10) {
              edges { node { id name } }
            }
          }
        }`,
        { variables: { companyId } },
      ),

      admin.graphql(
        `#graphql
        mutation companyAssignCustomerAsContact(
          $companyId: ID!
          $customerId: ID!
        ) {
          companyAssignCustomerAsContact(
            companyId: $companyId
            customerId: $customerId
          ) {
            companyContact { id }
            userErrors { message }
          }
        }`,
        { variables: { companyId, customerId } },
      ),
    ]);

    const [companyJson, contactJson] = await Promise.all([
      companyRolesRes.json(),
      contactRes.json(),
    ]);

    // ── Resolve companyContactId ─────────────────────────────────────────
    let companyContactId: string | null = null;
    let wasAlreadyContact = false;

    const contactPayload = contactJson.data?.companyAssignCustomerAsContact;

    if (contactPayload?.userErrors?.length) {
      const errorMessage: string = contactPayload.userErrors[0].message;
      const isAlreadyAssociated =
        errorMessage.toLowerCase().includes("already associated") ||
        errorMessage.toLowerCase().includes("already");

      if (isAlreadyAssociated) {
        // ✅ Customer is already a contact — fetch all contacts and match by customerId
        console.log(
          "⚠️ Customer already a contact, fetching existing contact...",
        );

        const existingContactRes = await admin.graphql(
          `#graphql
          query getCompanyContacts($companyId: ID!) {
            company(id: $companyId) {
              contacts(first: 50) {
                edges {
                  node {
                    id
                    customer { id }
                  }
                }
              }
            }
          }`,
          { variables: { companyId } },
        );

        const existingContactJson = await existingContactRes.json();
        const contacts: Array<{
          node: { id: string; customer: { id: string } };
        }> = existingContactJson?.data?.company?.contacts?.edges || [];

        // ✅ Normalize both IDs before comparing (strip gid:// prefix differences)
        const normalizeId = (id: string) => id?.split("/").pop()?.trim() || id;

        const matchingContact = contacts.find(
          (edge) =>
            normalizeId(edge.node.customer?.id) === normalizeId(customerId),
        );

        if (matchingContact) {
          companyContactId = matchingContact.node.id;
          wasAlreadyContact = true;
          console.log("✅ Found existing company contact:", companyContactId);
        } else {
          // ✅ Last resort: use the first contact if only one exists
          if (contacts.length === 1) {
            companyContactId = contacts[0].node.id;
            wasAlreadyContact = true;
            console.log(
              "✅ Using sole existing contact as fallback:",
              companyContactId,
            );
          } else {
            console.error(
              "❌ Could not find matching contact among",
              contacts.length,
              "contacts for customerId:",
              customerId,
            );
            return {
              success: false,
              error:
                "Could not find existing company contact for this customer",
              step: "getExistingContact",
            };
          }
        }
      } else {
        // Unrelated error — fail properly
        console.error("❌ Contact assignment failed:", errorMessage);
        return {
          success: false,
          error: errorMessage,
          step: "assignContact",
        };
      }
    } else {
      // Fresh assignment succeeded
      companyContactId = contactPayload?.companyContact?.id ?? null;
      console.log("✅ Customer assigned as new contact:", companyContactId);
    }

    if (!companyContactId) {
      return {
        success: false,
        error: "Failed to resolve company contact ID",
        step: "resolveContact",
      };
    }

    // ── Resolve contact role ─────────────────────────────────────────────
    const roles = companyJson.data?.company?.contactRoles?.edges || [];
    const companyContactRoleId =
      roles.find(
        (edge: { node: { name: string } }) =>
          edge.node.name.toLowerCase() === "company admin",
      )?.node?.id || roles[0]?.node?.id;

    if (!companyContactRoleId) {
      console.error("❌ No company contact roles found");
      return {
        success: false,
        error: "No company contact roles available",
        step: "getRoles",
      };
    }

    /* 2️⃣ Assign role AND set main contact IN PARALLEL */
    const [roleRes, mainContactRes] = await Promise.all([
      admin.graphql(
        `#graphql
        mutation companyContactAssignRole(
          $companyContactId: ID!
          $companyContactRoleId: ID!
          $companyLocationId: ID!
        ) {
          companyContactAssignRole(
            companyContactId: $companyContactId
            companyContactRoleId: $companyContactRoleId
            companyLocationId: $companyLocationId
          ) {
            companyContactRoleAssignment { id }
            userErrors { message }
          }
        }`,
        {
          variables: {
            companyContactId,
            companyContactRoleId,
            companyLocationId,
          },
        },
      ),

      admin.graphql(
        `#graphql
        mutation companyAssignMainContact(
          $companyId: ID!
          $companyContactId: ID!
        ) {
          companyAssignMainContact(
            companyId: $companyId
            companyContactId: $companyContactId
          ) {
            company { id name }
            userErrors { message }
          }
        }`,
        { variables: { companyId, companyContactId } },
      ),
    ]);

    const [roleJson, mainContactJson] = await Promise.all([
      roleRes.json(),
      mainContactRes.json(),
    ]);

    // ── Handle role assignment result ────────────────────────────────────
    const rolePayload = roleJson.data?.companyContactAssignRole;
    if (rolePayload?.userErrors?.length) {
      const roleErrorMessage: string = rolePayload.userErrors[0].message;
      const alreadyAssigned =
        roleErrorMessage.toLowerCase().includes("already been assigned") ||
        roleErrorMessage.toLowerCase().includes("already assigned");

      if (alreadyAssigned) {
        // ✅ Non-critical — role already exists, continue
        console.log(
          "ℹ️ Contact already has role at this location, continuing...",
        );
      } else {
        console.error("❌ Critical role assignment error:", roleErrorMessage);
        return {
          success: false,
          error: roleErrorMessage,
          step: "assignRole",
        };
      }
    }

    // ── Handle main contact assignment result ────────────────────────────
    const mainContactPayload = mainContactJson.data?.companyAssignMainContact;
    if (mainContactPayload?.userErrors?.length) {
      const mainContactError: string = mainContactPayload.userErrors[0].message;
      const alreadyMain =
        mainContactError.toLowerCase().includes("already") ||
        mainContactError.toLowerCase().includes("main contact");

      if (alreadyMain) {
        // ✅ Already the main contact — treat as success
        console.log(
          "ℹ️ Customer is already the main contact, treating as success.",
        );
        return {
          success: true,
          wasAlreadyContact,
          companyContactId,
          message: "Customer was already the main contact — no changes needed",
        };
      }

      console.error("❌ Main contact assignment error:", mainContactError);
      return {
        success: false,
        error: mainContactError,
        step: "assignMainContact",
      };
    }

    return {
      success: true,
      wasAlreadyContact,
      companyContactId,
      company: mainContactPayload?.company,
      message: wasAlreadyContact
        ? "Contact already existed — role and main contact updated successfully"
        : "Customer assigned as main contact successfully",
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
      step: "general",
    };
  }
}

const formatPhone = (
  phone: string,
  countryCode: string,
): string | undefined => {
  if (!phone) return undefined;

  if (phone.startsWith("+")) {
    const digits = phone.replace(/\D/g, "");
    if (countryCode === "IN" && digits.length !== 12) {
      console.warn(
        `⚠️ Phone digit count invalid for IN: ${phone} (${digits.length} digits, need 12)`,
      );
      return undefined;
    }
    return phone;
  }

  const cleaned = phone.replace(/\D/g, "");
  if (countryCode === "IN") {
    if (cleaned.length === 10) return `+91${cleaned}`;
    if (cleaned.length === 11 && cleaned.startsWith("0"))
      return `+91${cleaned.slice(1)}`;
    console.warn(
      `⚠️ Cannot format IN phone: ${phone} (${cleaned.length} digits)`,
    );
    return undefined;
  }

  return `+${cleaned}`;
};

function parseFormFields(form: Record<string, any>) {
  const shipping: Record<string, any> = {};
  const billing: Record<string, any> = {};
  const customFields: Record<string, any> = {};

  const coreKeys = [
    "companyName",
    "email",
    "firstName",
    "lastName",
    "contactTitle",
    "shopifyCustomerId",
    "paymentTerms",
    "creditLimit",
    "customerEmail",
    "companyId",
    "customerId",
    "phone",
    "intent",
    "billSameAsShip",
    "taxId",
  ];

  Object.entries(form).forEach(([key, value]) => {
    if (key.startsWith("ship")) {
      // e.g. shipAddr1 → Addr1, shipCity → City
      shipping[key.replace("ship", "")] = value;
    } else if (key.startsWith("bill")) {
      // e.g. billAddr1 → Addr1, billCity → City
      billing[key.replace("bill", "")] = value;
    } else if (!coreKeys.includes(key)) {
      // anything else that isn't a core key → customFields
      customFields[key] = value;
    }
  });

  return { shipping, billing, customFields };
}

function mapEditFormAddressKey(key: string) {
  const shippingMap: Record<string, string> = {
    shDepartment: "Dept",
    shFirstName: "FirstName",
    shLastName: "LastName",
    shPhone: "Phone",
    shAddr1: "Addr1",
    shAddr2: "Addr2",
    shCity: "City",
    shCountry: "Country",
    shState: "State",
    shZip: "Zip",
  };

  const billingMap: Record<string, string> = {
    biDepartment: "Dept",
    biFirstName: "FirstName",
    biLastName: "LastName",
    biPhone: "Phone",
    biAddr1: "Addr1",
    biAddr2: "Addr2",
    biCity: "City",
    biCountry: "Country",
    biState: "State",
    biZip: "Zip",
  };

  if (key.startsWith("ship")) {
    return { bucket: "shipping" as const, field: key.replace(/^ship/, "") };
  }

  if (key.startsWith("bill")) {
    return { bucket: "billing" as const, field: key.replace(/^bill/, "") };
  }

  if (shippingMap[key]) {
    return { bucket: "shipping" as const, field: shippingMap[key] };
  }

  if (billingMap[key]) {
    return { bucket: "billing" as const, field: billingMap[key] };
  }

  return null;
}
// ── Assign shipping/billing address to company location ──
export async function assignLocationAddresses(
  admin: any,
  locationId: string,
  registrationData: any,
) {
  if (!registrationData) {
    console.log("⚠️ assignLocationAddresses: No registrationData, skipping.");
    return;
  }

  const shipping = registrationData.shipping;
  const billing = registrationData.billing;
  const isSameAsBilling = billing?.SameAsShip === "true";

  console.log("📦 assignLocationAddresses called:", {
    locationId,
    isSameAsBilling,
    shipping,
    billing,
  });

  // ── Shipping address ──
  if (shipping) {
    const shippingAddress = {
      address1: shipping.Addr1 || "",
      address2: shipping.Addr2 || "",
      city: shipping.City || "",
      zip: shipping.Zip || "",
      countryCode: shipping.Country || "",
      zoneCode: shipping.State || "",
      phone: formatPhone(shipping.Phone, shipping.Country),
      firstName: shipping.FirstName || "",
      lastName: shipping.LastName || "",
      recipient:
        `${shipping.FirstName || ""} ${shipping.LastName || ""}`.trim(),
    };

    const addressTypes = isSameAsBilling
      ? ["SHIPPING", "BILLING"]
      : ["SHIPPING"];

    console.log("🚚 Assigning SHIPPING address:", {
      shippingAddress,
      addressTypes,
    });

    const shippingRes = await admin
      .graphql(
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
        { variables: { locationId, address: shippingAddress, addressTypes } },
      )
      .then((r: any) => r.json());

    const shippingUserErrors =
      shippingRes?.data?.companyLocationAssignAddress?.userErrors || [];

    if (shippingUserErrors.length > 0) {
      console.error(
        "❌ SHIPPING address userErrors:",
        JSON.stringify(shippingUserErrors, null, 2),
      );
      console.error(
        "❌ Input that caused error:",
        JSON.stringify({ shippingAddress, addressTypes }, null, 2),
      );
    } else {
      console.log(
        "✅ SHIPPING address assigned successfully:",
        shippingRes?.data?.companyLocationAssignAddress?.addresses,
      );
    }
  }

  // ── Billing address (only if different from shipping) ──
  if (billing && !isSameAsBilling) {
    const billingAddress = {
      address1: billing.Addr1 || "",
      address2: billing.Addr2 || "",
      city: billing.City || "",
      zip: billing.Zip || "",
      countryCode: billing.Country || "",
      zoneCode: billing.State || "",
      phone: formatPhone(billing.Phone, billing.Country),
      firstName: billing.FirstName || "",
      lastName: billing.LastName || "",
      recipient: `${billing.FirstName || ""} ${billing.LastName || ""}`.trim(),
    };

    console.log("🧾 Assigning BILLING address:", billingAddress);

    const billingRes = await admin
      .graphql(
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
      )
      .then((r: any) => r.json());

    const billingUserErrors =
      billingRes?.data?.companyLocationAssignAddress?.userErrors || [];

    if (billingUserErrors.length > 0) {
      console.error(
        "❌ BILLING address userErrors:",
        JSON.stringify(billingUserErrors, null, 2),
      );
      console.error(
        "❌ Input that caused error:",
        JSON.stringify(billingAddress, null, 2),
      );
    } else {
      console.log(
        "✅ BILLING address assigned successfully:",
        billingRes?.data?.companyLocationAssignAddress?.addresses,
      );
    }
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!store) {
    return Response.json(
      { intent: "unknown", success: false, errors: ["Store not found"] },
      { status: 404 },
    );
  }

  const form = await parseForm(request);
  const intent = (form.intent as string) || "";

  try {
    switch (intent) {
      case "checkCustomer": {
        const email = (form.email as string)?.trim();
        if (!email) {
          return Response.json({
            intent,
            success: false,
            errors: ["Email is required"],
          });
        }

        console.log("⏳ Checking customer:", email);

        const [customerResponse, registration, user] = await Promise.all([
          admin.graphql(
            `#graphql
            query CustomersByEmail($query: String!) {
              customers(first: 1, query: $query) {
                nodes {
                  id
                  email
                  firstName
                  lastName
                  phone
                }
              }
            }
          `,
            {
              variables: {
                query: `email:${email}`,
              },
            },
          ),
          prisma.registrationSubmission.findFirst({
            where: { email },
          }),
          prisma.user.findFirst({
            where: { email },
          }),
        ]);

        const customerPayload = await customerResponse.json();
        const customer = customerPayload?.data?.customers?.nodes?.[0] || null;

        console.log("✅ Customer check completed:", {
          exists: !!customer,
          hasRegistration: !!registration || !!user,
        });

        return Response.json({
          intent,
          success: true,
          customer,
          existsInDb: !!registration,
          message: customer ? "Customer found" : "No customer found",
        });
      }

      case "createCustomer": {
        const email = (form.email as string)?.trim();
        const firstName = (form.firstName as string)?.trim();
        const lastName = (form.lastName as string)?.trim();
        const phone = (form.phone as string)?.trim() || undefined;
        const contactTitle = (form.contactTitle as string)?.trim() || "";

        if (!email || !firstName) {
          return Response.json({
            intent,
            success: false,
            errors: ["First name and email are required"],
          });
        }

        // ── Parse shipping / billing / custom fields ──
        const { shipping, billing, customFields } = parseFormFields(
          form as Record<string, any>,
        );

        // ── Create customer in Shopify ──
        const response = await admin.graphql(
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

        const payload = await response.json();
        const userErrors = payload?.data?.customerCreate?.userErrors || [];

        if (userErrors.length > 0) {
          const errors = buildUserErrorList({
            data: { customerCreate: { userErrors } },
          });
          return Response.json({ intent, success: false, errors });
        }

        const customer = payload?.data?.customerCreate?.customer;
        const registrationData = await prisma.registrationSubmission.findFirst({
          where: { email },
        });

        if (!registrationData) {
          await prisma.registrationSubmission.create({
            data: {
              firstName,
              lastName: lastName || "",
              email,
              contactTitle,
              shopifyCustomerId: customer?.id || null,
              status: "PENDING",
              companyName: "",
              shopId: store.id,
              shipping,
              billing,
              customFields,
            },
          });
        } else {
          await prisma.registrationSubmission.update({
            where: { id: registrationData.id },
            data: {
              firstName,
              lastName: lastName || "",
              email,
              contactTitle,
              shopifyCustomerId: customer?.id || null,
              status: "PENDING",
              companyName: registrationData.companyName || "",
              shopId: store.id,
              shipping,
              billing,
              customFields,
            },
          });
        }

        // ── UPSERT user record ──
        const userData = await prisma.user.findFirst({
          where: {
            shopifyCustomerId: customer?.id || null,
            email,
          },
        });

        if (!userData) {
          await prisma.user.create({
            data: {
              email,
              firstName,
              lastName: lastName || "",
              shopifyCustomerId: customer?.id || null,
              shopId: store.id,
              status: "PENDING",
              role: "STORE_ADMIN",
              password: "",
              companyRole: "admin",
            },
          });
        } else {
          await prisma.user.update({
            where: { id: userData.id },
            data: {
              firstName,
              lastName: lastName || "",
              shopifyCustomerId: customer?.id || null,
              shopId: store.id,
              status: "PENDING",
              role: "STORE_ADMIN",
              password: "",
              companyRole: "admin",
            },
          });
        }

        return Response.json({
          intent,
          success: true,
          customer,
          message: "Customer created",
        });
      }

      case "updateCustomer": {
        const customerId = (form.customerId as string)?.trim();
        const email = (form.email as string)?.trim();
        const firstName = (form.firstName as string)?.trim();
        const lastName = (form.lastName as string)?.trim();
        const phone = (form.phone as string)?.trim() || undefined;
        const contactTitle = (form.contactTitle as string)?.trim() || "";

        if (!customerId) {
          return Response.json({
            intent,
            success: false,
            errors: ["Customer ID is required"],
          });
        }

        // ── Parse shipping / billing / custom fields ──
        const { shipping, billing, customFields } = parseFormFields(
          form as Record<string, any>,
        );

        // ── Update customer in Shopify ──
        const response = await admin.graphql(
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
                id: customerId,
                email,
                firstName,
                lastName: lastName || undefined,
                phone,
              },
            },
          },
        );

        const payload = await response.json();
        const errors = buildUserErrorList(payload);

        if (errors.length) {
          return Response.json({ intent, success: false, errors });
        }

        const customer = payload?.data?.customerUpdate?.customer;
        console.log(customer, "customer - updateCustomer");

        // ── UPSERT registrationSubmission (with shipping / billing / customFields) ──
        const registrationData = await prisma.registrationSubmission.findFirst({
          where: { shopifyCustomerId: customerId },
        });

        if (!registrationData) {
          // No existing record → create one so data is never lost
          await prisma.registrationSubmission.create({
            data: {
              firstName,
              lastName: lastName || "",
              email,
              contactTitle,
              shopifyCustomerId: customerId,
              status: "PENDING",
              companyName: "",
              shopId: store.id,
              shipping,
              billing,
              customFields,
            },
          });
        } else {
          await prisma.registrationSubmission.update({
            where: { id: registrationData.id },
            data: {
              firstName,
              lastName: lastName || "",
              email,
              contactTitle,
              shopifyCustomerId: customerId,
              status: "PENDING",
              shipping,
              billing,
              customFields,
            },
          });
        }

        // ── UPSERT user record ──
        const userData = await prisma.user.findFirst({
          where: { shopifyCustomerId: customerId },
        });

        if (userData) {
          await prisma.user.update({
            where: { id: userData.id },
            data: {
              email,
              firstName,
              lastName: lastName || "",
              shopifyCustomerId: customerId,
              shopId: store.id,
              status: "PENDING",
              role: "STORE_ADMIN",
              password: "",
              companyRole: "admin",
            },
          });
        } else {
          // Guard: create user if somehow missing
          await prisma.user.create({
            data: {
              email,
              firstName,
              lastName: lastName || "",
              shopifyCustomerId: customerId,
              shopId: store.id,
              status: "PENDING",
              role: "STORE_ADMIN",
              password: "",
              companyRole: "admin",
            },
          });
        }

        return Response.json({
          intent,
          success: true,
          customer,
          message: "Customer updated",
        });
      }

      case "checkCompany": {
        const companyName = (form.companyName as string)?.trim();

        const response = await admin.graphql(
          `#graphql
          query CompaniesByName($query: String!) {
            companies(first: 1, query: $query) {
              nodes {
                id
                name
                defaultCursor
                mainContact {
                  id
                }
                locations(first: 1) {
                  nodes {
                    id
                    name
                  }
                }
              }
            }
          }
        `,
          {
            variables: {
              query: `name:'${companyName}'`,
            },
          },
        );

        const payload = await response.json();
        const company = payload?.data?.companies?.nodes?.[0] || null;

        let companyData = null;
        if (company) {
          const location = company.locations?.nodes?.[0] || null;
          companyData = {
            id: company.id,
            name: company.name,
            locationId: location?.id || null,
            locationName: location?.name || null,
          };
        }

        const companyExists = await prisma.companyAccount.findFirst({
          where: { name: companyName },
        });

        return Response.json({
          intent,
          success: true,
          company: companyData,
          existsInDb: !!companyExists,
          message: company ? "Company exists" : "No company found",
        });
      }

      case "createCompany": {
        const companyName = (form.companyName as string)?.trim();
        const paymentTermsTemplateId = (form.paymentTerms as string)?.trim();
        const creditLimit = (form.creditLimit as string)?.trim();
        const customerEmail = (form.customerEmail as string)?.trim();
        const firstName = (form.firstName as string)?.trim();
        const lastName = (form.lastName as string)?.trim();

        // ── Fetch registration data for address ──
        const RegitrasionData = await prisma.registrationSubmission.findFirst({
          where: { email: customerEmail, shopId: store.id },
        });

        if (!companyName) {
          return Response.json({
            intent,
            success: false,
            errors: ["Company name is required"],
          });
        }

        // ── CHECK: Does company already exist in Shopify? ──
        const existingShopifyResponse = await admin.graphql(
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
            variables: { query: `name:'${companyName}'` },
          },
        );

        const existingShopifyPayload = await existingShopifyResponse.json();
        const existingShopifyCompany =
          existingShopifyPayload?.data?.companies?.nodes?.[0] || null;

        // ── CHECK: Does company already exist in local DB? ──
        const existingLocalCompany = await prisma.companyAccount.findFirst({
          where: { name: companyName, shopId: store.id },
        });

        let companyId: string;
        let locationId: string;
        let locationName: string;

        if (existingShopifyCompany) {
          // ── COMPANY EXISTS IN SHOPIFY → UPDATE ──
          console.log(
            "🔄 Company already exists in Shopify, updating:",
            existingShopifyCompany.id,
          );

          companyId = existingShopifyCompany.id;
          const existingLocation =
            existingShopifyCompany.locations?.nodes?.[0] || null;

          if (!existingLocation) {
            return Response.json({
              intent,
              success: false,
              errors: ["Existing company location not found"],
            });
          }

          locationId = existingLocation.id;
          locationName = existingLocation.name;

          await Promise.all([
            creditLimit
              ? updateCompanyMetafield(admin, companyId, {
                  namespace: "custom",
                  key: "company_credit_limit",
                  value: creditLimit.toString(),
                  type: "number_decimal",
                })
              : Promise.resolve(),

            paymentTermsTemplateId
              ? admin
                  .graphql(
                    `#graphql
                    mutation UpdateCompanyLocation(
                      $companyLocationId: ID!
                      $paymentTermsTemplateId: ID!
                    ) {
                      companyLocationUpdate(
                        companyLocationId: $companyLocationId
                        input: {
                          buyerExperienceConfiguration: {
                            paymentTermsTemplateId: $paymentTermsTemplateId
                          }
                        }
                      ) {
                        companyLocation { id }
                        userErrors { field message }
                      }
                    }`,
                    {
                      variables: {
                        companyLocationId: locationId,
                        paymentTermsTemplateId,
                      },
                    },
                  )
                  .then((res) => res.json())
              : Promise.resolve(),
          ]);

          // ✅ Assign address for existing company
          await assignLocationAddresses(admin, locationId, RegitrasionData);
        } else {
          // ── COMPANY DOES NOT EXIST → CREATE NEW ──
          console.log("✅ Creating new company:", companyName);

          const createCompanyResponse = await admin.graphql(
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

          const companyPayload = await createCompanyResponse.json();
          const companyErrors = buildUserErrorList(companyPayload);

          if (companyErrors.length) {
            return Response.json({
              intent,
              success: false,
              errors: companyErrors,
            });
          }

          companyId = companyPayload.data.companyCreate.company.id;

          const [locationPayload] = await Promise.all([
            admin
              .graphql(
                `#graphql
                query GetCompanyLocation($companyId: ID!) {
                  company(id: $companyId) {
                    locations(first: 1) {
                      nodes { id name }
                    }
                  }
                }`,
                { variables: { companyId } },
              )
              .then((res) => res.json()),

            creditLimit
              ? updateCompanyMetafield(admin, companyId, {
                  namespace: "custom",
                  key: "company_credit_limit",
                  value: creditLimit.toString(),
                  type: "number_decimal",
                })
              : Promise.resolve(),
          ]);

          const newLocation =
            locationPayload?.data?.company?.locations?.nodes?.[0];
          if (!newLocation) {
            return Response.json({
              intent,
              success: false,
              errors: ["Company location not found after creation"],
            });
          }

          locationId = newLocation.id;
          locationName = newLocation.name;

          if (paymentTermsTemplateId) {
            const updateLocationResponse = await admin.graphql(
              `#graphql
              mutation UpdateCompanyLocation(
                $companyLocationId: ID!
                $paymentTermsTemplateId: ID!
              ) {
                companyLocationUpdate(
                  companyLocationId: $companyLocationId
                  input: {
                    buyerExperienceConfiguration: {
                      paymentTermsTemplateId: $paymentTermsTemplateId
                    }
                  }
                ) {
                  companyLocation { id }
                  userErrors { field message }
                }
              }`,
              {
                variables: {
                  companyLocationId: locationId,
                  paymentTermsTemplateId,
                },
              },
            );

            const updateLocationPayload = await updateLocationResponse.json();
            const locationErrors = buildUserErrorList(updateLocationPayload);
            if (locationErrors.length) {
              return Response.json({
                intent,
                success: false,
                errors: locationErrors,
              });
            }
          }

          // ✅ Assign address for new company
          await assignLocationAddresses(admin, locationId, RegitrasionData);
        }

        // ── UPSERT company in local DB ──
        const [companyData, linkedUser] = await Promise.all([
          prisma.companyAccount.upsert({
            where: {
              shopId_shopifyCompanyId: {
                shopId: store.id,
                shopifyCompanyId: companyId,
              },
            },
            update: {
              name: companyName,
              paymentTerm: paymentTermsTemplateId || null,
              creditLimit: creditLimit ? Number(creditLimit) : undefined,
              contactEmail: customerEmail || "",
              contactName: `${firstName || ""} ${lastName || ""}`.trim() || "",
            },
            create: {
              shopId: store.id,
              name: companyName,
              shopifyCompanyId: companyId,
              paymentTerm: paymentTermsTemplateId || null,
              creditLimit: creditLimit ? Number(creditLimit) : undefined,
              contactEmail: customerEmail || "",
              contactName: `${firstName || ""} ${lastName || ""}`.trim() || "",
            },
          }),

          customerEmail
            ? prisma.user.findFirst({
                where: {
                  OR: [
                    { email: customerEmail },
                    { shopId: store.id, companyId: null, status: "PENDING" },
                  ],
                },
                orderBy: { createdAt: "desc" },
              })
            : prisma.user.findFirst({
                where: { shopId: store.id, companyId: null, status: "PENDING" },
                orderBy: { createdAt: "desc" },
              }),
        ]);

        await Promise.all([
          linkedUser
            ? prisma.user.update({
                where: { id: linkedUser.id },
                data: { companyId: companyData.id },
              })
            : Promise.resolve(),
        ]);

        return Response.json({
          intent,
          success: true,
          wasExisting: !!existingShopifyCompany || !!existingLocalCompany,
          company: {
            id: companyId,
            name: companyName,
            locationId,
            locationName,
            paymentTermsTemplateId: paymentTermsTemplateId || null,
            creditLimit: creditLimit ? Number(creditLimit) : null,
          },
          message: existingShopifyCompany
            ? "Company already existed — details updated"
            : "",
        });
      }

      case "updateCompany": {
        const companyId = (form.companyId as string)?.trim();
        const companyName = (form.companyName as string)?.trim();
        const paymentTermsTemplateId = (form.paymentTerms as string)?.trim();
        const creditLimit = (form.creditLimit as string)?.trim();
        const customerEmail = (form.customerEmail as string)?.trim();

        if (!companyId || !companyName) {
          return Response.json({
            intent,
            success: false,
            errors: ["Company ID and company name are required"],
          });
        }

        const duplicateShopifyResponse = await admin.graphql(
          `#graphql
          query CompaniesByName($query: String!) {
            companies(first: 2, query: $query) {
              nodes { id name }
            }
          }`,
          { variables: { query: `name:'${companyName}'` } },
        );
        const duplicatePayload = await duplicateShopifyResponse.json();
        const duplicateShopifyCompany =
          duplicatePayload?.data?.companies?.nodes?.find(
            (c: any) => c.id !== companyId,
          );

        const duplicateLocalCompany = await prisma.companyAccount.findFirst({
          where: {
            name: companyName,
            shopId: store.id,
            shopifyCompanyId: { not: companyId },
          },
        });

        if (duplicateShopifyCompany || duplicateLocalCompany) {
          return Response.json({
            intent,
            success: false,
            errors: [`Company "${companyName}" already exists`],
          });
        }

        const updateCompanyResponse = await admin.graphql(
          `#graphql
          mutation CompanyUpdate($companyId: ID!, $input: CompanyInput!) {
            companyUpdate(companyId: $companyId, input: $input) {
              company { id name }
              userErrors { field message }
            }
          }`,
          {
            variables: {
              companyId,
              input: { name: companyName },
            },
          },
        );

        const companyPayload = await updateCompanyResponse.json();
        const companyErrors = buildUserErrorList(companyPayload);

        if (companyErrors.length) {
          return Response.json({
            intent,
            success: false,
            errors: companyErrors,
          });
        }

        const [locationPayload, companyExists, linkedUser] = await Promise.all([
          admin
            .graphql(
              `#graphql
              query GetCompanyLocation($companyId: ID!) {
                company(id: $companyId) {
                  locations(first: 1) {
                    nodes { id name }
                  }
                }
              }`,
              { variables: { companyId } },
            )
            .then((res) => res.json()),

          prisma.companyAccount.upsert({
            where: {
              shopId_shopifyCompanyId: {
                shopId: store.id,
                shopifyCompanyId: companyId,
              },
            },
            update: {
              name: companyName,
              paymentTerm: paymentTermsTemplateId || null,
              creditLimit: creditLimit ? Number(creditLimit) : undefined,
            },
            create: {
              shopId: store.id,
              name: companyName,
              shopifyCompanyId: companyId,
              paymentTerm: paymentTermsTemplateId || null,
              creditLimit: creditLimit ? Number(creditLimit) : undefined,
            },
          }),

          customerEmail
            ? prisma.user.findFirst({
                where: {
                  OR: [
                    { email: customerEmail },
                    { shopId: store.id, companyId: null, status: "PENDING" },
                  ],
                },
                orderBy: { createdAt: "desc" },
              })
            : prisma.user.findFirst({
                where: { shopId: store.id, companyId: null, status: "PENDING" },
                orderBy: { createdAt: "desc" },
              }),

          creditLimit
            ? updateCompanyMetafield(admin, companyId, {
                namespace: "custom",
                key: "company_credit_limit",
                value: creditLimit.toString(),
                type: "number_decimal",
              })
            : Promise.resolve(),
        ]);

        const location = locationPayload?.data?.company?.locations?.nodes?.[0];

        if (!location) {
          return Response.json({
            intent,
            success: false,
            errors: ["Company location not found"],
          });
        }

        if (paymentTermsTemplateId || companyName) {
          const updateLocationResponse = await admin.graphql(
            `#graphql
            mutation UpdateCompanyLocation(
              $companyLocationId: ID!
              $paymentTermsTemplateId: ID
              $locationName: String
            ) {
              companyLocationUpdate(
                companyLocationId: $companyLocationId
                input: {
                  name: $locationName
                  buyerExperienceConfiguration: {
                    paymentTermsTemplateId: $paymentTermsTemplateId
                  }
                }
              ) {
                companyLocation { id name }
                userErrors { field message }
              }
            }`,
            {
              variables: {
                companyLocationId: location.id,
                paymentTermsTemplateId: paymentTermsTemplateId || null,
                locationName: companyName,
              },
            },
          );

          const updateLocationPayload = await updateLocationResponse.json();
          const locationErrors = buildUserErrorList(updateLocationPayload);

          if (locationErrors.length) {
            return Response.json({
              intent,
              success: false,
              errors: locationErrors,
            });
          }
        }

        await Promise.all([
          // customerEmail
          //   ? prisma.registrationSubmission.upsert({
          //       where: {
          //         shopId_email: { shopId: store.id, email: customerEmail },
          //       },
          //       update: { companyName },
          //       create: {
          //         email: customerEmail,
          //         companyName,
          //         firstName: "",
          //         lastName: "",
          //         shopifyCustomerId: null,
          //         status: "PENDING",
          //         shopId: store.id,
          //       },
          //     })
          //   : Promise.resolve(),

          linkedUser
            ? prisma.user.update({
                where: { id: linkedUser.id },
                data: { companyId: companyExists.id },
              })
            : Promise.resolve(),
        ]);

        return Response.json({
          intent,
          success: true,
          company: {
            id: companyId,
            name: companyName,
            locationId: location.id,
            locationName: location.name,
            paymentTermsTemplateId: paymentTermsTemplateId || null,
            creditLimit: creditLimit ? Number(creditLimit) : null,
          },
          message: "Company updated successfully",
        });
      }

      case "assignMainContact": {
        const companyId = (form.companyId as string)?.trim();
        const customerId = normalizeCustomerId(form.customerId as string);
        const locationId = (form.locationId as string)?.trim();
        const customerEmail = (form.customerEmail as string)?.trim();

        if (!companyId || !customerId || !locationId) {
          return Response.json({
            intent,
            success: false,
            errors: ["Company, customer and location are required"],
          });
        }

        const result = await assignCompanyToCustomer(
          admin,
          customerId,
          companyId,
          locationId,
        );

        if (!result.success) {
          return Response.json({
            intent,
            success: false,
            errors: [`${result.step}: ${result.error}`],
          });
        }

        const RegitrationData = await prisma.registrationSubmission.findFirst({
          where: { email: customerEmail },
        });

        const contactName =
          `${RegitrationData?.firstName} ${RegitrationData?.lastName}`.trim();

        const companyAccount = await prisma.companyAccount.upsert({
          where: {
            shopId_shopifyCompanyId: {
              shopId: store.id,
              shopifyCompanyId: companyId,
            },
          },
          update: {
            contactName: contactName || null,
            contactEmail: customerEmail || null,
          },
          create: {
            shopId: store.id,
            shopifyCompanyId: companyId,
            name: "Company",
            contactName: contactName || null,
            contactEmail: customerEmail || null,
          },
        });

        await prisma.user.upsert({
          where: {
            shopId_email: { shopId: store.id, email: customerEmail },
          },
          update: {
            firstName: RegitrationData?.firstName || null,
            lastName: RegitrationData?.lastName || null,
            shopifyCustomerId: customerId,
            companyId: companyAccount.id,
            companyRole: "admin",
            role: "STORE_ADMIN",
            status: "APPROVED",
            shopId: store.id,
          },
          create: {
            email: customerEmail,
            firstName: RegitrationData?.firstName || null,
            lastName: RegitrationData?.lastName || null,
            password: "",
            shopifyCustomerId: customerId,
            shopId: store.id,
            companyId: companyAccount.id,
            companyRole: "admin",
            role: "STORE_ADMIN",
            status: "APPROVED",
          },
        });

        return Response.json({
          intent,
          success: true,
          wasAlreadyContact: (result as any).wasAlreadyContact ?? false,
          message:
            (result as any).message ?? "Main contact assigned successfully",
        });
      }

      case "sendWelcomeEmail": {
        const email = (form.email as string)?.trim();
        const companyName = (form.companyName as string)?.trim();
        const note = (form.reviewNotes as string)?.trim() || null;
        const contactName =
          (`${form?.firstName} ${form?.lastName}` as string)?.trim() ||
          "First Name";

        if (!email) {
          return Response.json({
            intent,
            success: false,
            errors: ["Email required"],
          });
        }

        const RegitrationData = await prisma.registrationSubmission.findFirst({
          where: { email },
        });

        await sendCompanyAssignmentEmail(
          store.shopName || "Shop Name",
          store.shopDomain || "shop-domain.myshopify.com",
          store.storeOwnerName || "Store Owner",
          email,
          companyName,
          `${RegitrationData?.firstName} ${RegitrationData?.lastName}` || "",
          note,
        );

        return Response.json({
          intent,
          success: true,
          message: "Welcome email sent",
        });
      }

      case "approveRegistration": {
        const registrationId = (form.registrationId as string)?.trim();
        const customerId = normalizeCustomerId(form.customerId as string);
        const companyName = (form.companyName as string)?.trim();
        const paymentTermsTemplateId = (form.paymentTerms as string)?.trim();
        const creditLimit = (form.creditLimit as string)?.trim();
        const customerEmail = (form.customerEmail as string)?.trim();
        const firstName = (form.firstName as string)?.trim();
        const lastName = (form.lastName as string)?.trim();
        const reviewNotes = (form.reviewNotes as string)?.trim() || null;

        if (!registrationId || !customerId || !companyName || !customerEmail) {
          return Response.json({
            intent,
            success: false,
            errors: [
              "Registration, customer, company name, and customer email are required",
            ],
          });
        }

        const registrationData = await prisma.registrationSubmission.findFirst({
          where: { id: registrationId, shopId: store.id },
        });

        if (!registrationData) {
          return Response.json({
            intent,
            success: false,
            errors: ["Registration not found"],
          });
        }

        const existingShopifyResponse = await admin.graphql(
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
            variables: { query: `name:'${companyName}'` },
          },
        );

        const existingShopifyPayload = await existingShopifyResponse.json();
        const existingShopifyCompany =
          existingShopifyPayload?.data?.companies?.nodes?.[0] || null;

        let companyId: string;
        let locationId: string;
        let locationName: string;

        if (existingShopifyCompany) {
          companyId = existingShopifyCompany.id;
          const existingLocation =
            existingShopifyCompany.locations?.nodes?.[0] || null;

          if (!existingLocation) {
            return Response.json({
              intent,
              success: false,
              errors: ["Existing company location not found"],
            });
          }

          locationId = existingLocation.id;
          locationName = existingLocation.name;

          await Promise.all([
            creditLimit
              ? updateCompanyMetafield(admin, companyId, {
                  namespace: "custom",
                  key: "company_credit_limit",
                  value: creditLimit.toString(),
                  type: "number_decimal",
                })
              : Promise.resolve(),

            paymentTermsTemplateId
              ? admin
                  .graphql(
                    `#graphql
                    mutation UpdateCompanyLocation(
                      $companyLocationId: ID!
                      $paymentTermsTemplateId: ID!
                    ) {
                      companyLocationUpdate(
                        companyLocationId: $companyLocationId
                        input: {
                          buyerExperienceConfiguration: {
                            paymentTermsTemplateId: $paymentTermsTemplateId
                          }
                        }
                      ) {
                        companyLocation { id }
                        userErrors { field message }
                      }
                    }`,
                    {
                      variables: {
                        companyLocationId: locationId,
                        paymentTermsTemplateId,
                      },
                    },
                  )
                  .then((res) => res.json())
              : Promise.resolve(),
          ]);

          await assignLocationAddresses(admin, locationId, registrationData);
        } else {
          const createCompanyResponse = await admin.graphql(
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

          const companyPayload = await createCompanyResponse.json();
          const companyErrors = buildUserErrorList(companyPayload);

          if (companyErrors.length) {
            return Response.json({
              intent,
              success: false,
              errors: companyErrors,
            });
          }

          companyId = companyPayload.data.companyCreate.company.id;

          const [locationPayload] = await Promise.all([
            admin
              .graphql(
                `#graphql
                query GetCompanyLocation($companyId: ID!) {
                  company(id: $companyId) {
                    locations(first: 1) {
                      nodes { id name }
                    }
                  }
                }`,
                { variables: { companyId } },
              )
              .then((res) => res.json()),

            creditLimit
              ? updateCompanyMetafield(admin, companyId, {
                  namespace: "custom",
                  key: "company_credit_limit",
                  value: creditLimit.toString(),
                  type: "number_decimal",
                })
              : Promise.resolve(),
          ]);

          const newLocation =
            locationPayload?.data?.company?.locations?.nodes?.[0];
          if (!newLocation) {
            return Response.json({
              intent,
              success: false,
              errors: ["Company location not found after creation"],
            });
          }

          locationId = newLocation.id;
          locationName = newLocation.name;

          if (paymentTermsTemplateId) {
            const updateLocationResponse = await admin.graphql(
              `#graphql
              mutation UpdateCompanyLocation(
                $companyLocationId: ID!
                $paymentTermsTemplateId: ID!
              ) {
                companyLocationUpdate(
                  companyLocationId: $companyLocationId
                  input: {
                    buyerExperienceConfiguration: {
                      paymentTermsTemplateId: $paymentTermsTemplateId
                    }
                  }
                ) {
                  companyLocation { id }
                  userErrors { field message }
                }
              }`,
              {
                variables: {
                  companyLocationId: locationId,
                  paymentTermsTemplateId,
                },
              },
            );

            const updateLocationPayload = await updateLocationResponse.json();
            const locationErrors = buildUserErrorList(updateLocationPayload);
            if (locationErrors.length) {
              return Response.json({
                intent,
                success: false,
                errors: locationErrors,
              });
            }
          }

          await assignLocationAddresses(admin, locationId, registrationData);
        }

        const companyAccount = await prisma.companyAccount.upsert({
          where: {
            shopId_shopifyCompanyId: {
              shopId: store.id,
              shopifyCompanyId: companyId,
            },
          },
          update: {
            name: companyName,
            paymentTerm: paymentTermsTemplateId || null,
            creditLimit: creditLimit ? new Prisma.Decimal(creditLimit) : undefined,
            contactEmail: customerEmail,
            contactName: `${firstName || ""} ${lastName || ""}`.trim() || "",
          },
          create: {
            shopId: store.id,
            name: companyName,
            shopifyCompanyId: companyId,
            paymentTerm: paymentTermsTemplateId || null,
            creditLimit: creditLimit ? new Prisma.Decimal(creditLimit) : undefined,
            contactEmail: customerEmail,
            contactName: `${firstName || ""} ${lastName || ""}`.trim() || "",
          },
        });

        const linkedUser = await prisma.user.findFirst({
          where: {
            OR: [
              { shopId: store.id, email: customerEmail },
              { shopifyCustomerId: customerId },
            ],
          },
          orderBy: { createdAt: "desc" },
        });

        if (linkedUser) {
          await prisma.user.update({
            where: { id: linkedUser.id },
            data: { companyId: companyAccount.id },
          });
        }

        const assignmentResult = await assignCompanyToCustomer(
          admin,
          customerId,
          companyId,
          locationId,
        );

        if (!assignmentResult.success) {
          return Response.json({
            intent,
            success: false,
            errors: [`${assignmentResult.step}: ${assignmentResult.error}`],
          });
        }

        await prisma.user.upsert({
          where: {
            shopId_email: { shopId: store.id, email: customerEmail },
          },
          update: {
            firstName: registrationData.firstName || firstName || null,
            lastName: registrationData.lastName || lastName || null,
            shopifyCustomerId: customerId,
            companyId: companyAccount.id,
            companyRole: "admin",
            role: "STORE_ADMIN",
            status: "APPROVED",
            isActive: true,
            userCreditLimit: creditLimit
              ? new Prisma.Decimal(creditLimit)
              : undefined,
          },
          create: {
            email: customerEmail,
            firstName: registrationData.firstName || firstName || null,
            lastName: registrationData.lastName || lastName || null,
            password: "",
            shopifyCustomerId: customerId,
            shopId: store.id,
            companyId: companyAccount.id,
            companyRole: "admin",
            role: "STORE_ADMIN",
            status: "APPROVED",
            isActive: true,
            userCreditLimit: creditLimit
              ? new Prisma.Decimal(creditLimit)
              : undefined,
          },
        });

        await sendCompanyAssignmentEmail(
          store.shopName || "Shop Name",
          store.shopDomain || "shop-domain.myshopify.com",
          store.storeOwnerName || "Store Owner",
          customerEmail,
          companyName,
          `${registrationData?.firstName || firstName || ""} ${registrationData?.lastName || lastName || ""}`.trim(),
          reviewNotes,
        );

        await prisma.registrationSubmission.update({
          where: { id: registrationId },
          data: {
            status: "APPROVED",
            shopifyCustomerId: customerId,
            workflowCompleted: true,
          },
        });

        return Response.json({
          intent,
          success: true,
          company: {
            id: companyId,
            name: companyName,
            locationId,
            locationName,
            paymentTermsTemplateId: paymentTermsTemplateId || null,
            creditLimit: creditLimit ? Number(creditLimit) : null,
          },
          message: "Registration approved",
        });
      }

      case "completeApproval": {
        const registrationId = (form.registrationId as string)?.trim();
        const customerId = normalizeCustomerId(
          (form.customerId as string) || "",
        );
        const companyId = (form.companyId as string)?.trim();
        const companyName = (form.companyName as string)?.trim();
        const contactName = (form.contactName as string)?.trim() || null;
        const contactEmail = (form.contactEmail as string)?.trim() || null;
        const paymentTermsTemplateId =
          (form.paymentTerm as string)?.trim() || null;
        const creditLimit = (form.creditLimit as string)?.trim() || null;

        if (!registrationId || !customerId) {
          return Response.json({
            intent,
            success: false,
            errors: ["Registration and customer are required"],
          });
        }

        await prisma.registrationSubmission.update({
          where: { id: registrationId },
          data: {
            status: "APPROVED",
            shopifyCustomerId: customerId,
            workflowCompleted: true,
          },
        });

        let companyData;

        if (companyId) {
          companyData = await prisma.companyAccount.upsert({
            where: {
              shopId_shopifyCompanyId: {
                shopId: store.id,
                shopifyCompanyId: companyId,
              },
            },
            update: {
              name: companyName ?? undefined,
              contactName: contactName ?? undefined,
              contactEmail: contactEmail ?? undefined,
              paymentTerm:
                paymentTermsTemplateId !== null
                  ? paymentTermsTemplateId
                  : undefined,
              creditLimit: creditLimit
                ? new Prisma.Decimal(creditLimit)
                : undefined,
            },
            create: {
              shopId: store.id,
              shopifyCompanyId: companyId,
              name: companyName || "Company",
              contactName,
              contactEmail,
              creditLimit: creditLimit
                ? new Prisma.Decimal(creditLimit)
                : undefined,
              paymentTerm: paymentTermsTemplateId,
            },
          });
        } else if (companyName) {
          companyData = await prisma.companyAccount.create({
            data: {
              shopId: store.id,
              shopifyCompanyId: companyId,
              name: companyName,
              contactName,
              contactEmail,
              creditLimit: creditLimit
                ? new Prisma.Decimal(creditLimit)
                : undefined,
              paymentTerm: paymentTermsTemplateId ?? null,
            },
          });
        }

        let user = null;
        if (companyData && companyData.contactEmail) {
          user = await prisma.user.findFirst({
            where: { email: companyData.contactEmail },
          });
        }

        if (user && companyData) {
          await prisma.user.update({
            where: { id: user.id },
            data: {
              shopifyCustomerId: customerId,
              companyRole: "admin",
              status: "APPROVED",
              isActive: true,
              companyId: companyData.id,
              userCreditLimit: creditLimit
                ? new Prisma.Decimal(creditLimit)
                : undefined,
            },
          });
        }

        return Response.json({
          intent,
          success: true,
          message: "Registration approved",
        });
      }

      case "reject": {
        const registrationId = (form.registrationId as string)?.trim();
        const note = (form.reviewNotes as string)?.trim() || null;
        const userId = (form.userId as string)?.trim() || null;

        if (!registrationId) {
          return Response.json({
            intent,
            success: false,
            errors: ["Registration is required"],
          });
        }

        await prisma.registrationSubmission.update({
          where: { id: registrationId },
          data: { status: "REJECTED" },
        });

        await prisma.user.update({
          where: { id: userId || "" },
          data: {
            status: "REJECTED",
            isActive: false,
            companyId: null,
            userCreditLimit: null,
          },
        });

        return Response.json({
          intent,
          success: true,
          message: "Registration rejected",
        });
      }
      case "updatecustomerCompanyDetails": {
        const registrationId = (form.registrationId as string)?.trim();
        const customerId = normalizeCustomerId(form.customerId as string);
        const incomingCompanyId = (form.companyId as string)?.trim() || null;
        const incomingLocationId =
          (form.companyLocationId as string)?.trim() || null;
        const companyName = (form.companyName as string)?.trim() || "";
        const locationName =
          (form.locationName as string)?.trim() || companyName || "";
        const email = (form.email as string)?.trim() || "";
        const firstName = (form.firstName as string)?.trim() || "";
        const lastName = (form.lastName as string)?.trim() || "";
        const contactTitle =
          (form.contactTitle as string)?.trim() ||
          (form.jobTitle as string)?.trim() ||
          "";
        const phone =
          (form.phone as string)?.trim() ||
          (form.contactPhone as string)?.trim() ||
          undefined;
        const useSameAddress =
          String(form.useSameAddress ?? form.billSameAsShip ?? "") === "true";

        if (!registrationId) {
          return Response.json({
            intent,
            success: false,
            errors: ["Registration ID is required"],
          });
        }

        const existingRegistration =
          await prisma.registrationSubmission.findUnique({
            where: { id: registrationId },
          });

        if (!existingRegistration) {
          return Response.json({
            intent,
            success: false,
            errors: ["Registration not found"],
          });
        }
        console.log(
          existingRegistration.shipping,
          "existingRegistration.shipping5555",
        );
        const shipping = {
          ...((existingRegistration.shipping as Record<string, any>) || {}),
        };
        console.log(
          existingRegistration.billing,
          "existingRegistration.shipping4444448",
        );
        const billing = {
          ...((existingRegistration.billing as Record<string, any>) || {}),
        };
        const customFields = {
          ...(((existingRegistration.customFields as Record<
            string,
            any
          > | null) || {}) as Record<string, any>),
        };

        const controlKeys = new Set([
          "intent",
          "registrationId",
          "customerId",
          "companyId",
          "companyLocationId",
        ]);

        Object.entries(form).forEach(([key, rawValue]) => {
          if (controlKeys.has(key)) return;

          const value =
            typeof rawValue === "string"
              ? rawValue.trim()
              : String(rawValue ?? "");

          const addressKey = mapEditFormAddressKey(key);
          if (addressKey?.bucket === "shipping") {
            shipping[addressKey.field] = value;
            return;
          }

          if (addressKey?.bucket === "billing") {
            billing[addressKey.field] = value;
            return;
          }

          if (
            [
              "companyName",
              "email",
              "firstName",
              "lastName",
              "contactTitle",
              "jobTitle",
              "phone",
              "contactPhone",
              "locationName",
              "useSameAddress",
            ].includes(key)
          ) {
            return;
          }

          customFields[key] = value;
        });

        customFields.billSameAsShip = useSameAddress ? "true" : "false";
        billing.SameAsShip = useSameAddress ? "true" : "false";

        if (customFields.taxId && !customFields.taxRegistrationId) {
          customFields.taxRegistrationId = customFields.taxId;
        }
        if (customFields.taxRegistrationId && !customFields.taxId) {
          customFields.taxId = customFields.taxRegistrationId;
        }
        if (phone) {
          customFields.phone = phone;
        }
        if (contactTitle) {
          customFields.jobTitle = contactTitle;
        }

        let updatedCustomer: ActionJson["customer"] = null;
        if (customerId) {
          const customerResponse = await admin.graphql(
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
                  id: customerId,
                  email: email || undefined,
                  firstName: firstName || undefined,
                  lastName: lastName || undefined,
                  phone,
                },
              },
            },
          );

          const customerPayload = await customerResponse.json();
          const customerErrors = buildUserErrorList(customerPayload);
          if (customerErrors.length) {
            return Response.json({
              intent,
              success: false,
              errors: customerErrors,
            });
          }

          updatedCustomer =
            customerPayload?.data?.customerUpdate?.customer ?? null;
        }

        const updatedRegistration = await prisma.registrationSubmission.update({
          where: { id: registrationId },
          data: {
            companyName: companyName || existingRegistration.companyName,
            email: email || existingRegistration.email,
            firstName: firstName || existingRegistration.firstName,
            lastName: lastName || existingRegistration.lastName,
            contactTitle:
              contactTitle || existingRegistration.contactTitle || "",
            shopifyCustomerId:
              customerId || existingRegistration.shopifyCustomerId,
            shipping,
            billing,
            customFields,
          },
        });

        let updatedCompany: ActionJson["company"] = null;
        let localCompanyId: string | null = null;

        if (companyName) {
          let companyId = incomingCompanyId;
          let locationId = incomingLocationId;

          if (!companyId) {
            const companyLookupResponse = await admin.graphql(
              `#graphql
              query CompaniesByName($query: String!) {
                companies(first: 1, query: $query) {
                  nodes {
                    id
                    name
                    locations(first: 1) {
                      nodes { id name }
                    }
                  }
                }
              }`,
              {
                variables: { query: `name:'${companyName}'` },
              },
            );

            const companyLookupPayload = await companyLookupResponse.json();
            const existingShopifyCompany =
              companyLookupPayload?.data?.companies?.nodes?.[0] || null;

            if (existingShopifyCompany) {
              companyId = existingShopifyCompany.id;
              locationId =
                existingShopifyCompany.locations?.nodes?.[0]?.id || null;
            } else {
              const createCompanyResponse = await admin.graphql(
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

              const createCompanyPayload = await createCompanyResponse.json();
              const createCompanyErrors =
                buildUserErrorList(createCompanyPayload);
              if (createCompanyErrors.length) {
                return Response.json({
                  intent,
                  success: false,
                  errors: createCompanyErrors,
                });
              }

              companyId =
                createCompanyPayload?.data?.companyCreate?.company?.id || null;
            }
          }

          if (companyId) {
            const updateCompanyResponse = await admin.graphql(
              `#graphql
              mutation CompanyUpdate($companyId: ID!, $input: CompanyInput!) {
                companyUpdate(companyId: $companyId, input: $input) {
                  company { id name }
                  userErrors { field message }
                }
              }`,
              {
                variables: {
                  companyId,
                  input: { name: companyName },
                },
              },
            );

            const updateCompanyPayload = await updateCompanyResponse.json();
            const companyErrors = buildUserErrorList(updateCompanyPayload);
            if (companyErrors.length) {
              return Response.json({
                intent,
                success: false,
                errors: companyErrors,
              });
            }

            const locationPayload = await admin
              .graphql(
                `#graphql
                query GetCompanyLocation($companyId: ID!) {
                  company(id: $companyId) {
                    locations(first: 1) {
                      nodes { id name }
                    }
                  }
                }`,
                { variables: { companyId } },
              )
              .then((res) => res.json());

            const location =
              locationPayload?.data?.company?.locations?.nodes?.[0] || null;

            if (location?.id) {
              locationId = location.id;

              const updateLocationResponse = await admin.graphql(
                `#graphql
                mutation UpdateCompanyLocation(
                  $companyLocationId: ID!
                  $locationName: String
                ) {
                  companyLocationUpdate(
                    companyLocationId: $companyLocationId
                    input: { name: $locationName }
                  ) {
                    companyLocation { id name }
                    userErrors { field message }
                  }
                }`,
                {
                  variables: {
                    companyLocationId: location.id,
                    locationName: locationName || companyName,
                  },
                },
              );

              const updateLocationPayload = await updateLocationResponse.json();
              const locationErrors = buildUserErrorList(updateLocationPayload);
              if (locationErrors.length) {
                return Response.json({
                  intent,
                  success: false,
                  errors: locationErrors,
                });
              }

              await assignLocationAddresses(
                admin,
                location.id,
                updatedRegistration,
              );
            }

            const companyAccount = await prisma.companyAccount.upsert({
              where: {
                shopId_shopifyCompanyId: {
                  shopId: store.id,
                  shopifyCompanyId: companyId,
                },
              },
              update: {
                name: companyName,
                contactEmail: email || updatedRegistration.email,
                contactName:
                  `${firstName || updatedRegistration.firstName} ${lastName || updatedRegistration.lastName}`.trim(),
              },
              create: {
                shopId: store.id,
                shopifyCompanyId: companyId,
                name: companyName,
                contactEmail: email || updatedRegistration.email,
                contactName:
                  `${firstName || updatedRegistration.firstName} ${lastName || updatedRegistration.lastName}`.trim(),
              },
            });

            localCompanyId = companyAccount.id;
            updatedCompany = {
              id: companyId,
              name: companyName,
              locationId: locationId || undefined,
              locationName: locationName || undefined,
            };
          }
        }

        const userWhere = customerId
          ? {
              OR: [
                { shopifyCustomerId: customerId },
                { shopId: store.id, email: email || updatedRegistration.email },
              ],
            }
          : {
              shopId: store.id,
              email: email || updatedRegistration.email,
            };

        const existingUser = await prisma.user.findFirst({ where: userWhere });

        if (existingUser) {
          await prisma.user.update({
            where: { id: existingUser.id },
            data: {
              email: email || updatedRegistration.email,
              firstName: firstName || updatedRegistration.firstName,
              lastName: lastName || updatedRegistration.lastName,
              shopifyCustomerId: customerId || existingUser.shopifyCustomerId,
              companyId: localCompanyId || existingUser.companyId,
            },
          });
        } else if (email || updatedRegistration.email) {
          await prisma.user.create({
            data: {
              email: email || updatedRegistration.email,
              firstName: firstName || updatedRegistration.firstName,
              lastName: lastName || updatedRegistration.lastName,
              shopifyCustomerId: customerId,
              shopId: store.id,
              companyId: localCompanyId,
              status: "PENDING",
              role: "STORE_ADMIN",
              password: "",
              companyRole: "admin",
            },
          });
        }

        return Response.json({
          intent,
          success: true,
          customer: updatedCustomer,
          company: updatedCompany,
          submission: {
            ...updatedRegistration,
            createdAt: updatedRegistration.createdAt.toISOString(),
          },
          message: "Customer and company details updated",
        });
      }

      case "assignCatalog": {
        const catalogId = (form.catalogId as string)?.trim();
        const locationId = (form.locationId as string)?.trim();
        if (!catalogId || !locationId) {
          return Response.json({
            intent,
            success: false,
            errors: ["catalogId and locationId required"],
          });
        }
        const res = await admin
          .graphql(
            `#graphql
      mutation CatalogContextUpdate($id: ID!, $contextsToAdd: [ID!]!) {
        catalogContextUpdate(id: $id, contextsToAdd: $contextsToAdd) {
          catalog { id title }
          userErrors { field message }
        }
      }`,
            { variables: { id: catalogId, contextsToAdd: [locationId] } },
          )
          .then((r: any) => r.json());
        const errs = res?.data?.catalogContextUpdate?.userErrors || [];
        if (errs.length)
          return Response.json({
            intent,
            success: false,
            errors: errs.map((e: any) => e.message),
          });
        return Response.json({
          intent,
          success: true,
          message: "Catalog assigned",
        });
      }

      case "removeCatalog": {
        const catalogId = (form.catalogId as string)?.trim();
        const locationId = (form.locationId as string)?.trim();
        if (!catalogId || !locationId) {
          return Response.json({
            intent,
            success: false,
            errors: ["catalogId and locationId required"],
          });
        }
        const res = await admin
          .graphql(
            `#graphql
      mutation CatalogContextUpdate($id: ID!, $contextsToRemove: [ID!]!) {
        catalogContextUpdate(id: $id, contextsToRemove: $contextsToRemove) {
          catalog { id title }
          userErrors { field message }
        }
      }`,
            { variables: { id: catalogId, contextsToRemove: [locationId] } },
          )
          .then((r: any) => r.json());
        const errs = res?.data?.catalogContextUpdate?.userErrors || [];
        if (errs.length)
          return Response.json({
            intent,
            success: false,
            errors: errs.map((e: any) => e.message),
          });
        return Response.json({
          intent,
          success: true,
          message: "Catalog removed",
        });
      }

      default:
        return Response.json({
          intent,
          success: false,
          errors: ["Unknown intent"],
        });
    }
  } catch (error) {
    console.error("Registration workflow error", error);
    return Response.json({
      intent,
      success: false,
      errors: [
        error instanceof Error ? error.message : "Unexpected error occurred",
      ],
    });
  }
};

const formatDate = (value?: string | null) => {
  if (!value) return "-";
  const date = new Date(value);
  return date.toLocaleString();
};
// Pipeline steps in order
type PipelineStep =
  | "idle"
  | "checkCustomer"
  | "approveRegistration"
  | "checkCompany"
  | "createCompany"
  | "assignMainContact"
  | "sendWelcomeEmail"
  | "completeApproval"
  | "done"
  | "error";

// ─── Progress Step Indicator ──────────────────────────────────────────────────
const PIPELINE_LABELS: Record<string, string> = {
  checkCustomer: "Checking customer",
  approveRegistration: "Approving registration",
  checkCompany: "Checking company",
  createCompany: "Setting up company",
  assignMainContact: "Assigning contact",
  sendWelcomeEmail: "Sending welcome email",
  completeApproval: "Completing approval",
  done: "Approved!",
};

const PIPELINE_ORDER: PipelineStep[] = [
  "checkCustomer",
  "approveRegistration",
  "done",
];

function ProgressBar({
  currentStep,
  error,
}: {
  currentStep: PipelineStep;
  error?: string;
}) {
  const currentIndex = PIPELINE_ORDER.indexOf(currentStep);
  const steps = PIPELINE_ORDER.filter((s) => s !== "done");

  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
        {steps.map((step, i) => {
          const stepIndex = PIPELINE_ORDER.indexOf(step);
          const isDone = currentIndex > stepIndex;
          const isActive = currentIndex === stepIndex;
          const isError = !!error && isActive;

          return (
            <div
              key={step}
              style={{ display: "flex", alignItems: "center", flex: 1 }}
            >
              <div
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: "50%",
                  background: isError
                    ? "#ef4444"
                    : isDone
                      ? "#16a34a"
                      : isActive
                        ? "#2c6ecb"
                        : "#e3e3e3",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: isActive || isDone || isError ? "white" : "#9ca3af",
                  fontSize: 12,
                  fontWeight: 700,
                  flexShrink: 0,
                  transition: "background 0.3s",
                }}
              >
                {isError ? "!" : isDone ? "✓" : i + 1}
              </div>
              {i < steps.length - 1 && (
                <div
                  style={{
                    flex: 1,
                    height: 2,
                    background: isDone ? "#16a34a" : "#e3e3e3",
                    transition: "background 0.3s",
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 12, color: error ? "#ef4444" : "#5c5f62" }}>
        {error
          ? `⚠ ${error}`
          : currentStep === "done"
            ? "✓ All steps completed"
            : `${PIPELINE_LABELS[currentStep] || currentStep}…`}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid #c9ccd0",
  fontSize: 14,
  boxSizing: "border-box",
  background: "white",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: "#374151",
  marginBottom: 5,
};

const sectionStyle: React.CSSProperties = {
  border: "1px solid #e3e3e3",
  borderRadius: 10,
  padding: "14px 16px",
  display: "grid",
  gap: 10,
};

export type FieldType =
  | "text"
  | "email"
  | "phone"
  | "select"
  | "readonly"
  | "checkbox"
  | "textarea";

export interface FormField {
  key: string; // unique key — used as editForm[key]
  label: string; // placeholder / label shown to the user
  type: FieldType;
  section: string; // which section this field belongs to
  order: number; // display order within the section
  width?: FieldWidth;
  readOnly?: boolean; // disables editing
  readOnlyHint?: string; // small hint below read-only fields
  options?: { value: string; label: string }[]; // for "select" type
  countryCode?: string; // for "phone" type — flag + dial code
  flagEmoji?: string; // for "phone" type
  // Maps to a dot-path in submission / company / customer
  // e.g. "submission.companyName" | "submission.customFields.taxRegistrationId"
  // e.g. "shipping.Addr1" | "customer.email"
  sourcePath: string;
}

export interface FormSection {
  key: string; // unique section key
  label: string; // section heading (shown in lowercase in the modal)
  order: number; // display order of the section
}

const DEFAULT_COUNTRY_OPTIONS: CountryOption[] = [
  { value: "", label: "Country" },
  { value: "India", label: "India" },
  { value: "US", label: "United States" },
  { value: "GB", label: "United Kingdom" },
  { value: "AU", label: "Australia" },
  { value: "CA", label: "Canada" },
];

const DEFAULT_STATE_OPTIONS: CountryOption[] = [
  { value: "", label: "State / Province" },
];

const COUNTRY_PHONE_META: Record<
  string,
  { dialCode: string; flagEmoji: string }
> = {
  IN: { dialCode: "+91", flagEmoji: "🇮🇳" },
  INDIA: { dialCode: "+91", flagEmoji: "🇮🇳" },
  US: { dialCode: "+1", flagEmoji: "🇺🇸" },
  USA: { dialCode: "+1", flagEmoji: "🇺🇸" },
  "UNITED STATES": { dialCode: "+1", flagEmoji: "🇺🇸" },
  GB: { dialCode: "+44", flagEmoji: "🇬🇧" },
  UK: { dialCode: "+44", flagEmoji: "🇬🇧" },
  "UNITED KINGDOM": { dialCode: "+44", flagEmoji: "🇬🇧" },
  AU: { dialCode: "+61", flagEmoji: "🇦🇺" },
  AUSTRALIA: { dialCode: "+61", flagEmoji: "🇦🇺" },
  CA: { dialCode: "+1", flagEmoji: "🇨🇦" },
  CANADA: { dialCode: "+1", flagEmoji: "🇨🇦" },
};

const COUNTRY_CODE_ALIASES: Record<string, string> = {
  INDIA: "IN",
  "UNITED STATES": "US",
  USA: "US",
  "UNITED KINGDOM": "GB",
  UK: "GB",
  AUSTRALIA: "AU",
  CANADA: "CA",
};

function normalizeCountryCode(countryValue?: string | null) {
  const normalized = (countryValue || "").trim().toUpperCase();
  return COUNTRY_CODE_ALIASES[normalized] || normalized;
}

function getPhoneMetaForCountry(countryValue?: string | null) {
  const normalized = normalizeCountryCode(countryValue);
  return COUNTRY_PHONE_META[normalized] || { dialCode: "+91", flagEmoji: "🇮🇳" };
}

function getProvinceOptionsForCountry(
  countryValue?: string | null,
  shippingProvincesByCountry?: Record<string, CountryOption[]>,
) {
  const normalized = normalizeCountryCode(countryValue);
  const dynamicProvinceOptions = shippingProvincesByCountry?.[normalized] || [];

  if (dynamicProvinceOptions.length > 0) {
    const hasPlaceholder = dynamicProvinceOptions.some(
      (option) => option.value === "",
    );

    return hasPlaceholder
      ? dynamicProvinceOptions
      : [{ value: "", label: "State / Province" }, ...dynamicProvinceOptions];
  }
  console.log("Using default province options for", normalized);

  return [{ value: "", label: "State / Province" }];
}

const titleCaseSection = (value: string) =>
  value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());

function getFieldSourcePath(field: FieldDef): string {
  if (field.section === "shipping" && field.key.startsWith("ship")) {
    return `shipping.${field.key.replace(/^ship/, "")}`;
  }

  if (field.section === "billing" && field.key.startsWith("bill")) {
    return `billing.${field.key.replace(/^bill/, "")}`;
  }

  switch (field.key) {
    case "email":
      return "customer.email";
    case "companyName":
    case "firstName":
    case "lastName":
    case "website":
    case "businessType":
    case "additionalInfo":
    case "contactTitle":
    case "locationName":
    case "phone":
      return `submission.${field.key}`;
    case "taxId":
      return "submission.customFields.taxId";
    default:
      return `submission.customFields.${field.key}`;
  }
}

function mapConfigFieldToEditField(
  field: FieldDef,
  countryOptions: CountryOption[],
): FormField | null {
  if (
    field.isDisplay ||
    field.type === "heading" ||
    field.type === "paragraph" ||
    field.type === "link" ||
    field.type === "divider" ||
    field.type === "date" ||
    field.type === "file" ||
    field.type === "multi-check"
  ) {
    return null;
  }

  let type: FieldType = "text";
  let options: FormField["options"];
  let readOnly = false;
  let readOnlyHint: string | undefined;

  if (field.key === "email") {
    type = "readonly";
    readOnly = true;
    readOnlyHint = "Email cannot be changed";
  } else if (field.type === "phone") {
    type = "phone";
  } else if (
    field.type === "country" ||
    field.type === "state" ||
    field.type === "select" ||
    field.type === "radio"
  ) {
    type = "select";
    options =
      field.options?.map((option) => ({ value: option, label: option })) ||
      (field.type === "country"
        ? countryOptions
        : field.type === "state"
          ? DEFAULT_STATE_OPTIONS
          : []);
  } else if (field.type === "checkbox") {
    type = "checkbox";
  } else if (field.type === "textarea") {
    type = "textarea";
  } else if (field.type === "email") {
    type = "email";
  }

  return {
    key: field.key,
    label: field.label,
    type,
    section: field.section || "general",
    order: field.order,
    width: field.width,
    readOnly,
    readOnlyHint,
    options,
    sourcePath: getFieldSourcePath(field),
    countryCode: field.type === "phone" ? "+91" : undefined,
    flagEmoji: field.type === "phone" ? "🇮🇳" : undefined,
  };
}

function buildEditModalConfig(
  config: FormConfig,
  countryOptions: CountryOption[],
): {
  sections: FormSection[];
  fields: FormField[];
} {
  const fields = [...config.fields]
    .sort((a, b) => {
      if (a.stepIndex !== b.stepIndex) return a.stepIndex - b.stepIndex;
      return a.order - b.order;
    })
    .map((field) => mapConfigFieldToEditField(field, countryOptions))
    .filter((field): field is FormField => field !== null);

  const sectionOrder = new Map<string, number>();
  fields.forEach((field) => {
    if (!sectionOrder.has(field.section)) {
      sectionOrder.set(field.section, sectionOrder.size + 1);
    }
  });

  const sections = Array.from(sectionOrder.entries()).map(([key, order]) => ({
    key,
    order,
    label: SECTION_LABELS[key] ?? titleCaseSection(key),
  }));

  return { sections, fields };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper — resolve initial value from submission / company / customer
// via the field's sourcePath (e.g. "shipping.Addr1", "customer.email")
// ─────────────────────────────────────────────────────────────────────────────
function resolveSourceValue(
  sourcePath: string,
  submission: any,
  customer: any,
): string {
  const [root, ...rest] = sourcePath.split(".");
  const key = rest.join(".");

  if (root === "customer") {
    return customer?.[key] ?? "";
  }
  if (root === "submission") {
    if (key.startsWith("customFields.")) {
      const cfKey = key.replace("customFields.", "");
      if (cfKey === "taxId") {
        return (
          (submission as any)?.customFields?.taxId ??
          (submission as any)?.customFields?.taxRegistrationId ??
          ""
        );
      }
      return (submission as any)?.customFields?.[cfKey] ?? "";
    }
    return (submission as any)?.[key] ?? "";
  }
  if (root === "shipping") {
    const s = (submission as any)?.shipping as
      | Record<string, string>
      | undefined;
    return s?.[key] ?? "";
  }
  if (root === "billing") {
    const b = (submission as any)?.billing as
      | Record<string, string>
      | undefined;
    return b?.[key] ?? "";
  }
  return "";
}

// ─────────────────────────────────────────────────────────────────────────────
// Build initial editForm state from config + data
// ─────────────────────────────────────────────────────────────────────────────
export function buildInitialEditForm(
  submission: any,
  customer: any,
  billingSame: boolean,
  fields: FormField[],
): Record<string, string | boolean> {
  const shipping = (submission as any)?.shipping as
    | Record<string, string>
    | undefined;
  const billing = (submission as any)?.billing as
    | Record<string, string>
    | undefined;
  const form: Record<string, string | boolean> = {
    companyName: submission.companyName || "",
    taxRegistrationId:
      (submission as any)?.customFields?.taxRegistrationId ??
      (submission as any)?.customFields?.taxId ??
      "",
    firstName: submission.firstName || "",
    lastName: submission.lastName || "",
    jobTitle:
      (submission as any)?.contactTitle ??
      (submission as any)?.customFields?.jobTitle ??
      "",
    contactPhone:
      submission.phone ?? (submission as any)?.customFields?.phone ?? "",
    shDepartment: shipping?.Department || "",
    shFirstName: shipping?.FirstName || "",
    shLastName: shipping?.LastName || "",
    shPhone: shipping?.Phone || "",
    shAddr1: shipping?.Addr1 || "",
    shAddr2: shipping?.Addr2 || "",
    shCity: shipping?.City || "",
    shCountry: shipping?.Country || "India",
    shState: shipping?.State || "",
    shZip: shipping?.Zip || "",
    biAddr1: billing?.Addr1 || "",
    biAddr2: billing?.Addr2 || "",
    biCity: billing?.City || "",
    biCountry: billing?.Country || "India",
    biState: billing?.State || "",
    biZip: billing?.Zip || "",
    email: customer?.email ?? submission.email ?? "",
    useSameAddress: billingSame,
  };

  for (const field of fields) {
    const rawValue = resolveSourceValue(field.sourcePath, submission, customer);
    form[field.key] =
      field.type === "checkbox"
        ? rawValue === "true" || rawValue === "1" || rawValue === "yes"
        : rawValue;
  }

  return form;
}

// ─────────────────────────────────────────────────────────────────────────────
// DynamicField — renders a single field based on its FieldType
// ─────────────────────────────────────────────────────────────────────────────

function DynamicField({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: string;
  onChange: (val: string) => void;
}) {
  const hasValue = value !== undefined && value !== null && value !== "";
  const showFieldLabel = field.type !== "checkbox";

  // If the field has no value yet, show a subtle "add" placeholder style
  const addStyle: React.CSSProperties = hasValue
    ? {}
    : { borderStyle: "dashed", opacity: 0.75 };

  switch (field.type) {
    case "readonly":
      return (
        <div>
          {showFieldLabel ? (
            <label style={labelStyle}>{field.label}</label>
          ) : null}
          <input
            value={value || ""}
            readOnly
            placeholder={field.label}
            style={{
              ...inputStyle,
              background: "#f3f4f6",
              color: "#9ca3af",
              cursor: "not-allowed",
              border: "1px solid #e5e7eb",
            }}
          />
          {field.readOnlyHint && (
            <div
              style={{
                fontSize: 11,
                color: "#9ca3af",
                marginTop: 3,
                paddingLeft: 2,
              }}
            >
              {field.readOnlyHint}
            </div>
          )}
        </div>
      );

    case "phone":
      return (
        <div style={{ position: "relative" }}>
          {showFieldLabel ? (
            <label style={labelStyle}>{field.label}</label>
          ) : null}
          <input
            placeholder={`Add ${field.label}`}
            value={value || ""}
            onChange={(e) => onChange(e.target.value)}
            style={{ ...inputStyle, paddingRight: 90, ...addStyle }}
          />
          <div
            style={{
              position: "absolute",
              right: 10,
              top: "50%",
              transform: "translateY(-50%)",
              fontSize: 13,
              color: "#374151",
              display: "flex",
              alignItems: "center",
              gap: 4,
              pointerEvents: "none",
            }}
          >
            <span>{field.flagEmoji}</span>
            <span>{field.countryCode}</span>
            <span style={{ color: "#9ca3af" }}>▾</span>
          </div>
        </div>
      );

    case "select":
      return (
        <div>
          {showFieldLabel ? (
            <label style={labelStyle}>{field.label}</label>
          ) : null}
          <select
            value={value || ""}
            onChange={(e) => onChange(e.target.value)}
            style={{ ...inputStyle, ...addStyle }}
          >
            {field.options?.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      );

    case "checkbox":
      return (
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minHeight: 44,
            color: "#374151",
            fontSize: 14,
          }}
        >
          <input
            type="checkbox"
            checked={value === "true" || value === "1" || value === "yes"}
            onChange={(e) => onChange(e.target.checked ? "true" : "false")}
          />
          {field.label}
        </label>
      );

    case "textarea":
      return (
        <div>
          {showFieldLabel ? (
            <label style={labelStyle}>{field.label}</label>
          ) : null}
          <textarea
            placeholder={`Add ${field.label}`}
            value={value || ""}
            onChange={(e) => onChange(e.target.value)}
            style={{
              ...inputStyle,
              ...addStyle,
              minHeight: 92,
              resize: "vertical",
              paddingTop: 10,
            }}
          />
        </div>
      );

    case "text":
    case "email":
    default:
      return (
        <div>
          {showFieldLabel ? (
            <label style={labelStyle}>{field.label}</label>
          ) : null}
          <input
            placeholder={`Add ${field.label}`}
            value={value || ""}
            type={field.type === "email" ? "email" : "text"}
            onChange={(e) => onChange(e.target.value)}
            style={{ ...inputStyle, ...addStyle }}
          />
        </div>
      );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DynamicEditModal — renders all sections and fields from config
// Drop-in replacement for the hardcoded edit modal body
// ─────────────────────────────────────────────────────────────────────────────

const sectionHeadingStyle: React.CSSProperties = {
  margin: "0 0 4px",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "#5c5f62",
};

export function DynamicEditModal({
  editForm,
  setEditForm,
  onClose,
  onSave,
  customer,
  submission,
  sections = [],
  fields = [],
  shippingProvincesByCountry = {},
}: {
  editForm: Record<string, any>;
  setEditForm: React.Dispatch<React.SetStateAction<Record<string, any>>>;
  onClose: () => void;
  onSave: () => void;
  customer: any;
  submission: any;
  sections?: FormSection[];
  fields?: FormField[];
  shippingProvincesByCountry?: Record<string, CountryOption[]>;
}) {
  // Sort sections by order
  const sortedSections = [...sections].sort((a, b) => a.order - b.order);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(17,24,39,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: "min(560px, 96vw)",
          background: "#f8f8f8",
          borderRadius: 12,
          boxShadow: "0 12px 40px rgba(0,0,0,0.18)",
          maxHeight: "92vh",
          overflowY: "auto",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        {/* ── Header ── */}
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid #e3e3e3",
            background: "white",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            position: "sticky",
            top: 0,
            zIndex: 1,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            Edit details
          </h3>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              fontSize: 20,
              cursor: "pointer",
              color: "#5c5f62",
              lineHeight: 1,
              padding: "0 2px",
            }}
          >
            ×
          </button>
        </div>

        {/* ── Body: dynamic sections ── */}
        <div style={{ padding: "16px 20px", display: "grid", gap: 14 }}>
          {sortedSections.map((section) => {
            // Fields belonging to this section, sorted by order
            const sectionFields = fields
              .filter((f) => f.section === section.key)
              .sort((a, b) => a.order - b.order);

            if (sectionFields.length === 0) return null;

            // Billing section gets special "same as shipping" toggle
            const isBilling = section.key === "billing";

            return (
              <div key={section.key} style={sectionStyle}>
                {/* Section heading row */}
                {isBilling ? (
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <h4 style={{ ...sectionHeadingStyle, margin: 0 }}>
                      {section.label}
                    </h4>
                    <label
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        fontSize: 13,
                        cursor: "pointer",
                        color: "#374151",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={!!editForm.useSameAddress}
                        onChange={(e) =>
                          setEditForm((f) => ({
                            ...f,
                            useSameAddress: e.target.checked,
                          }))
                        }
                      />
                      Same as shipping
                    </label>
                  </div>
                ) : (
                  <h4 style={sectionHeadingStyle}>{section.label}</h4>
                )}

                {/* For billing: only render fields if not "same as shipping" */}
                {isBilling && editForm.useSameAddress ? null : (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(220px, 1fr))",
                      gap: 10,
                    }}
                  >
                    {sectionFields.map((field) =>
                      (() => {
                        const countryValue =
                          field.section === "billing"
                            ? (editForm.biCountry ?? editForm.billCountry)
                            : field.section === "shipping"
                              ? (editForm.shCountry ?? editForm.shipCountry)
                              : (editForm.shCountry ?? editForm.shipCountry);
                        const phoneMeta =
                          field.type === "phone"
                            ? getPhoneMetaForCountry(String(countryValue ?? ""))
                            : null;
                        const stateOptions =
                          field.type === "select" && /state/i.test(field.key)
                            ? getProvinceOptionsForCountry(
                                String(countryValue ?? ""),
                                shippingProvincesByCountry,
                              )
                            : null;

                        return (
                          <div
                            key={field.key}
                            style={{
                              gridColumn:
                                field.width === "full" ? "1 / -1" : undefined,
                            }}
                          >
                            <DynamicField
                              field={{
                                ...field,
                                ...(phoneMeta
                                  ? {
                                      countryCode: phoneMeta.dialCode,
                                      flagEmoji: phoneMeta.flagEmoji,
                                    }
                                  : {}),
                                ...(stateOptions
                                  ? { options: stateOptions }
                                  : {}),
                              }}
                              value={String(editForm[field.key] ?? "")}
                              onChange={(val) =>
                                setEditForm((f) => ({ ...f, [field.key]: val }))
                              }
                            />
                          </div>
                        );
                      })(),
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* ── Footer ── */}
        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid #e3e3e3",
            background: "white",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            position: "sticky",
            bottom: 0,
          }}
        >
          <button
            onClick={onClose}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: "1px solid #c9ccd0",
              background: "white",
              cursor: "pointer",
              fontSize: 14,
              fontWeight: 500,
            }}
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: "none",
              background: "#1a1a1a",
              color: "white",
              cursor: "pointer",
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}


function ConfigureCompanyUI({
  submission,
  company,
  customer,
  formConfig,
  shippingCountryOptions,
  shippingProvincesByCountry,
  onSubmissionUpdated,
  paymentTermsTemplates,
  // ── NEW props ──
  allCatalogs = [],
  priceLists = [],
  onApprove,
  onCancel,
  isApproving,
  pipelineStep,
  pipelineError,
}: {
  submission: RegistrationSubmission;
  company: ActionJson["company"];
  customer: ActionJson["customer"];
  formConfig: FormConfig;
  shippingCountryOptions: CountryOption[];
  shippingProvincesByCountry: Record<string, CountryOption[]>;
  onSubmissionUpdated: (submission: any) => void;
  paymentTermsTemplates: Array<{
    id: string;
    name: string;
    paymentTermsType: string;
    dueInDays: number | null;
  }>;
  // ── NEW ──
  allCatalogs?: CatalogNode[];
  priceLists?: PriceListNode[];
  onApprove: (opts: {
    paymentTermsId: string;
    requireDeposit: boolean;
    allowOneTimeAddress: boolean;
    orderSubmission: "auto" | "draft";
    taxSetting: string;
    selectedCatalogIds: string[];
  }) => void;
  onCancel: () => void;
  isApproving: boolean;
  pipelineStep: PipelineStep;
  pipelineError?: string;
}) {
  const [paymentTermsId, setPaymentTermsId]     = useState(submission.paymentTerm || "");
  const [requireDeposit, setRequireDeposit]       = useState(false);
  const [allowOneTimeAddress, setAllowOneTimeAddress] = useState(false);
  const [orderSubmission, setOrderSubmission]     = useState<"auto" | "draft">("auto");
  const [taxSetting, setTaxSetting]               = useState("collect");
  const [showEditModal, setShowEditModal]         = useState(false);
 
  // ── Catalog state ──
  const [catalogSearch, setCatalogSearch]         = useState("");
  const [selectedCatalogIds, setSelectedCatalogIds] = useState<string[]>([]);
  const [showCatalogDropdown, setShowCatalogDropdown] = useState(false);
  const catalogFetcher = useFetcher<{ intent: string; success: boolean; errors?: string[]; message?: string }>();
 
  const editFetcher = useFetcher<ActionJson>();
  const shopify     = useAppBridge();
 
  const s = (submission as any)?.shipping as Record<string, string> | undefined;
  const b = (submission as any)?.billing  as Record<string, string> | undefined;
 
  const shippingLine1    = s?.Addr1 || "Address line 1";
  const shippingRecipient = s
    ? `${s.FirstName || ""} ${s.LastName || ""}`.trim() || "Recipient"
    : "Recipient";
  const billingSame =
    !b || (submission as any)?.customFields?.billSameAsShip !== "false";
 
  const { sections: editSections, fields: editFields } = useMemo(
    () => buildEditModalConfig(formConfig, shippingCountryOptions),
    [formConfig, shippingCountryOptions],
  );
 
  const contactName = customer
    ? `${customer.firstName || ""} ${customer.lastName || ""}`.trim()
    : `${submission.firstName || ""} ${submission.lastName || ""}`.trim();
  const companyDisplayName = company?.name || submission.companyName;
 
  const [editForm, setEditForm] = useState(() =>
    buildInitialEditForm(submission, customer, billingSame, editFields),
  );
  useEffect(() => {
    setEditForm(buildInitialEditForm(submission, customer, billingSame, editFields));
  }, [submission, customer, billingSame, editFields]);
 
  // ── Pre-select catalogs already assigned to this location ──
  useEffect(() => {
    if (!company?.locationId) return;
    const preSelected = allCatalogs
      .filter((c) =>
        c.companyLocations?.nodes?.some((loc) => loc.id === company.locationId),
      )
      .map((c) => c.id);
    setSelectedCatalogIds(preSelected);
  }, [allCatalogs, company?.locationId]);
 
  // ── Catalog helpers ──
  const activeCatalogs = allCatalogs.filter((c) => c.status === "ACTIVE");
 
  const filteredCatalogs = activeCatalogs.filter((c) =>
    c.title.toLowerCase().includes(catalogSearch.toLowerCase()),
  );
 
  const selectedCatalogs = activeCatalogs.filter((c) =>
    selectedCatalogIds.includes(c.id),
  );
 
  const toggleCatalog = useCallback(
    (catalogId: string) => {
      const locationId = company?.locationId;
      if (!locationId) return;
 
      const isCurrentlySelected = selectedCatalogIds.includes(catalogId);
 
      // Optimistic UI update
      setSelectedCatalogIds((prev) =>
        isCurrentlySelected
          ? prev.filter((id) => id !== catalogId)
          : [...prev, catalogId],
      );
 
      // Fire action to sync with Shopify
      catalogFetcher.submit(
        {
          intent: isCurrentlySelected ? "removeCatalog" : "assignCatalog",
          catalogId,
          locationId,
        },
        { method: "post" },
      );
    },
    [catalogFetcher, company?.locationId, selectedCatalogIds],
  );
 
  const removeCatalog = useCallback(
    (catalogId: string) => {
      const locationId = company?.locationId;
      if (!locationId) return;
      setSelectedCatalogIds((prev) => prev.filter((id) => id !== catalogId));
      catalogFetcher.submit(
        { intent: "removeCatalog", catalogId, locationId },
        { method: "post" },
      );
    },
    [catalogFetcher, company?.locationId],
  );
 
  // ── Toast on catalog action ──
  useEffect(() => {
    if (catalogFetcher.state !== "idle" || !catalogFetcher.data) return;
    if (!catalogFetcher.data.success && catalogFetcher.data.errors?.length) {
      shopify.toast.show?.(catalogFetcher.data.errors[0]);
    }
  }, [catalogFetcher.data, catalogFetcher.state, shopify]);
 
  // ── Edit modal save ──
  const handleSaveEditDetails = useCallback(() => {
    editFetcher.submit(
      {
        intent: "updatecustomerCompanyDetails",
        registrationId: submission.id,
        customerId: customer?.id || submission.shopifyCustomerId || "",
        companyId: company?.id || "",
        companyLocationId: company?.locationId || "",
        ...Object.fromEntries(
          Object.entries(editForm).map(([key, value]) => [key, String(value ?? "")]),
        ),
      },
      { method: "post" },
    );
  }, [company, customer, editFetcher, editForm, submission]);
 
  useEffect(() => {
    if (editFetcher.state !== "idle" || !editFetcher.data) return;
    if (editFetcher.data.success) {
      if (editFetcher.data.submission) onSubmissionUpdated(editFetcher.data.submission);
      setShowEditModal(false);
      shopify.toast.show?.(editFetcher.data.message || "Details updated");
      return;
    }
    if (editFetcher.data.errors?.length) shopify.toast.show?.(editFetcher.data.errors[0]);
  }, [editFetcher.data, editFetcher.state, onSubmissionUpdated, shopify]);
 
  const showProgress = pipelineStep !== "idle" && pipelineStep !== "error";
  const isDone       = pipelineStep === "done";
  const hasError     = pipelineStep === "error";
 
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(17, 24, 39, 0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 40,
      }}
    >
      <div
        style={{
          width: "min(740px, 96vw)",
          background: "#f1f1f1",
          borderRadius: 12,
          boxShadow: "0 12px 40px rgba(0,0,0,0.18)",
          maxHeight: "96vh",
          overflowY: "auto",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        {/* ── Header ── */}
        <div
          style={{
            background: "white",
            padding: "16px 20px",
            borderBottom: "1px solid #e3e3e3",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                onClick={onCancel}
                disabled={isApproving}
                style={{
                  background: "none", border: "none",
                  cursor: isApproving ? "not-allowed" : "pointer",
                  color: "#5c5f62", fontSize: 18,
                  padding: "0 4px 0 0", lineHeight: 1,
                  opacity: isApproving ? 0.4 : 1,
                }}
              >
                ←
              </button>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
                Configure company
              </h2>
            </div>
            <p style={{ margin: "4px 0 0 28px", color: "#5c5f62", fontSize: 13 }}>
              Review Company settings before approving. You will be able to change these later.
            </p>
          </div>
 
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <button
              onClick={onCancel}
              disabled={isApproving}
              style={{
                padding: "8px 16px", borderRadius: 8,
                border: "1px solid #c9ccd0", background: "white",
                cursor: isApproving ? "not-allowed" : "pointer",
                fontSize: 14, fontWeight: 500,
                opacity: isApproving ? 0.4 : 1,
              }}
            >
              {isDone ? "Close" : "Cancel"}
            </button>
 
            {!isDone && (
              <button
                onClick={() =>
                  onApprove({
                    paymentTermsId,
                    requireDeposit,
                    allowOneTimeAddress,
                    orderSubmission,
                    taxSetting,
                    selectedCatalogIds, // ← passed to parent
                  })
                }
                disabled={isApproving}
                style={{
                  padding: "8px 16px", borderRadius: 8, border: "none",
                  background: isApproving ? "#6b9fd4" : "#1a1a1a",
                  color: "white",
                  cursor: isApproving ? "not-allowed" : "pointer",
                  fontSize: 14, fontWeight: 600, minWidth: 110,
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                }}
              >
                {isApproving ? (
                  <>
                    <span
                      style={{
                        display: "inline-block", width: 13, height: 13,
                        border: "2px solid rgba(255,255,255,0.35)",
                        borderTop: "2px solid white",
                        borderRadius: "50%",
                        animation: "spin 0.7s linear infinite",
                      }}
                    />
                    Processing…
                  </>
                ) : hasError ? "Retry" : "Approve"}
              </button>
            )}
          </div>
        </div>
 
        {/* ── Progress bar ── */}
        {(showProgress || hasError) && (
          <div style={{ background: "white", borderBottom: "1px solid #e3e3e3", padding: "14px 20px 12px" }}>
            <ProgressBar currentStep={pipelineStep} error={pipelineError} />
          </div>
        )}
 
        {/* ── Success banner ── */}
        {isDone && (
          <div style={{ padding: "16px 20px 0" }}>
            <div
              style={{
                background: "#f0fdf4", border: "1px solid #bbf7d0",
                borderRadius: 10, padding: 16,
                display: "flex", alignItems: "flex-start", gap: 12,
              }}
            >
              <div
                style={{
                  width: 36, height: 36, borderRadius: "50%", background: "#16a34a",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: "white", fontSize: 18, flexShrink: 0,
                }}
              >
                ✓
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15, color: "#15803d" }}>
                  Registration Approved Successfully
                </div>
                <div style={{ fontSize: 13, color: "#166534", marginTop: 3 }}>
                  {contactName} has been approved and their account is now active under{" "}
                  <strong>{companyDisplayName}</strong>.
                </div>
                <button
                  onClick={onCancel}
                  style={{
                    marginTop: 10, padding: "6px 16px",
                    background: "#16a34a", color: "white",
                    border: "none", borderRadius: 6,
                    cursor: "pointer", fontSize: 13, fontWeight: 600,
                  }}
                >
                  Done — Close
                </button>
              </div>
            </div>
          </div>
        )}
 
        {/* ── Error banner ── */}
        {hasError && pipelineError && (
          <div style={{ padding: "16px 20px 0" }}>
            <div
              style={{
                background: "#fef2f2", border: "1px solid #fecaca",
                borderRadius: 10, padding: 14,
              }}
            >
              <div style={{ fontWeight: 600, color: "#dc2626", marginBottom: 4 }}>
                Something went wrong
              </div>
              <div style={{ fontSize: 13, color: "#7f1d1d" }}>{pipelineError}</div>
            </div>
          </div>
        )}
 
        {/* ── Two-column body ── */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 220px",
            gap: 16, padding: 16,
            alignItems: "start",
            opacity: isApproving || isDone ? 0.5 : 1,
            pointerEvents: isApproving || isDone ? "none" : "auto",
            transition: "opacity 0.25s",
          }}
        >
          {/* ── LEFT COLUMN ── */}
          <div style={{ display: "grid", gap: 12 }}>
 
            {/* ───────────────────────────────────────────────────
                CATALOGS SECTION — fully wired with real data
            ─────────────────────────────────────────────────── */}
            <div
              style={{
                background: "white", borderRadius: 10,
                border: "1px solid #e3e3e3", padding: 16,
              }}
            >
              <div
                style={{
                  display: "flex", justifyContent: "space-between",
                  alignItems: "center", marginBottom: 12,
                }}
              >
                <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
                  Catalogs
                </h3>
                {!company?.locationId && (
                  <span style={{ fontSize: 11, color: "#d97706", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 4, padding: "2px 7px" }}>
                    Save company first to assign catalogs
                  </span>
                )}
              </div>
 
              {/* Search + dropdown */}
              <div style={{ position: "relative", marginBottom: 10 }}>
                <input
                  placeholder={
                    activeCatalogs.length === 0
                      ? "No catalogs available"
                      : "Search catalogs to add…"
                  }
                  value={catalogSearch}
                  disabled={!company?.locationId || activeCatalogs.length === 0}
                  onChange={(e) => {
                    setCatalogSearch(e.target.value);
                    setShowCatalogDropdown(true);
                  }}
                  onFocus={() => setShowCatalogDropdown(true)}
                  style={{
                    width: "100%",
                    padding: "8px 12px",
                    borderRadius: 8,
                    border: "1px solid #c9ccd0",
                    fontSize: 14,
                    boxSizing: "border-box",
                    background: !company?.locationId || activeCatalogs.length === 0 ? "#f9fafb" : "white",
                  }}
                />
 
                {/* Dropdown list */}
                {showCatalogDropdown && company?.locationId && filteredCatalogs.length > 0 && (
                  <div
                    style={{
                      position: "absolute",
                      top: "100%",
                      left: 0,
                      right: 0,
                      background: "white",
                      border: "1px solid #e3e3e3",
                      borderRadius: 8,
                      boxShadow: "0 4px 16px rgba(0,0,0,0.10)",
                      zIndex: 10,
                      maxHeight: 200,
                      overflowY: "auto",
                      marginTop: 4,
                    }}
                  >
                    {filteredCatalogs.map((catalog) => {
                      const isSelected = selectedCatalogIds.includes(catalog.id);
                      return (
                        <div
                          key={catalog.id}
                          onClick={() => {
                            toggleCatalog(catalog.id);
                            setCatalogSearch("");
                            setShowCatalogDropdown(false);
                          }}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            padding: "9px 12px",
                            cursor: "pointer",
                            background: isSelected ? "#f0f9ff" : "white",
                            borderBottom: "1px solid #f3f4f6",
                          }}
                          onMouseEnter={(e) =>
                            ((e.currentTarget as HTMLDivElement).style.background =
                              isSelected ? "#e0f2fe" : "#f9fafb")
                          }
                          onMouseLeave={(e) =>
                            ((e.currentTarget as HTMLDivElement).style.background =
                              isSelected ? "#f0f9ff" : "white")
                          }
                        >
                          {/* Checkbox-style indicator */}
                          <div
                            style={{
                              width: 16,
                              height: 16,
                              borderRadius: 4,
                              border: `2px solid ${isSelected ? "#1a1a1a" : "#c9ccd0"}`,
                              background: isSelected ? "#1a1a1a" : "white",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              flexShrink: 0,
                              color: "white",
                              fontSize: 11,
                            }}
                          >
                            {isSelected && "✓"}
                          </div>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 500, color: "#1a1a1a" }}>
                              {catalog.title}
                            </div>
                            {catalog.priceList?.name && (
                              <div style={{ fontSize: 11, color: "#5c5f62" }}>
                                {catalog.priceList.name} · {catalog.priceList.currency}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
 
              {/* Click-away to close dropdown */}
              {showCatalogDropdown && (
                <div
                  style={{ position: "fixed", inset: 0, zIndex: 9 }}
                  onClick={() => setShowCatalogDropdown(false)}
                />
              )}
 
              {/* Selected / assigned catalogs list */}
              {selectedCatalogs.length === 0 ? (
                <div
                  style={{
                    padding: "12px 0",
                    textAlign: "center",
                    color: "#9ca3af",
                    fontSize: 13,
                  }}
                >
                  No catalogs assigned — search above to add one.
                </div>
              ) : (
                <div style={{ display: "grid", gap: 6 }}>
                  {selectedCatalogs.map((catalog) => (
                    <div
                      key={catalog.id}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "8px 10px",
                        background: "#f9fafb",
                        borderRadius: 7,
                        border: "1px solid #e3e3e3",
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 500, fontSize: 13 }}>
                          {catalog.title}
                        </div>
                        <div style={{ fontSize: 11, color: "#5c5f62" }}>
                          {catalog.priceList?.name
                            ? `${catalog.priceList.name} · ${catalog.priceList.currency}`
                            : "No price list"}
                        </div>
                      </div>
                      <button
                        onClick={() => removeCatalog(catalog.id)}
                        disabled={catalogFetcher.state !== "idle"}
                        style={{
                          background: "none",
                          border: "none",
                          cursor: catalogFetcher.state !== "idle" ? "not-allowed" : "pointer",
                          color: "#9ca3af",
                          fontSize: 18,
                          lineHeight: 1,
                          padding: "0 2px",
                          opacity: catalogFetcher.state !== "idle" ? 0.4 : 1,
                        }}
                        title="Remove catalog"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
 
              {/* Loading indicator */}
              {catalogFetcher.state !== "idle" && (
                <div style={{ fontSize: 11, color: "#5c5f62", marginTop: 8, textAlign: "center" }}>
                  Syncing with Shopify…
                </div>
              )}
            </div>
 
            {/* Payment terms */}
            <div
              style={{
                background: "white", borderRadius: 10,
                border: "1px solid #e3e3e3", padding: 16,
              }}
            >
              <h3 style={{ margin: "0 0 12px 0", fontSize: 14, fontWeight: 600 }}>
                Payment terms
              </h3>
              <select
                value={paymentTermsId}
                onChange={(e) => setPaymentTermsId(e.target.value)}
                style={{
                  width: "100%", padding: "8px 12px", borderRadius: 8,
                  border: "1px solid #c9ccd0", fontSize: 14,
                  background: "white", boxSizing: "border-box", marginBottom: 10,
                }}
              >
                <option value="">No payment terms</option>
                {paymentTermsTemplates?.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
                {(!paymentTermsTemplates || paymentTermsTemplates.length === 0) && (
                  <>
                    <option value="net15">Within 15 days (Net 15)</option>
                    <option value="net30">Within 30 days (Net 30)</option>
                    <option value="net60">Within 60 days (Net 60)</option>
                  </>
                )}
              </select>
              <label
                style={{
                  display: "flex", alignItems: "center",
                  gap: 8, fontSize: 13, cursor: "pointer", color: "#374151",
                }}
              >
                <input
                  type="checkbox"
                  checked={requireDeposit}
                  onChange={(e) => setRequireDeposit(e.target.checked)}
                />
                Require deposit on orders created at checkout
              </label>
            </div>
 
            {/* Checkout */}
            <div
              style={{
                background: "white", borderRadius: 10,
                border: "1px solid #e3e3e3", padding: 16,
              }}
            >
              <h3 style={{ margin: "0 0 12px 0", fontSize: 14, fontWeight: 600 }}>
                Checkout
              </h3>
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: "#374151" }}>
                  Ship to address
                </div>
                <label
                  style={{
                    display: "flex", alignItems: "center",
                    gap: 8, fontSize: 13, cursor: "pointer", color: "#374151",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={allowOneTimeAddress}
                    onChange={(e) => setAllowOneTimeAddress(e.target.checked)}
                  />
                  Allow customers to ship to any one-time address
                </label>
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: "#374151" }}>
                  Order submission
                </div>
                <label
                  style={{
                    display: "flex", alignItems: "flex-start",
                    gap: 8, fontSize: 13, cursor: "pointer",
                    marginBottom: 6, color: "#374151",
                  }}
                >
                  <input
                    type="radio" name="orderSubmission" value="auto"
                    checked={orderSubmission === "auto"}
                    onChange={() => setOrderSubmission("auto")}
                    style={{ marginTop: 2 }}
                  />
                  <div>
                    <div>Automatically submit orders</div>
                    <div style={{ fontSize: 12, color: "#5c5f62" }}>
                      Orders without shipping addresses will be submitted as draft orders
                    </div>
                  </div>
                </label>
                <label
                  style={{
                    display: "flex", alignItems: "center",
                    gap: 8, fontSize: 13, cursor: "pointer", color: "#374151",
                  }}
                >
                  <input
                    type="radio" name="orderSubmission" value="draft"
                    checked={orderSubmission === "draft"}
                    onChange={() => setOrderSubmission("draft")}
                  />
                  Submit all orders as drafts for review
                </label>
              </div>
            </div>
 
            {/* Taxes */}
            <div
              style={{
                background: "white", borderRadius: 10,
                border: "1px solid #e3e3e3", padding: 16,
              }}
            >
              <h3 style={{ margin: "0 0 12px 0", fontSize: 14, fontWeight: 600 }}>
                Taxes
              </h3>
              <select
                value={taxSetting}
                onChange={(e) => setTaxSetting(e.target.value)}
                style={{
                  width: "100%", padding: "8px 12px", borderRadius: 8,
                  border: "1px solid #c9ccd0", fontSize: 14,
                  background: "white", boxSizing: "border-box",
                }}
              >
                <option value="collect">Collect tax</option>
                <option value="exempt">Tax exempt</option>
                <option value="custom">Custom tax rate</option>
              </select>
            </div>
          </div>
 
          {/* ── RIGHT COLUMN — summary card ── */}
          <div
            style={{
              background: "white", borderRadius: 10,
              border: "1px solid #e3e3e3", padding: 16,
              fontSize: 13, position: "sticky", top: 16,
            }}
          >
            <div
              style={{
                display: "flex", justifyContent: "space-between",
                alignItems: "center", marginBottom: 12,
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                {editForm.companyName || companyDisplayName}
              </div>
              <button
                onClick={() => setShowEditModal(true)}
                style={{
                  background: "none", border: "1px solid #c9ccd0",
                  borderRadius: 6, padding: "4px 10px",
                  fontSize: 12, fontWeight: 500,
                  cursor: "pointer", color: "#374151",
                }}
              >
                Edit
              </button>
            </div>
 
            {/* Customer */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#5c5f62", marginBottom: 3 }}>
                Customer
              </div>
              <div style={{ color: "#374151" }}>
                {`${editForm.firstName} ${editForm.lastName}`.trim() || contactName}
              </div>
              <div style={{ color: "#2c6ecb", textDecoration: "underline" }}>
                {customer?.email || submission.email}
              </div>
            </div>
 
            {/* Shipping */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#5c5f62", marginBottom: 3 }}>
                Shipping address
              </div>
              <div style={{ color: "#374151", lineHeight: 1.6 }}>
                <div>
                  {`${editForm.shFirstName} ${editForm.shLastName}`.trim() || shippingRecipient}
                </div>
                <div>{editForm.shAddr1 || shippingLine1}</div>
                <div>
                  {editForm.shCity}, {editForm.shState} {editForm.shZip}
                </div>
                <div>{editForm.shCountry}</div>
              </div>
            </div>
 
            {/* Billing */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#5c5f62", marginBottom: 3 }}>
                Billing address
              </div>
              {editForm.useSameAddress ? (
                <div style={{ color: "#5c5f62", fontStyle: "italic" }}>
                  Same as shipping address
                </div>
              ) : (
                <div style={{ color: "#374151", lineHeight: 1.6 }}>
                  <div>{editForm.biAddr1}</div>
                  <div>
                    {editForm.biCity}, {editForm.biState} {editForm.biZip}
                  </div>
                  <div>{editForm.biCountry}</div>
                </div>
              )}
            </div>
 
            {/* Assigned catalogs summary */}
            {selectedCatalogs.length > 0 && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#5c5f62", marginBottom: 4 }}>
                  Catalogs ({selectedCatalogs.length})
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {selectedCatalogs.map((c) => (
                    <span
                      key={c.id}
                      style={{
                        fontSize: 11,
                        background: "#f0f9ff",
                        border: "1px solid #bae6fd",
                        borderRadius: 4,
                        padding: "2px 7px",
                        color: "#0369a1",
                      }}
                    >
                      {c.title}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
 
          {/* ── Edit Details Modal ── */}
          {showEditModal && (
            <EditDetailsModal
              editForm={editForm}
              setEditForm={setEditForm}
              onClose={() => setShowEditModal(false)}
              onSave={handleSaveEditDetails}
              sections={editSections}
              fields={editFields}
              shippingProvincesByCountry={shippingProvincesByCountry}
            />
          )}
        </div>
      </div>
 
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
// ─── Main Component ───────────────────────────────────────────────────────────
export default function RegistrationApprovals() {
  const {
    submissions,
    storeMissing,
    formConfig,
    shippingCountryOptions,
    shippingProvincesByCountry,
    paymentTermsTemplates,
  } = useLoaderData<{
    submissions: RegistrationSubmission[];
    companies: any[];
    formConfig: FormConfig;
    shippingCountryOptions: CountryOption[];
    shippingProvincesByCountry: Record<string, CountryOption[]>;
    storeMissing: boolean;
    paymentTermsTemplates: Array<{
      id: string;
      name: string;
      paymentTermsType: string;
      dueInDays: number | null;
    }>;
  }>();

  // ── List state (UNCHANGED) ────────────────────────────────────────────────
  const [searchParams] = useSearchParams();
  const statusFromUrl = searchParams.get("status");
  const normalizeStatus = (v: string | null) => {
    switch (v?.toUpperCase()) {
      case "APPROVED":
        return "APPROVED";
      case "REJECTED":
        return "REJECTED";
      default:
        return "PENDING";
    }
  };
  const [statusFilter, setStatusFilter] = useState<
    "PENDING" | "APPROVED" | "REJECTED"
  >(normalizeStatus(statusFromUrl));
  useEffect(() => {
    setStatusFilter(normalizeStatus(statusFromUrl));
  }, [statusFromUrl]);

  const filteredSubmissions = useMemo(
    () => submissions.filter((s) => s.status === statusFilter),
    [submissions, statusFilter],
  );

  // ── Pipeline state ────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<RegistrationSubmission | null>(null);
  const [showConfigureUI, setShowConfigureUI] = useState(false);
  const [pipelineStep, setPipelineStep] = useState<PipelineStep>("idle");
  const [pipelineError, setPipelineError] = useState<string | undefined>();
  const [customer, setCustomer] = useState<ActionJson["customer"]>(null);
  const [company, setCompany] = useState<ActionJson["company"]>(null);

  // Store config opts set at Approve click time
  const configOptsRef = useRef<{
    paymentTermsId: string;
    requireDeposit: boolean;
    allowOneTimeAddress: boolean;
    orderSubmission: "auto" | "draft";
    taxSetting: string;
  } | null>(null);

  // Store resolved customer/company in refs so pipeline useEffect always has latest
  const customerRef = useRef<ActionJson["customer"]>(null);
  const companyRef = useRef<ActionJson["company"]>(null);
  const selectedRef = useRef<RegistrationSubmission | null>(null);

  const flowFetcher = useFetcher<ActionJson>();
  const rejectFetcher = useFetcher<ActionJson>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();

  const isFlowLoading = flowFetcher.state !== "idle";
  const isCheckingCustomer =
    isFlowLoading && flowFetcher.formData?.get("intent") === "checkCustomer";
  const isApproving =
    pipelineStep !== "idle" &&
    pipelineStep !== "done" &&
    pipelineStep !== "error";

  // Keep refs in sync
  useEffect(() => {
    customerRef.current = customer;
  }, [customer]);
  useEffect(() => {
    companyRef.current = company;
  }, [company]);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  // ── Reset pipeline ──────────────────────────────────────────────────────
  const resetPipeline = useCallback(() => {
    setSelected(null);
    setShowConfigureUI(false);
    setPipelineStep("idle");
    setPipelineError(undefined);
    setCustomer(null);
    setCompany(null);
    customerRef.current = null;
    companyRef.current = null;
    configOptsRef.current = null;
  }, []);

  const handleSubmissionUpdated = useCallback((updatedSubmission: any) => {
    setSelected(updatedSubmission);
    selectedRef.current = updatedSubmission;
  }, []);

  // ── Open Configure UI ───────────────────────────────────────────────────
  const startApproval = (submission: RegistrationSubmission) => {
    setSelected(submission);
    selectedRef.current = submission;
    setCustomer(null);
    setCompany(null);
    customerRef.current = null;
    companyRef.current = null;
    setPipelineStep("idle");
    setPipelineError(undefined);
    setShowConfigureUI(true);
  };

  // ── User clicks Approve in ConfigureCompanyUI — kick off pipeline ───────
  const handleConfigureApprove = useCallback(
    (opts: {
      paymentTermsId: string;
      requireDeposit: boolean;
      allowOneTimeAddress: boolean;
      orderSubmission: "auto" | "draft";
      taxSetting: string;
    }) => {
      const sub = selectedRef.current;
      if (!sub) return;
      configOptsRef.current = opts;
      setPipelineStep("checkCustomer");
      setPipelineError(undefined);

      flowFetcher.submit(
        { intent: "checkCustomer", email: sub.email },
        { method: "post" },
      );
    },
    [flowFetcher],
  );

  // ── Pipeline: advance on each successful action response ─────────────────
  useEffect(() => {
    const data = flowFetcher.data;
    if (!data || flowFetcher.state !== "idle") return;

    const sub = selectedRef.current;
    const opts = configOptsRef.current;
    if (!sub || !opts) return;

    const fail = (msg: string) => {
      setPipelineStep("error");
      setPipelineError(msg);
    };

    // ── 1. checkCustomer → approveRegistration ───────────────────────────
    if (data.intent === "checkCustomer") {
      if (data.errors?.length) return fail(data.errors[0]);

      const resolvedCustomer = data.customer ?? null;
      setCustomer(resolvedCustomer);
      customerRef.current = resolvedCustomer;

      if (!resolvedCustomer) {
        return fail(
          "No Shopify customer found for this email. Please create the customer first from the approval flow.",
        );
      }

      setPipelineStep("approveRegistration");
      flowFetcher.submit(
        {
          intent: "approveRegistration",
          registrationId: sub.id,
          customerId: resolvedCustomer.id,
          companyName: sub.companyName,
          paymentTerms: opts.paymentTermsId,
          creditLimit: sub.creditLimit || "",
          customerEmail: resolvedCustomer.email,
          firstName: resolvedCustomer.firstName || sub.firstName || "",
          lastName: resolvedCustomer.lastName || sub.lastName || "",
          reviewNotes: "",
        },
        { method: "post" },
      );
      return;
    }

    // ── 2. approveRegistration → done ────────────────────────────────────
    if (data.intent === "approveRegistration") {
      if (!data.success || data.errors?.length)
        return fail(data.errors?.[0] || "Failed to approve registration");

      const resolvedCompany = data.company ?? null;
      setCompany(resolvedCompany);
      companyRef.current = resolvedCompany;

      setPipelineStep("done");
      shopify.toast.show?.("Registration approved successfully!");
      revalidator.revalidate();
      return;
    }
  }, [flowFetcher.data, flowFetcher.state]);

  // ── Reject (unchanged) ───────────────────────────────────────────────────
  const rejectSubmission = (submission: RegistrationSubmission) => {
    if (!window.confirm(`Reject registration for ${submission.companyName}?`))
      return;
    rejectFetcher.submit(
      { intent: "reject", registrationId: submission.id },
      { method: "post" },
    );
  };

  useEffect(() => {
    if (rejectFetcher.data?.success) {
      revalidator.revalidate();
      shopify.toast.show?.("Registration rejected");
    }
  }, [rejectFetcher.data]);

  if (storeMissing) {
    return (
      <s-page heading="Registrations">
        <s-section>
          <s-banner tone="critical">
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              Store not found
            </div>
            <s-paragraph>
              The current shop does not exist in the database. Please reinstall
              the app.
            </s-paragraph>
          </s-banner>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Registration submissions">
      {/* ── Status Filter Tabs + Table (COMPLETELY UNCHANGED) ──────────── */}
      <s-section heading="">
        <div
          style={{
            display: "flex",
            gap: 8,
            marginBottom: 16,
            borderBottom: "1px solid #e3e3e3",
          }}
        >
          {(["PENDING", "APPROVED", "REJECTED"] as const).map((status) => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              style={{
                padding: "8px 16px",
                background: "none",
                border: "none",
                borderBottom:
                  statusFilter === status
                    ? "2px solid #2c6ecb"
                    : "2px solid transparent",
                color: statusFilter === status ? "#2c6ecb" : "#5c5f62",
                fontWeight: statusFilter === status ? 600 : 400,
                cursor: "pointer",
                transition: "all 0.2s",
              }}
            >
              {status.charAt(0) + status.slice(1).toLowerCase()} (
              {submissions.filter((s) => s.status === status).length})
            </button>
          ))}
        </div>

        {filteredSubmissions.length === 0 ? (
          <s-paragraph>
            There are no {statusFilter.toLowerCase()} submissions yet.
          </s-paragraph>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                minWidth: 900,
              }}
            >
              <thead>
                <tr>
                  {[
                    "Company",
                    "Contact",
                    "Email",
                    "Phone",
                    "Status",
                    "Created",
                    "Actions",
                  ].map((h) => (
                    <th key={h} style={{ textAlign: "left", padding: "8px" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredSubmissions.map((submission) => (
                  <tr
                    key={submission.id}
                    style={{ borderTop: "1px solid #e3e3e3" }}
                  >
                    <td style={{ padding: "8px" }}>{submission.companyName}</td>
                    <td style={{ padding: "8px" }}>
                      {submission.firstName} {submission.lastName}
                    </td>
                    <td style={{ padding: "8px" }}>{submission.email}</td>
                    <td style={{ padding: "8px" }}>
                      {(submission as any)?.shipping?.Phone}
                    </td>
                    <td style={{ padding: "8px" }}>
                      <s-badge
                        tone={
                          submission.status === "APPROVED"
                            ? "success"
                            : submission.status === "REJECTED"
                              ? "critical"
                              : "warning"
                        }
                      >
                        {submission.status}
                      </s-badge>
                    </td>
                    <td style={{ padding: "8px" }}>
                      {formatDate(submission.createdAt)}
                    </td>
                    <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                      {submission.status === "PENDING" ? (
                        <>
                          <s-button
                            onClick={() => startApproval(submission)}
                            {...(isCheckingCustomer &&
                            selected?.id === submission.id
                              ? { loading: true }
                              : {})}
                          >
                            Approve
                          </s-button>
                          <span style={{ marginLeft: 8 }}>
                            <s-button
                              tone="critical"
                              variant="tertiary"
                              onClick={() => rejectSubmission(submission)}
                              {...(rejectFetcher.state !== "idle" &&
                              selected?.id === submission.id
                                ? { loading: true }
                                : {})}
                            >
                              Reject
                            </s-button>
                          </span>
                        </>
                      ) : (
                        <span style={{ color: "#5c5f62", fontSize: 14 }}>
                          {submission.status === "APPROVED"
                            ? "Approved"
                            : "Rejected"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </s-section>

      {/* ── Configure Company UI ─────────────────────────────────────────── */}
      {showConfigureUI && selected && (
        <ConfigureCompanyUI
          submission={selected}
          company={company}
          customer={customer}
          formConfig={formConfig}
          shippingCountryOptions={shippingCountryOptions}
          shippingProvincesByCountry={shippingProvincesByCountry}
          onSubmissionUpdated={handleSubmissionUpdated}
          paymentTermsTemplates={paymentTermsTemplates}
          onApprove={handleConfigureApprove}
          onCancel={resetPipeline}
          isApproving={isApproving}
          pipelineStep={pipelineStep}
          pipelineError={pipelineError}
        />
      )}
    </s-page>
  );
}
export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
