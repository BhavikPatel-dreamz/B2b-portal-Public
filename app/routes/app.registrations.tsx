import { useEffect, useMemo, useRef, useState } from "react";
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
import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { sendCompanyAssignmentEmail } from "app/utils/email";
import { updateCompanyMetafield } from "app/services/company.server";

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

interface CompanyAccount {
  id: string;
  name: string;
  shopifyCompanyId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  creditLimit: string;
  paymentTerms: string | null;
  updatedAt: string;
}

const normalizeCustomerId = (id?: string | null) => {
  if (!id) return null;
  return id.startsWith("gid://") ? id : `gid://shopify/Customer/${id}`;
};

const buildUserErrorList = (payload: any) => {
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
};

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

  // Fetch ALL submissions (PENDING, APPROVED, REJECTED)
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

  // Attach Shopify location info for each company (if we have a shopifyCompanyId)
  const companiesWithLocations = await Promise.all(
    companies.map(async (c) => {
      if (!c.shopifyCompanyId) {
        return { ...c, locationId: null, locationName: null };
      }

      try {
        const locationResp = await admin.graphql(
          `#graphql
          query GetCompanyLocation($companyId: ID!) {
            company(id: $companyId) {
              locations(first: 1) {
                nodes { id name }
              }
            }
          }
        `,
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

  // Fetch payment terms templates
  const paymentTermsResponse = await admin.graphql(
    `#graphql
    query {
      paymentTermsTemplates {
        id
        name
        paymentTermsType
        dueInDays
        description
        translatedName
      }
    }`,
  );

  const paymentTermsData = await paymentTermsResponse.json();
  const paymentTermsTemplates = paymentTermsData.data.paymentTermsTemplates;

  return Response.json({
    submissions: submissions.map((submission) => ({
      ...submission,
      createdAt: submission.createdAt.toISOString(),
      // reviewedAt: submission.reviewedAt
      //   ? submission.reviewedAt.toISOString()
      //   : null,
    })),
    companies: companiesWithLocations.map((company) => ({
      ...company,
      creditLimit: company.creditLimit.toString(),
      updatedAt: company.updatedAt.toISOString(),
    })),
    paymentTermsTemplates,
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
// ── Assign shipping/billing address to company location ──
async function assignLocationAddresses(
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

function StepBadge({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    // <div
    //   onClick={onClick}
    //   style={{
    //     padding: "6px 14px",
    //     borderRadius: 20,
    //     cursor: "pointer",
    //     background: active ? "#1f2937" : "#e5e7eb",
    //     color: active ? "#ffffff" : "#111827",
    //     fontSize: 13,
    //     fontWeight: 500,
    //     userSelect: "none",
    //   }}
    // >
    //   {label}
    // </div>
    <div
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.();
        }
      }}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      style={{
        padding: "6px 14px",
        borderRadius: 20,
        cursor: "pointer",
        background: active ? "#1f2937" : "#e5e7eb",
        color: active ? "#ffffff" : "#111827",
        fontSize: 13,
        fontWeight: 500,
        userSelect: "none",
      }}
    >
      {label}
    </div>
  );
}

export default function RegistrationApprovals() {
  const { submissions, storeMissing, paymentTermsTemplates } = useLoaderData<{
    submissions: RegistrationSubmission[];
    companies: CompanyAccount[];
    storeMissing: boolean;
    paymentTermsTemplates: Array<{
      id: string;
      name: string;
      paymentTermsType: string;
      dueInDays: number | null;
    }>;
  }>();

  const [selected, setSelected] = useState<RegistrationSubmission | null>(null);
  const [step, setStep] = useState<
    | "check"
    | "createCustomer"
    | "updateCompany"
    | "createCompany"
    | "assign"
    | "email"
    | "complete"
  >("check");
  const [customer, setCustomer] = useState<ActionJson["customer"]>(null);
  const [company, setCompany] = useState<ActionJson["company"]>(null);
  const [reviewNotes, setReviewNotes] = useState("");
  const [showCustomerModal, setShowCustomerModal] = useState(false);
  const [showCompanyModal, setShowCompanyModal] = useState(false);
  const [editMode, setEditMode] = useState<"create" | "update">("create");
  const [customerMode, setCustomerMode] = useState<"create" | "update">(
    "create",
  );
  const [creditLimit, setCreditLimit] = useState(0);

  // ── Billing same as shipping toggle (used in createCustomer step) ──
  const [billSameAsShip, setBillSameAsShip] = useState(true);

  const [searchParams, setSearchParams] = useSearchParams();
  const statusFromUrl = searchParams.get("status");

  const normalizeStatus = (value: string | null) => {
    switch (value?.toUpperCase()) {
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

  const flowFetcher = useFetcher<ActionJson>();
  const rejectFetcher = useFetcher<ActionJson>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();

  const isFlowLoading = flowFetcher.state !== "idle";
  const isRejecting = rejectFetcher.state !== "idle";
  const currentIntent = flowFetcher.formData?.get("intent") as
    | string
    | undefined;
  const isCheckingCustomer = isFlowLoading && currentIntent === "checkCustomer";
  const isCreatingCustomer =
    isFlowLoading && currentIntent === "createCustomer";
  const isUpdatingCustomer =
    isFlowLoading && currentIntent === "updateCustomer";
  const isCheckingCompany = isFlowLoading && currentIntent === "checkCompany";
  const isCreatingCompany = isFlowLoading && currentIntent === "createCompany";
  const isUpdatingCompany = isFlowLoading && currentIntent === "updateCompany";
  const isAssigning = isFlowLoading && currentIntent === "assignMainContact";
  const isSendingEmail = isFlowLoading && currentIntent === "sendWelcomeEmail";
  const isCompletingApproval =
    isFlowLoading && currentIntent === "completeApproval";

  const checkRef = useRef<HTMLDivElement>(null);
  const createCustomerRef = useRef<HTMLDivElement>(null);
  const createCompanyRef = useRef<HTMLDivElement>(null);
  const assignRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLDivElement>(null);
  const completeRef = useRef<HTMLDivElement>(null);

  const goToStep = (
    stepName: StepName,
    ref: React.RefObject<HTMLDivElement>,
  ) => {
    setStep(stepName);
    requestAnimationFrame(() => {
      ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  const filteredSubmissions = useMemo(
    () => submissions.filter((s) => s.status === statusFilter),
    [submissions, statusFilter],
  );

  // ── When a submission is selected, pre-set billSameAsShip from stored data ──
  useEffect(() => {
    if (selected) {
      const storedSame = (selected as any)?.customFields?.billSameAsShip;
      setBillSameAsShip(storedSame === "false" ? false : true);
    }
  }, [selected]);

  useEffect(() => {
    if (!flowFetcher.data) return;

    if (
      flowFetcher.data.intent === "checkCustomer" &&
      flowFetcher.data.customer
    ) {
      setCustomer(flowFetcher.data.customer);
      return;
    }

    if (
      (flowFetcher.data.intent === "createCustomer" ||
        flowFetcher.data.intent === "updateCustomer") &&
      flowFetcher.data.success
    ) {
      setCustomer(flowFetcher.data.customer || null);
      setStep("createCompany");
      setShowCustomerModal(false);
      shopify.toast.show?.(
        flowFetcher.data.intent === "createCustomer" ? "Customer created" : "",
      );
      return;
    }

    if (flowFetcher.data.intent === "checkCompany") {
      setStep("createCompany");
      setCompany(flowFetcher.data.company ? flowFetcher.data.company : null);
      return;
    }

    if (
      (flowFetcher.data.intent === "createCompany" ||
        flowFetcher.data.intent === "updateCompany") &&
      flowFetcher.data.success
    ) {
      setCompany(flowFetcher.data.company || null);
      if (flowFetcher.data.intent === "createCompany") {
        setStep("assign");
        setEditMode("create");
      } else {
        setEditMode("create");
      }
      setShowCompanyModal(false);
      shopify.toast.show?.(
        flowFetcher.data.intent === "createCompany"
          ? "Company created successfully"
          : "Company updated successfully",
      );
      return;
    }

    if (flowFetcher.data.intent === "assignMainContact") {
      if (flowFetcher.data.success) {
        setStep("email");
        shopify.toast.show?.(
          (flowFetcher.data as any).wasAlreadyContact
            ? "Contact already existed — role and main contact updated successfully"
            : "Main contact assigned successfully",
        );
        revalidator.revalidate();
      }
      return;
    }

    if (
      flowFetcher.data.intent === "sendWelcomeEmail" &&
      flowFetcher.data.success
    ) {
      shopify.toast.show?.("Welcome email sent");
      return;
    }

    if (
      flowFetcher.data.intent === "completeApproval" &&
      flowFetcher.data.success
    ) {
      revalidator.revalidate();
      shopify.toast.show?.("Registration approved");
    }
  }, [flowFetcher, shopify, revalidator]);

  useEffect(() => {
    if (rejectFetcher.data?.success) {
      setSelected(null);
      revalidator.revalidate();
      shopify.toast.show?.("Registration rejected");
    }
  }, [rejectFetcher.data, revalidator, shopify]);

  const startApproval = (submission: RegistrationSubmission) => {
    setSelected(submission);
    setCustomer(null);
    setCompany(null);
    setStep("check");
    flowFetcher.submit(
      { intent: "checkCustomer", email: submission.email },
      { method: "post" },
    );
  };

  const completeApproval = () => {
    if (!selected || !customer) return;
    flowFetcher.submit(
      {
        intent: "completeApproval",
        registrationId: selected.id,
        customerId: customer.id,
        companyId: company?.id || "",
        companyName: company?.name || selected.companyName,
        contactName: `${customer.firstName} ${customer.lastName}`,
        contactEmail: customer.email,
        paymentTerm: selected.paymentTerm || "",
        creditLimit: selected.creditLimit || "",
        reviewNotes,
      },
      { method: "post" },
    );
  };

  const rejectSubmission = (submission: RegistrationSubmission) => {
    const confirmReject = window.confirm(
      `Reject registration for ${submission.companyName}?`,
    );
    if (!confirmReject) return;
    rejectFetcher.submit(
      { intent: "reject", registrationId: submission.id },
      { method: "post" },
    );
  };

  const contactNameParts = useMemo(() => {
    if (!selected?.contactName) return { firstName: "", lastName: "" };
    const [first, ...rest] = selected.contactName.split(" ");
    return { firstName: first, lastName: rest.join(" ") };
  }, [selected]);

  // ── Helpers to read shipping/billing/customFields from selected ──────────
  const s = (selected as any)?.shipping as Record<string, string> | undefined;
  const b = (selected as any)?.billing as Record<string, string> | undefined;
  const cf = (selected as any)?.customFields as
    | Record<string, string>
    | undefined;

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

  // ── Shared field style ────────────────────────────────────────────────────
  const inputStyle: React.CSSProperties = {
    padding: 10,
    borderRadius: 8,
    border: "1px solid #c9ccd0",
    width: "100%",
    boxSizing: "border-box",
  };
  const labelStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  };
  const labelTextStyle: React.CSSProperties = {
    fontSize: 12,
    color: "#5c5f62",
    fontWeight: 500,
  };
  const sectionHeadingStyle: React.CSSProperties = {
    fontSize: 13,
    fontWeight: 600,
    color: "#374151",
    margin: "16px 0 8px 0",
    paddingBottom: 4,
    borderBottom: "1px solid #e3e3e3",
  };

  // ── Reusable: address field grid ─────────────────────────────────────────
  const AddressFields = ({
    prefix,
    values,
    disabled = false,
  }: {
    prefix: "ship" | "bill";
    values?: Record<string, string>;
    disabled?: boolean;
  }) => (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 10,
        opacity: disabled ? 0.5 : 1,
        pointerEvents: disabled ? "none" : "auto",
      }}
    >
      {[
        { label: "Department", name: "Dept", col: "1 / -1" },
        { label: "First name", name: "FirstName" },
        { label: "Last name", name: "LastName" },
        { label: "Phone", name: "Phone" },
        { label: "Address line 1", name: "Addr1", col: "1 / -1" },
        { label: "Address line 2", name: "Addr2", col: "1 / -1" },
        { label: "City", name: "City" },
        { label: "State / Province", name: "State" },
        { label: "ZIP / Postal code", name: "Zip" },
        { label: "Country code", name: "Country" },
      ].map(({ label, name, col }) => (
        <label key={name} style={{ ...labelStyle, gridColumn: col as any }}>
          <span style={labelTextStyle}>{label}</span>
          <input
            name={`${prefix}${name}`}
            defaultValue={values?.[name] ?? ""}
            style={inputStyle}
          />
        </label>
      ))}
    </div>
  );

  // ── Reusable: full customer form body ─────────────────────────────────────
  // Used in BOTH create and update paths so fields stay consistent.
  const CustomerFormFields = ({
    prefillEmail,
    prefillFirstName,
    prefillLastName,
    prefillPhone,
    prefillContactTitle,
    prefillTaxId,
    shipValues,
    billValues,
  }: {
    prefillEmail?: string;
    prefillFirstName?: string;
    prefillLastName?: string;
    prefillPhone?: string;
    prefillContactTitle?: string;
    prefillTaxId?: string;
    shipValues?: Record<string, string>;
    billValues?: Record<string, string>;
  }) => (
    <>
      {/* ── Core fields ── */}
      <p style={sectionHeadingStyle}>Contact information</p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <label style={{ ...labelStyle, gridColumn: "1 / -1" }}>
          <span style={labelTextStyle}>Email *</span>
          <input
            name="email"
            type="email"
            required
            defaultValue={prefillEmail ?? ""}
            style={inputStyle}
          />
        </label>
        <label style={labelStyle}>
          <span style={labelTextStyle}>First name *</span>
          <input
            name="firstName"
            required
            defaultValue={prefillFirstName ?? ""}
            style={inputStyle}
          />
        </label>
        <label style={labelStyle}>
          <span style={labelTextStyle}>Last name</span>
          <input
            name="lastName"
            defaultValue={prefillLastName ?? ""}
            style={inputStyle}
          />
        </label>
        <label style={labelStyle}>
          <span style={labelTextStyle}>Phone</span>
          <input
            name="phone"
            defaultValue={prefillPhone ?? ""}
            style={inputStyle}
          />
        </label>
        <label style={labelStyle}>
          <span style={labelTextStyle}>Contact title</span>
          <input
            name="contactTitle"
            defaultValue={prefillContactTitle ?? ""}
            style={inputStyle}
          />
        </label>
        <label style={{ ...labelStyle, gridColumn: "1 / -1" }}>
          <span style={labelTextStyle}>Tax ID</span>
          <input
            name="taxId"
            defaultValue={prefillTaxId ?? ""}
            style={inputStyle}
          />
        </label>
      </div>

      {/* ── Shipping address ── */}
      <p style={sectionHeadingStyle}>Shipping address</p>
      <AddressFields prefix="ship" values={shipValues} />

      {/* ── Billing address ── */}
      <p style={sectionHeadingStyle}>Billing address</p>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 10,
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          name="billSameAsShip"
          checked={billSameAsShip}
          value="true"
          onChange={(e) => setBillSameAsShip(e.target.checked)}
        />
        <span style={{ fontSize: 13, color: "#374151" }}>
          Billing address same as shipping
        </span>
      </label>

      <AddressFields
        prefix="bill"
        values={billSameAsShip ? shipValues : billValues}
        disabled={billSameAsShip}
      />
    </>
  );

  return (
    <s-page heading="Registration submissions">
      {/* Status Filter Tabs */}
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
                {filteredSubmissions.map((submission) => {
                  const isThisRowLoading =
                    (isFlowLoading || isRejecting) &&
                    selected?.id === submission.id;
                  return (
                    <tr
                      key={submission.id}
                      style={{ borderTop: "1px solid #e3e3e3" }}
                    >
                      <td style={{ padding: "8px" }}>
                        {submission.companyName}
                      </td>
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
                                {...(isRejecting &&
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
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </s-section>

      {/* ── Customer Create/Update Modal ─────────────────────────────────── */}
      {showCustomerModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(17, 24, 39, 0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
          }}
        >
          <div
            style={{
              width: "min(700px, 90vw)",
              background: "white",
              borderRadius: 12,
              boxShadow: "0 12px 40px rgba(0,0,0,0.12)",
              maxHeight: "90vh",
              overflowY: "auto",
            }}
          >
            <div
              style={{
                padding: "18px 24px",
                borderBottom: "1px solid #e3e3e3",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <h3 style={{ margin: 0 }}>
                {editMode === "create" ? "Create Customer" : "Update Customer"}
              </h3>
              <s-button
                variant="tertiary"
                onClick={() => setShowCustomerModal(false)}
                disabled={isCreatingCustomer || isUpdatingCustomer}
              >
                Close
              </s-button>
            </div>
            <div style={{ padding: "18px 24px" }}>
              <form
                style={{ display: "grid", gap: 4 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget);
                  data.append(
                    "intent",
                    editMode === "create" ? "createCustomer" : "updateCustomer",
                  );
                  if (editMode === "update" && customer?.id) {
                    data.append("customerId", customer.id);
                  }
                  flowFetcher.submit(data, { method: "post" });
                }}
              >
                <CustomerFormFields
                  prefillEmail={customer?.email || selected?.email || ""}
                  prefillFirstName={
                    customer?.firstName || contactNameParts.firstName || ""
                  }
                  prefillLastName={
                    customer?.lastName || contactNameParts.lastName || ""
                  }
                  prefillPhone={customer?.phone || s?.Phone || ""}
                  prefillContactTitle={
                    (selected as any)?.contactTitle || cf?.contactTitle || ""
                  }
                  prefillTaxId={cf?.taxId || ""}
                  shipValues={s}
                  billValues={b}
                />
                <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                  <s-button
                    type="submit"
                    {...(isCreatingCustomer || isUpdatingCustomer
                      ? { loading: true }
                      : {})}
                  >
                    {editMode === "create"
                      ? "Create Customer"
                      : "Update Customer"}
                  </s-button>
                  <s-button
                    variant="tertiary"
                    onClick={() => setShowCustomerModal(false)}
                    disabled={isCreatingCustomer || isUpdatingCustomer}
                  >
                    Cancel
                  </s-button>
                </div>
              </form>
              {flowFetcher.data?.errors &&
                flowFetcher.data.errors.length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <s-banner tone="critical">
                      <s-unordered-list>
                        {flowFetcher.data.errors.map((err) => (
                          <s-list-item key={err}>{err}</s-list-item>
                        ))}
                      </s-unordered-list>
                    </s-banner>
                  </div>
                )}
            </div>
          </div>
        </div>
      )}

      {/* Company Create/Update Modal */}
      {showCompanyModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(17, 24, 39, 0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
          }}
        >
          <div
            style={{
              width: "min(700px, 90vw)",
              background: "white",
              borderRadius: 12,
              boxShadow: "0 12px 40px rgba(0,0,0,0.12)",
              maxHeight: "90vh",
              overflowY: "auto",
            }}
          >
            <div
              style={{
                padding: "18px 24px",
                borderBottom: "1px solid #e3e3e3",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <h3 style={{ margin: 0 }}>
                {editMode === "create" ? "Create Company" : "Update Company"}
              </h3>
              <s-button
                variant="tertiary"
                onClick={() => setShowCompanyModal(false)}
                disabled={isCreatingCompany || isUpdatingCompany}
              >
                Close
              </s-button>
            </div>
            <div style={{ padding: "18px 24px" }}>
              <form
                style={{ display: "grid", gap: 12 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget);
                  data.append(
                    "intent",
                    editMode === "create" ? "createCompany" : "updateCompany",
                  );
                  data.append("customerId", customer?.id || "");
                  data.append(
                    "customerEmail",
                    customer?.email || selected?.email || "",
                  );
                  if (editMode === "update") {
                    data.append("companyId", company?.id || "");
                    data.append("locationId", company?.locationId || "");
                  }
                  flowFetcher.submit(data, { method: "post" });
                }}
              >
                <label style={labelStyle}>
                  <span style={labelTextStyle}>Company name *</span>
                  <input
                    name="companyName"
                    defaultValue={company?.name || selected?.companyName || ""}
                    required
                    disabled={editMode === "update"}
                    style={{
                      ...inputStyle,
                      backgroundColor:
                        editMode === "update" ? "#f3f4f6" : "white",
                    }}
                  />
                </label>
                {editMode === "create" && (
                  <label style={labelStyle}>
                    <span style={labelTextStyle}>Payment terms</span>
                    <select
                      name="paymentTerms"
                      defaultValue={(selected as any)?.paymentTerm}
                      style={{ ...inputStyle, backgroundColor: "white" }}
                    >
                      <option value="">No payment terms</option>
                      {paymentTermsTemplates?.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label style={labelStyle}>
                  <span style={labelTextStyle}>Credit limit</span>
                  <input
                    name="creditLimit"
                    defaultValue={company?.creditLimit ?? ""}
                    required
                    style={inputStyle}
                  />
                </label>
                <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                  <s-button
                    type="submit"
                    {...(isCreatingCompany || isUpdatingCompany
                      ? { loading: true }
                      : {})}
                  >
                    {editMode === "create"
                      ? "Create Company"
                      : "Update Company"}
                  </s-button>
                  <s-button
                    variant="tertiary"
                    onClick={() => setShowCompanyModal(false)}
                    disabled={isCreatingCompany || isUpdatingCompany}
                  >
                    Cancel
                  </s-button>
                </div>
              </form>
              {flowFetcher.data?.errors &&
                flowFetcher.data.errors.length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <s-banner tone="critical">
                      <s-unordered-list>
                        {flowFetcher.data.errors.map((err) => (
                          <s-list-item key={err}>{err}</s-list-item>
                        ))}
                      </s-unordered-list>
                    </s-banner>
                  </div>
                )}
            </div>
          </div>
        </div>
      )}

      {/* ── Main Approval Flow Modal ───────────────────────────────────────── */}
      {selected && (
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
              width: "min(860px, 92vw)",
              background: "white",
              borderRadius: 12,
              boxShadow: "0 12px 40px rgba(0,0,0,0.12)",
              maxHeight: "90vh",
              overflowY: "auto",
            }}
          >
            {/* Modal header */}
            <div
              style={{
                padding: "18px 24px",
                borderBottom: "1px solid #e3e3e3",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div>
                <h3 style={{ margin: 0 }}>
                  Approve {company?.name || selected?.companyName}
                </h3>
                <p style={{ margin: "4px 0", color: "#5c5f62" }}>
                  {customer
                    ? `${customer.firstName || ""} ${customer.lastName || ""}`.trim()
                    : `${selected?.firstName || ""} ${selected?.lastName || ""}`.trim()}{" "}
                  • {customer?.email || selected?.email}
                </p>
              </div>
              <s-button
                variant="tertiary"
                onClick={() => setSelected(null)}
                disabled={isFlowLoading}
              >
                Close
              </s-button>
            </div>

            <div style={{ padding: "18px 24px" }}>
              {/* Step indicator */}
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  marginBottom: 24,
                  flexWrap: "wrap",
                }}
              >
                <StepBadge
                  label="1. Check customer"
                  active={step === "check"}
                  onClick={() => goToStep("check", checkRef)}
                />
                <StepBadge
                  label="2. Create company"
                  active={step === "createCompany"}
                  onClick={() => goToStep("createCompany", createCompanyRef)}
                />
                <StepBadge
                  label="3. Assign contact"
                  active={step === "assign"}
                  onClick={() => goToStep("assign", assignRef)}
                />
                <StepBadge
                  label="4. Welcome email"
                  active={step === "email"}
                  onClick={() => goToStep("email", emailRef)}
                />
                <StepBadge
                  label="5. Complete"
                  active={step === "complete"}
                  onClick={() => goToStep("complete", completeRef)}
                />
              </div>

              {/* ── STEP: Check Customer ──────────────────────────────────── */}
              {step === "check" && (
                <div
                  style={{
                    border: "1px solid #e3e3e3",
                    borderRadius: 12,
                    padding: 16,
                  }}
                >
                  <h4 style={{ margin: 0 }}>Check Customer</h4>
                  <p style={{ color: "#5c5f62", marginTop: 4 }}>
                    Checking if a customer already exists with email:{" "}
                    {selected.email}
                  </p>

                  {isCheckingCustomer ? (
                    <s-banner tone="info">
                      <s-text>
                        Please wait while we search for existing customer.
                      </s-text>
                    </s-banner>
                  ) : customer ? (
                    <>
                      <s-banner tone="success">
                        <div style={{ fontWeight: 600, marginBottom: 4 }}>
                          Customer found
                        </div>
                        <s-text>
                          {customer.firstName || ""} {customer.lastName || ""} ·{" "}
                          {customer.email}
                        </s-text>
                      </s-banner>
                      <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                        <s-button
                          onClick={() => {
                            setCustomerMode("update");
                            setStep("createCustomer");
                          }}
                        >
                          Update Customer
                        </s-button>
                        <s-button onClick={() => setStep("createCompany")}>
                          Continue
                        </s-button>
                      </div>
                    </>
                  ) : (
                    <>
                      <s-banner tone="warning">
                        <div style={{ fontWeight: 600, marginBottom: 4 }}>
                          No customer found
                        </div>
                        <s-text>
                          No existing customer found. You will need to create
                          one.
                        </s-text>
                      </s-banner>
                      <div style={{ marginTop: 12 }}>
                        <s-button onClick={() => setStep("createCustomer")}>
                          Create New Customer
                        </s-button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* ── STEP: Create / Update Customer ───────────────────────── */}
              {step === "createCustomer" && (
                <div
                  style={{
                    border: "1px solid #e3e3e3",
                    borderRadius: 12,
                    padding: 16,
                  }}
                  ref={createCustomerRef}
                >
                  <h4 style={{ marginTop: 0 }}>
                    {customer ? "Update Customer" : "Create Customer"}
                  </h4>
                  <p style={{ color: "#5c5f62", marginTop: 4 }}>
                    {customer
                      ? "Review and update the customer's details including address information."
                      : "Fill in the customer details and address information below."}
                  </p>

                  {customer && (
                    <div style={{ marginBottom: 12 }}>
                      <s-banner tone="info">
                        <s-text>
                          {customer.firstName} {customer.lastName} ·{" "}
                          {customer.email}
                        </s-text>
                      </s-banner>
                    </div>
                  )}

                  <form
                    style={{ display: "grid", gap: 4 }}
                    onSubmit={(e) => {
                      e.preventDefault();
                      const data = new FormData(e.currentTarget);

                      if (customer) {
                        // ── UPDATE path ──
                        data.append("intent", "updateCustomer");
                        data.append("customerId", customer.id || "");
                        data.append(
                          "customerEmail",
                          customer.email || selected?.email || "",
                        );
                      } else {
                        // ── CREATE path ──
                        data.append("intent", "createCustomer");
                      }

                      flowFetcher.submit(data, { method: "post" });
                    }}
                  >
                    <CustomerFormFields
                      prefillEmail={customer?.email ?? selected.email}
                      prefillFirstName={
                        customer?.firstName ?? selected.firstName
                      }
                      prefillLastName={
                        customer?.lastName ?? selected.lastName
                      }
                      prefillPhone={customer?.phone ?? s?.Phone ?? ""}
                      prefillContactTitle={
                        (selected as any)?.contactTitle ??
                        cf?.contactTitle ??
                        ""
                      }
                      prefillTaxId={cf?.taxId ?? ""}
                      shipValues={s}
                      billValues={b}
                    />

                    <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                      <s-button
                        type="submit"
                        {...(isCreatingCustomer || isUpdatingCustomer
                          ? { loading: true }
                          : {})}
                      >
                        {customer ? "Update Customer" : "Create Customer"}
                      </s-button>
                      <s-button
                        variant="tertiary"
                        onClick={() => setStep("check")}
                        disabled={isCreatingCustomer || isUpdatingCustomer}
                      >
                        Back
                      </s-button>
                    </div>
                  </form>

                  {flowFetcher.data?.errors &&
                    flowFetcher.data.errors.length > 0 && (
                      <div style={{ marginTop: 16 }}>
                        <s-banner tone="critical">
                          <s-unordered-list>
                            {flowFetcher.data.errors.map((err) => (
                              <s-list-item key={err}>{err}</s-list-item>
                            ))}
                          </s-unordered-list>
                        </s-banner>
                      </div>
                    )}
                </div>
              )}

              {/* ── STEP: Create Company ──────────────────────────────────── */}
              {step === "createCompany" && (
                <div
                  style={{
                    border: "1px solid #e3e3e3",
                    borderRadius: 12,
                    padding: 16,
                  }}
                  ref={createCompanyRef}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: 8,
                    }}
                  >
                    <h4 style={{ margin: 0 }}>Create Company & Location</h4>
                    {company && editMode !== "update" && (
                      <s-button
                        variant="secondary"
                        onClick={() => setEditMode("update")}
                      >
                        Update Company
                      </s-button>
                    )}
                  </div>
                  <p style={{ color: "#5c5f62", marginTop: 4 }}>
                    Create the company record and main location.
                  </p>

                  {company ? (
                    <>
                      <s-banner tone="success">
                        <s-text>
                          {company.name} ·{" "}
                          {company.locationName || "Main location"}
                        </s-text>
                      </s-banner>

                      {editMode !== "update" && (
                        <div
                          style={{ marginTop: 12, display: "flex", gap: 10 }}
                        >
                          <s-button onClick={() => setStep("assign")}>
                            Continue
                          </s-button>
                          <s-button
                            variant="secondary"
                            onClick={() =>
                              setStep(customer ? "check" : "createCustomer")
                            }
                          >
                            Back
                          </s-button>
                        </div>
                      )}

                      {editMode === "update" && (
                        <form
                          style={{
                            display: "grid",
                            gap: 12,
                            marginTop: 16,
                            padding: 16,
                            background: "#f9fafb",
                            borderRadius: 8,
                            border: "1px solid #e3e3e3",
                          }}
                          onSubmit={(e) => {
                            e.preventDefault();
                            const data = new FormData(e.currentTarget);
                            data.append("intent", "updateCompany");
                            data.append("companyId", company?.id || "");
                            data.append(
                              "locationId",
                              company?.locationId || "",
                            );
                            data.append(
                              "customerEmail",
                              customer?.email || selected?.email || "",
                            );
                            flowFetcher.submit(data, { method: "post" });
                          }}
                        >
                          <h5 style={{ margin: "0 0 8px 0" }}>
                            Edit Company Details
                          </h5>
                          <label style={labelStyle}>
                            <span style={labelTextStyle}>Company name</span>
                            <input
                              name="companyName"
                              defaultValue={company?.name || ""}
                              required
                              style={inputStyle}
                            />
                          </label>
                          <label style={labelStyle}>
                            <span style={labelTextStyle}>Payment terms</span>
                            <select
                              name="paymentTerms"
                              defaultValue={
                                company?.paymentTermsTemplateId || ""
                              }
                              style={{
                                ...inputStyle,
                                backgroundColor: "white",
                              }}
                            >
                              <option value="">No payment terms</option>
                              {paymentTermsTemplates?.map((t) => (
                                <option key={t.id} value={t.id}>
                                  {t.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          <div
                            style={{ display: "flex", gap: 10, marginTop: 8 }}
                          >
                            <s-button
                              type="submit"
                              {...(isUpdatingCompany ? { loading: true } : {})}
                            >
                              Update Company
                            </s-button>
                            <s-button
                              variant="tertiary"
                              type="button"
                              onClick={() => setEditMode("create")}
                              disabled={isUpdatingCompany}
                            >
                              Cancel
                            </s-button>
                          </div>
                        </form>
                      )}
                    </>
                  ) : (
                    <form
                      style={{ display: "grid", gap: 12, marginTop: 12 }}
                      onSubmit={(e) => {
                        e.preventDefault();
                        const data = new FormData(e.currentTarget);
                        data.append("intent", "createCompany");
                        data.append("customerId", customer?.id || "");
                        data.append(
                          "customerEmail",
                          customer?.email || selected?.email || "",
                        );
                        flowFetcher.submit(data, { method: "post" });
                      }}
                    >
                      <label style={labelStyle}>
                        <span style={labelTextStyle}>Company name *</span>
                        <input
                          name="companyName"
                          defaultValue={selected.companyName}
                          required
                          style={inputStyle}
                        />
                      </label>
                      <label style={labelStyle}>
                        <span style={labelTextStyle}>Payment terms</span>
                        <select
                          name="paymentTerms"
                          defaultValue={
                            (selected as any).paymentTermsTemplateId
                          }
                          style={{ ...inputStyle, backgroundColor: "white" }}
                        >
                          <option value="">No payment terms</option>
                          {paymentTermsTemplates?.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div>
                        <span
                          style={{
                            ...labelTextStyle,
                            marginBottom: 4,
                            display: "block",
                          }}
                        >
                          Credit limit
                        </span>
                        <input
                          name="creditLimit"
                          type="number"
                          defaultValue={(selected as any).creditLimit}
                          onChange={(e) =>
                            setCreditLimit(Number(e.target.value) || 0)
                          }
                          required
                          style={{ ...inputStyle, width: 120 }}
                        />
                      </div>
                      <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                        <s-button
                          type="submit"
                          {...(isCreatingCompany ? { loading: true } : {})}
                        >
                          Create Company
                        </s-button>
                        <s-button
                          variant="tertiary"
                          onClick={() =>
                            setStep(customer ? "check" : "createCustomer")
                          }
                          disabled={isCreatingCompany}
                        >
                          Back
                        </s-button>
                      </div>
                    </form>
                  )}
                </div>
              )}

              {/* ── STEP: Assign ─────────────────────────────────────────── */}
              {step === "assign" && (
                <div
                  style={{
                    border: "1px solid #e3e3e3",
                    borderRadius: 12,
                    padding: 16,
                  }}
                  ref={assignRef}
                >
                  <h4 style={{ marginTop: 0 }}>Assign Main Contact</h4>
                  <p style={{ color: "#5c5f62", marginTop: 4 }}>
                    Assign the customer as the main contact for this company.
                  </p>
                  <div style={{ marginTop: 12 }}>
                    <s-banner tone="info">
                      <s-text>
                        Customer: {customer?.firstName} {customer?.lastName}  {selected?.firstName} {selected?.lastName} (
                        {customer?.email})
                        <br />
                        Company: {company?.name || selected?.companyName}
                      </s-text>
                    </s-banner>
                  </div>
                  <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                    <s-button
                      onClick={() => {
                        const companyIdToSend = company?.id || "";
                        const customerIdToSend = customer?.id || "";
                        const locationIdToSend = company?.locationId || "";
                        if (
                          !companyIdToSend ||
                          !customerIdToSend ||
                          !locationIdToSend
                        ) {
                          shopify.toast.show?.(
                            "Company, customer, and location are required",
                          );
                          return;
                        }
                        flowFetcher.submit(
                          {
                            intent: "assignMainContact",
                            companyId: companyIdToSend,
                            customerId: customerIdToSend,
                            locationId: locationIdToSend,
                            customerFirstName: customer?.firstName || "",
                            customerLastName: customer?.lastName || "",
                            customerEmail: customer?.email || "",
                          },
                          { method: "post" },
                        );
                      }}
                      {...(isAssigning ? { loading: true } : {})}
                    >
                      Assign Main Contact
                    </s-button>
                    <s-button
                      variant="tertiary"
                      onClick={() => setStep("createCompany")}
                      disabled={isAssigning}
                    >
                      Back
                    </s-button>
                  </div>
                </div>
              )}

              {/* ── STEP: Welcome Email ───────────────────────────────────── */}
              {step === "email" && (
                <div
                  style={{
                    border: "1px solid #e3e3e3",
                    borderRadius: 12,
                    padding: 16,
                  }}
                  ref={emailRef}
                >
                  <h4 style={{ marginTop: 0 }}>Send Welcome Email</h4>
                  <p style={{ color: "#5c5f62", marginTop: 4 }}>
                    Send a welcome email to notify the customer.
                  </p>
                  <div style={{ marginTop: 12 }}>
                    <s-banner tone="info">
                      <s-text>
                        To: {customer?.email || selected.email}
                        <br />
                        Contact: {customer?.firstName || selected.firstName} {customer?.lastName || selected.lastName}
                        <br />
                        Company: {company?.name || selected?.companyName}
                      </s-text>
                    </s-banner>
                  </div>

                  {flowFetcher.data?.intent === "sendWelcomeEmail" &&
                    flowFetcher.data?.success && (
                      <div style={{ marginTop: 12 }}>
                        <s-banner tone="success">
                          <div style={{ fontWeight: 600, marginBottom: 4 }}>
                            ✓ Welcome email sent successfully
                          </div>
                          <s-text>
                            Email delivered to{" "}
                            {customer?.email || selected.email}. Click "Next:
                            Complete Approval" when ready.
                          </s-text>
                        </s-banner>
                      </div>
                    )}

                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      marginTop: 16,
                      flexWrap: "wrap",
                    }}
                  >
                    {!(
                      flowFetcher.data?.intent === "sendWelcomeEmail" &&
                      flowFetcher.data?.success
                    ) && (
                      <s-button
                        onClick={() =>
                          flowFetcher.submit(
                            {
                              intent: "sendWelcomeEmail",
                              email: customer?.email || selected.email,
                              companyName:
                                company?.name || selected.companyName,
                              reviewNotes,
                            },
                            { method: "post" },
                          )
                        }
                        {...(isSendingEmail ? { loading: true } : {})}
                      >
                        Send Welcome Email
                      </s-button>
                    )}

                    {flowFetcher.data?.intent === "sendWelcomeEmail" &&
                      flowFetcher.data?.success && (
                        <s-button
                          variant="primary"
                          onClick={() => setStep("complete")}
                        >
                          Next: Complete Approval →
                        </s-button>
                      )}

                    <s-button
                      variant="tertiary"
                      onClick={() => setStep("assign")}
                      disabled={isSendingEmail}
                    >
                      Back
                    </s-button>
                    <s-button
                      variant="tertiary"
                      onClick={() => setStep("complete")}
                      disabled={isSendingEmail}
                    >
                      Skip Email
                    </s-button>
                  </div>
                </div>
              )}

              {/* ── STEP: Complete ────────────────────────────────────────── */}
              {step === "complete" && (
                <div
                  style={{
                    border: "1px solid #e3e3e3",
                    borderRadius: 12,
                    padding: 16,
                  }}
                  ref={completeRef}
                >
                  <h4 style={{ marginTop: 0 }}>Complete Approval</h4>

                  <div
                    style={{
                      background: "#f9fafb",
                      border: "1px solid #e3e3e3",
                      borderRadius: 8,
                      padding: 16,
                      marginBottom: 16,
                    }}
                  >
                    <strong>Approval Summary:</strong>
                    <div
                      style={{ marginTop: 8, fontSize: 14, color: "#5c5f62" }}
                    >
                      <div>Email: {customer?.email}</div>
                      <div>
                        Company: {company?.name || selected?.companyName}
                      </div>
                      {reviewNotes && (
                        <div style={{ marginTop: 8 }}>
                          <strong>Review Notes:</strong>
                          <div
                            style={{
                              marginTop: 4,
                              padding: 8,
                              background: "white",
                              borderRadius: 4,
                              whiteSpace: "pre-wrap",
                            }}
                          >
                            {reviewNotes}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {flowFetcher.data?.intent === "completeApproval" &&
                  flowFetcher.data?.success ? (
                    <>
                      <s-banner tone="success">
                        <div
                          style={{
                            fontWeight: 700,
                            marginBottom: 6,
                            fontSize: 15,
                          }}
                        >
                          ✓ Registration Approved Successfully
                        </div>
                        <s-text>
                          {customer?.firstName} {customer?.lastName} has been
                          approved and their account is now active under{" "}
                          <strong>
                            {company?.name || selected?.companyName}
                          </strong>
                          .
                        </s-text>
                      </s-banner>
                      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                        <s-button
                          variant="primary"
                          onClick={() => {
                            setSelected(null);
                            setCustomer(null);
                            setCompany(null);
                            setStep("check");
                            setReviewNotes("");
                            setEditMode("create");
                          }}
                        >
                          Done — Close
                        </s-button>
                      </div>
                    </>
                  ) : (
                    <>
                      <s-banner tone="success">
                        <strong>Ready to approve</strong>
                        <div style={{ marginTop: 4 }}>
                          This will mark the registration as approved and
                          activate the customer account.
                        </div>
                      </s-banner>
                      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                        <s-button
                          variant="primary"
                          onClick={completeApproval}
                          {...(isCompletingApproval ? { loading: true } : {})}
                        >
                          Confirm & Approve
                        </s-button>
                        <s-button
                          variant="tertiary"
                          onClick={() => setStep("email")}
                          disabled={isCompletingApproval}
                        >
                          Back
                        </s-button>
                        <s-button
                          variant="tertiary"
                          onClick={() => setSelected(null)}
                          disabled={isCompletingApproval}
                        >
                          Cancel
                        </s-button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* ── Error Display ─────────────────────────────────────────── */}
              {flowFetcher.data?.errors &&
                flowFetcher.data.errors.length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <s-banner tone="critical">
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>
                        Something went wrong
                      </div>
                      <s-unordered-list>
                        {flowFetcher.data.errors.map((err) => (
                          <s-list-item key={err}>{err}</s-list-item>
                        ))}
                      </s-unordered-list>
                    </s-banner>
                  </div>
                )}
            </div>
          </div>
        </div>
      )}
    </s-page>
  );
}
export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
