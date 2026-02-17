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
  contactName: string;
  creditLimit: string;
  email: string;
  phone: string;
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
      reviewedAt: submission.reviewedAt
        ? submission.reviewedAt.toISOString()
        : null,
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

        const [customerResponse, registration] = await Promise.all([
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
        ]);

        const customerPayload = await customerResponse.json();
        const customer = customerPayload?.data?.customers?.nodes?.[0] || null;

        console.log("✅ Customer check completed:", {
          exists: !!customer,
          hasRegistration: !!registration,
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

        if (!email || !firstName) {
          return Response.json({
            intent,
            success: false,
            errors: ["First name and email are required"],
          });
        }

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
    }
  `,
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

        if (!registrationData && customer) {
          await prisma.registrationSubmission.create({
            data: {
              contactName: `${firstName} ${lastName || ""}`.trim(),
              email,
              phone: phone || "",
              shopifyCustomerId: customer?.id || null,
              status: "PENDING",
              companyName: "",
              businessType: "",
              shopId: store.id,
            },
          });
        } else {
          await prisma.registrationSubmission.update({
            where: { id: registrationData?.id || "" },
            data: {
              contactName: `${firstName} ${lastName || ""}`.trim(),
              email,
              shopifyCustomerId: customer?.id || null,
              phone: phone || "",
              status: "PENDING",
              companyName: "",
              businessType: "",
            },
          });
        }

        const userData = await prisma.user.findFirst({
          where: {
            shopifyCustomerId: customer?.id || null,
            email,
          },
        });

        if (!userData && customer) {
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
            where: {
              id: userData?.id || "",
            },
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

        if (!customerId) {
          return Response.json({
            intent,
            success: false,
            errors: ["Customer ID is required"],
          });
        }

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
          }
        `,
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
        const registrationData = await prisma.registrationSubmission.findFirst({
          where: { shopifyCustomerId: customerId },
        });

        if (registrationData && customer) {
          await prisma.registrationSubmission.update({
            where: { id: registrationData.id },
            data: {
              contactName: `${firstName} ${lastName || ""}`.trim(),
              email,
              phone: phone || "",
              status: "PENDING",
              shopifyCustomerId: customerId || null,
            },
          });
        }
        const userData = await prisma.user.findFirst({
          where: {
            shopifyCustomerId: customerId,
          },
        });
        if (userData) {
          await prisma.user.update({
            where: { id: userData.id },
            data: {
              email,
              firstName,
              lastName: lastName || "",
              shopifyCustomerId: customerId || null,
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
          customer: payload?.data?.customerUpdate?.customer,
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

        if (!companyName) {
          return Response.json({
            intent,
            success: false,
            errors: ["Company name is required"],
          });
        }

        // ✅ CHECK: Does company already exist in Shopify?
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

        // ✅ CHECK: Does company already exist in local DB?
        const existingLocalCompany = await prisma.companyAccount.findFirst({
          where: { name: companyName, shopId: store.id },
        });

        let companyId: string;
        let locationId: string;
        let locationName: string;

        if (existingShopifyCompany) {
          // ── COMPANY EXISTS IN SHOPIFY → UPDATE instead of error ──
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

          // Update metafield and payment terms in parallel
          await Promise.all([
            creditLimit
              ? updateCompanyMetafield(admin, companyId, {
                  namespace: "b2b_credit",
                  key: "credit_limit",
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

          // Fetch location + update payment terms/metafield in parallel
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
                  namespace: "b2b_credit",
                  key: "credit_limit",
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

          // Update payment terms on the new location
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
        }

        // ── UPSERT company in local DB (handles both create & update) ──
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
        ]);

        // Update registration and user in parallel
        await Promise.all([
          customerEmail
            ? prisma.registrationSubmission.upsert({
                where: {
                  shopId_email: { shopId: store.id, email: customerEmail },
                },
                update: { companyName },
                create: {
                  email: customerEmail,
                  companyName,
                  contactName: "",
                  phone: "",
                  shopifyCustomerId: null,
                  status: "PENDING",
                  businessType: "",
                  shopId: store.id,
                },
              })
            : Promise.resolve(),

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

        // ✅ Check for duplicate name (exclude current company)
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

        // 1️⃣ Update Company name in Shopify
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

        // 2️⃣ Parallel: fetch location + update DB + find user + update metafield
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
                namespace: "b2b_credit",
                key: "credit_limit",
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

        // 3️⃣ Update location name and payment terms
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

        // 4️⃣ Update registration + user in parallel
        await Promise.all([
          customerEmail
            ? prisma.registrationSubmission.upsert({
                where: {
                  shopId_email: { shopId: store.id, email: customerEmail },
                },
                update: { companyName },
                create: {
                  email: customerEmail,
                  companyName,
                  contactName: "",
                  phone: "",
                  shopifyCustomerId: null,
                  status: "PENDING",
                  businessType: "",
                  shopId: store.id,
                },
              })
            : Promise.resolve(),

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
        const customerFirstName = (form.customerFirstName as string)?.trim();
        const customerLastName = (form.customerLastName as string)?.trim();
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

        const contactName = `${customerFirstName} ${customerLastName}`.trim();

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
            firstName: customerFirstName || null,
            lastName: customerLastName || null,
            shopifyCustomerId: customerId,
            companyId: companyAccount.id,
            companyRole: "admin",
            role: "STORE_ADMIN",
            status: "APPROVED",
            shopId: store.id,
          },
          create: {
            email: customerEmail,
            firstName: customerFirstName || null,
            lastName: customerLastName || null,
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
        const contactName = (form.contactName as string)?.trim();
        const note = (form.reviewNotes as string)?.trim() || null;

        if (!email) {
          return Response.json({
            intent,
            success: false,
            errors: ["Email required"],
          });
        }

        await sendCompanyAssignmentEmail(
          store.shopName || "Shop Name",
          store.shopDomain || "shop-domain.myshopify.com",
          store.storeOwnerName || "Store Owner",
          email,
          companyName,
          contactName,
          note || "",
        );

        const registerData = await prisma.registrationSubmission.findFirst({
          where: { email },
        });
        if (registerData) {
          await prisma.registrationSubmission.update({
            where: { id: registerData.id },
            data: { reviewNotes: note },
          });
        }

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
            reviewedAt: new Date(),
            reviewedBy: session.id,
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
          data: {
            status: "REJECTED",
            reviewedAt: new Date(),
            reviewedBy: session.id,
            reviewNotes: note,
          },
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

  // ── Granular loading states ──────────────────────────────────────────────
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
  // ────────────────────────────────────────────────────────────────────────

  const goToStep = (
    stepName: StepName,
    ref: React.RefObject<HTMLDivElement>,
  ) => {
    setStep(stepName);
    requestAnimationFrame(() => {
      ref.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  };

  const filteredSubmissions = useMemo(() => {
    return submissions.filter((s) => s.status === statusFilter);
  }, [submissions, statusFilter]);

  useEffect(() => {
    if (!flowFetcher.data) return;

    if (
      flowFetcher.data.intent === "checkCustomer" &&
      flowFetcher.data.customer
    ) {
      setCustomer(flowFetcher.data.customer);
      // flowFetcher.submit(
      //   { intent: "checkCompany", companyName: selected?.companyName || "" },
      //   { method: "post" },
      // );
      return;
    }

    if (
      (flowFetcher.data.intent === "createCustomer" ||
        flowFetcher.data.intent === "updateCustomer") &&
      flowFetcher.data.success
    ) {
      setCustomer(flowFetcher.data.customer || null);
      // ✅ Both create AND update redirect to createCompany step
      setStep("createCompany");
      setShowCustomerModal(false);
      shopify.toast.show?.(
        flowFetcher.data.intent === "createCustomer" ? "Customer created" : "",
      );
      return;
    }

    if (flowFetcher.data.intent === "checkCompany") {
      setStep("createCompany");
      if (flowFetcher.data.company) {
        setCompany(flowFetcher.data.company);
      } else {
        setCompany(null);
      }
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
      // ✅ Show different toast if company already existed and was updated
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
      // On failure: do NOT call setStep — stay on "assign" so the error renders
      return;
    }

    if (
      flowFetcher.data.intent === "assignMainContact" &&
      !flowFetcher.data.success
    ) {
      shopify.toast.show?.(
        `Failed to assign contact: ${flowFetcher.data.errors?.[0] || "Unknown error"}`,
      );
      return;
    }

    if (
      flowFetcher.data.intent === "sendWelcomeEmail" &&
      flowFetcher.data.success
    ) {
      // ✅ NO auto-redirect — stay on email step, show success inline
      // User must click "Next: Complete Approval" manually
      shopify.toast.show?.("Welcome email sent");
      return;
    }

    if (
      flowFetcher.data.intent === "completeApproval" &&
      flowFetcher.data.success
    ) {
      // ✅ NO auto-close — stay on complete step, show success inline
      // User must click "Done" manually
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
                        {submission.contactName}
                      </td>
                      <td style={{ padding: "8px" }}>{submission.email}</td>
                      <td style={{ padding: "8px" }}>{submission.phone}</td>
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
              width: "min(600px, 90vw)",
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
                style={{ display: "grid", gap: 12 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  const formEl = e.currentTarget;
                  const data = new FormData(formEl);
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
                {[
                  {
                    label: "Email *",
                    name: "email",
                    type: "email",
                    required: true,
                    value: customer?.email || selected?.email || "",
                  },
                  {
                    label: "First name *",
                    name: "firstName",
                    required: true,
                    value:
                      customer?.firstName || contactNameParts.firstName || "",
                  },
                  {
                    label: "Last name",
                    name: "lastName",
                    value:
                      customer?.lastName || contactNameParts.lastName || "",
                  },
                  {
                    label: "Phone",
                    name: "phone",
                    value: customer?.phone || selected?.phone || "",
                  },
                ].map(({ label, name, type = "text", required, value }) => (
                  <label
                    key={name}
                    style={{ display: "flex", flexDirection: "column", gap: 4 }}
                  >
                    <span
                      style={{
                        fontSize: 12,
                        color: "#5c5f62",
                        fontWeight: 500,
                      }}
                    >
                      {label}
                    </span>
                    <input
                      name={name}
                      type={type}
                      defaultValue={value}
                      required={required}
                      style={{
                        padding: 10,
                        borderRadius: 8,
                        border: "1px solid #c9ccd0",
                      }}
                    />
                  </label>
                ))}
                <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
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
                  const formEl = e.currentTarget;
                  const data = new FormData(formEl);
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
                <label
                  style={{ display: "flex", flexDirection: "column", gap: 4 }}
                >
                  <span
                    style={{ fontSize: 12, color: "#5c5f62", fontWeight: 500 }}
                  >
                    Company name *
                  </span>
                  <input
                    name="companyName"
                    defaultValue={company?.name || selected?.companyName || ""}
                    required
                    disabled={editMode === "update"}
                    style={{
                      padding: 10,
                      borderRadius: 8,
                      border: "1px solid #c9ccd0",
                      backgroundColor:
                        editMode === "update" ? "#f3f4f6" : "white",
                    }}
                  />
                </label>

                {editMode === "create" && (
                  <label
                    style={{ display: "flex", flexDirection: "column", gap: 4 }}
                  >
                    <span
                      style={{
                        fontSize: 12,
                        color: "#5c5f62",
                        fontWeight: 500,
                      }}
                    >
                      Payment terms
                    </span>
                    <select
                      name="paymentTerms"
                      defaultValue={selected?.paymentTerm}
                      style={{
                        padding: 10,
                        borderRadius: 8,
                        border: "1px solid #c9ccd0",
                        backgroundColor: "white",
                      }}
                    >
                      <option value="">No payment terms</option>
                      {paymentTermsTemplates?.map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                <label
                  style={{ display: "flex", flexDirection: "column", gap: 4 }}
                >
                  <span
                    style={{ fontSize: 12, color: "#5c5f62", fontWeight: 500 }}
                  >
                    Credit limit
                  </span>
                  <input
                    name="creditLimit"
                    defaultValue={company?.creditLimit ?? ""}
                    required
                    style={{
                      padding: 10,
                      borderRadius: 8,
                      border: "1px solid #c9ccd0",
                    }}
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

      {/* Original Approval Flow Modal */}
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
              width: "min(800px, 90vw)",
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
              <div>
                <h3 style={{ margin: 0 }}>
                  Approve {company?.name || selected?.companyName}
                </h3>
                <p style={{ margin: "4px 0", color: "#5c5f62" }}>
                  {customer
                    ? `${customer.firstName || ""} ${customer.lastName || ""}`.trim()
                    : selected?.contactName}{" "}
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
              {/* Step Progress Indicator */}
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
              {/* Step: Check Customer */}
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

                      {/* ✅ Update button ONLY after customer found */}
                      <div
                        style={{
                          marginTop: 12,
                          display: "flex",
                          gap: 8,
                        }}
                      >
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

              {/* ── Step: Create / Update Customer ──────────────────────── */}
              {step === "createCustomer" && (
                <div>
                  {customer ? (
                    <>
                      <s-banner tone="info">
                        <div style={{ fontWeight: 600, marginBottom: 4 }}>
                          Customer exists
                        </div>
                        <s-text>
                          {customer.firstName} {customer.lastName} ·{" "}
                          {customer.email}
                        </s-text>
                      </s-banner>

                      <form
                        style={{ display: "grid", gap: 12, marginTop: 12 }}
                        onSubmit={(e) => {
                          e.preventDefault();
                          const formEl = e.currentTarget;
                          const data = new FormData(formEl);
                          data.append("intent", "updateCustomer");
                          data.append("customerId", customer?.id || "");
                          data.append(
                            "customerEmail",
                            customer?.email || selected?.email || "",
                          );
                          flowFetcher.submit(data, { method: "post" });
                        }}
                      >
                        {[
                          {
                            label: "Email *",
                            name: "email",
                            required: true,
                            value: customer.email,
                          },
                          {
                            label: "First Name *",
                            name: "firstName",
                            required: true,
                            value: customer.firstName ?? "",
                          },
                          {
                            label: "Last Name",
                            name: "lastName",
                            value: customer.lastName ?? "",
                          },
                          {
                            label: "Phone",
                            name: "phone",
                            value: customer.phone ?? "",
                          },
                        ].map(({ label, name, required, value }) => (
                          <label
                            key={name}
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              gap: 4,
                            }}
                          >
                            <span>{label}</span>
                            <input
                              name={name}
                              defaultValue={value}
                              required={required}
                              style={{
                                padding: 10,
                                borderRadius: 8,
                                border: "1px solid #c9ccd0",
                              }}
                            />
                          </label>
                        ))}
                        <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                          <s-button
                            type="submit"
                            {...(isUpdatingCustomer ? { loading: true } : {})}
                          >
                            Update Customer
                          </s-button>
                          <s-button
                            variant="tertiary"
                            onClick={() => setStep("check")}
                            disabled={isUpdatingCustomer}
                          >
                            Back
                          </s-button>
                        </div>
                      </form>
                    </>
                  ) : (
                    <div
                      style={{
                        border: "1px solid #e3e3e3",
                        borderRadius: 12,
                        padding: 16,
                      }}
                    >
                      <h4 style={{ marginTop: 0 }}>Create Customer</h4>
                      <p style={{ color: "#5c5f62", marginTop: 4 }}>
                        Fill in the customer details below.
                      </p>

                      <form
                        style={{ display: "grid", gap: 12, marginTop: 12 }}
                        onSubmit={(e) => {
                          e.preventDefault();
                          const formEl = e.currentTarget;
                          const data = new FormData(formEl);
                          data.append("intent", "createCustomer");
                          flowFetcher.submit(data, { method: "post" });
                        }}
                      >
                        {[
                          {
                            label: "Email",
                            name: "email",
                            required: true,
                            value: selected.email,
                          },
                          {
                            label: "First name",
                            name: "firstName",
                            required: true,
                            value: contactNameParts.firstName,
                          },
                          {
                            label: "Last name",
                            name: "lastName",
                            value: contactNameParts.lastName,
                          },
                          {
                            label: "Phone",
                            name: "phone",
                            value: selected.phone,
                          },
                        ].map(({ label, name, required, value }) => (
                          <label
                            key={name}
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              gap: 4,
                            }}
                          >
                            <span
                              style={{
                                fontSize: 12,
                                color: "#5c5f62",
                                fontWeight: 500,
                              }}
                            >
                              {label}
                            </span>
                            <input
                              name={name}
                              defaultValue={value}
                              required={required}
                              style={{
                                padding: 10,
                                borderRadius: 8,
                                border: "1px solid #c9ccd0",
                              }}
                            />
                          </label>
                        ))}
                        <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                          <s-button
                            type="submit"
                            {...(isCreatingCustomer ? { loading: true } : {})}
                          >
                            Create Customer
                          </s-button>
                          <s-button
                            variant="tertiary"
                            onClick={() => setStep("check")}
                            disabled={isCreatingCustomer}
                          >
                            Back
                          </s-button>
                        </div>
                      </form>
                    </div>
                  )}
                </div>
              )}

              {/* ── Step: Create Company ─────────────────────────────────── */}
              {step === "createCompany" && (
                <div
                  style={{
                    border: "1px solid #e3e3e3",
                    borderRadius: 12,
                    padding: 16,
                  }}
                >
                  {/* Header with Back button */}
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
                          {/* <s-button
                            variant="secondary"
                            onClick={() => setEditMode("update")}
                          >
                            Update Company
                          </s-button> */}
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
                            const formEl = e.currentTarget;
                            const data = new FormData(formEl);
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

                          <label
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              gap: 4,
                            }}
                          >
                            <span
                              style={{
                                fontSize: 12,
                                color: "#5c5f62",
                                fontWeight: 500,
                              }}
                            >
                              Company name *
                            </span>
                            <input
                              name="companyName"
                              defaultValue={company?.name || ""}
                              required
                              style={{
                                padding: 10,
                                borderRadius: 8,
                                border: "1px solid #c9ccd0",
                              }}
                            />
                          </label>

                          <label
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              gap: 4,
                            }}
                          >
                            <span
                              style={{
                                fontSize: 12,
                                color: "#5c5f62",
                                fontWeight: 500,
                              }}
                            >
                              Payment terms
                            </span>
                            <select
                              name="paymentTerms"
                              defaultValue={
                                company?.paymentTermsTemplateId || ""
                              }
                              style={{
                                padding: 10,
                                borderRadius: 8,
                                border: "1px solid #c9ccd0",
                                backgroundColor: "white",
                              }}
                            >
                              <option value="">No payment terms</option>
                              {paymentTermsTemplates?.map((template) => (
                                <option key={template.id} value={template.id}>
                                  {template.name}
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
                        const formEl = e.currentTarget;
                        const data = new FormData(formEl);
                        data.append("intent", "createCompany");
                        data.append("customerId", customer?.id || "");
                        data.append(
                          "customerEmail",
                          customer?.email || selected?.email || "",
                        );
                        flowFetcher.submit(data, { method: "post" });
                      }}
                    >
                      <label
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 4,
                        }}
                      >
                        <span
                          style={{
                            fontSize: 12,
                            color: "#5c5f62",
                            fontWeight: 500,
                          }}
                        >
                          Company name *
                        </span>
                        <input
                          name="companyName"
                          defaultValue={selected.companyName}
                          required
                          style={{
                            padding: 10,
                            borderRadius: 8,
                            border: "1px solid #c9ccd0",
                          }}
                        />
                      </label>

                      <label
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 4,
                        }}
                      >
                        <span
                          style={{
                            fontSize: 12,
                            color: "#5c5f62",
                            fontWeight: 500,
                          }}
                        >
                          Payment terms
                        </span>
                        <select
                          name="paymentTerms"
                          defaultValue={selected.paymentTermsTemplateId}
                          style={{
                            padding: 10,
                            borderRadius: 8,
                            border: "1px solid #c9ccd0",
                            backgroundColor: "white",
                          }}
                        >
                          <option value="">No payment terms</option>
                          {paymentTermsTemplates?.map((template) => (
                            <option key={template.id} value={template.id}>
                              {template.name}
                            </option>
                          ))}
                        </select>
                      </label>

                      <div>
                        <span
                          style={{
                            fontSize: 12,
                            color: "#5c5f62",
                            fontWeight: 500,
                            marginBottom: 4,
                            display: "block",
                          }}
                        >
                          Credit limit
                        </span>
                        <input
                          name="creditLimit"
                          type="number"
                          defaultValue={selected.creditLimit}
                          onChange={(e) =>
                            setCreditLimit(Number(e.target.value) || 0)
                          }
                          required
                          style={{
                            padding: 10,
                            borderRadius: 8,
                            border: "1px solid #c9ccd0",
                            width: 120,
                          }}
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

              {/* ── Step: Assign ─────────────────────────────────────────── */}
              {step === "assign" && (
                <div
                  style={{
                    border: "1px solid #e3e3e3",
                    borderRadius: 12,
                    padding: 16,
                  }}
                >
                  <h4 style={{ marginTop: 0 }}>Assign Main Contact</h4>
                  <p style={{ color: "#5c5f62", marginTop: 4 }}>
                    Assign the customer as the main contact for this company.
                  </p>

                  <div style={{ marginTop: 12 }}>
                    <s-banner tone="info">
                      <s-text>
                        Customer: {customer?.firstName} {customer?.lastName} (
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

              {step === "email" && (
                <div
                  style={{
                    border: "1px solid #e3e3e3",
                    borderRadius: 12,
                    padding: 16,
                  }}
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
                        Contact: {customer?.firstName} {customer?.lastName}
                        <br />
                        Company: {company?.name || selected?.companyName}
                      </s-text>
                    </s-banner>
                  </div>

                  {/* ✅ Show success banner after email sent — no auto-redirect */}
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

                  <div style={{ marginTop: 12 }}>
                    <label
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 6,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 12,
                          color: "#5c5f62",
                          fontWeight: 500,
                        }}
                      >
                        Review notes (optional)
                      </span>
                      <textarea
                        value={reviewNotes}
                        onChange={(e) => setReviewNotes(e.target.value)}
                        placeholder="Add any notes about this approval"
                        disabled={
                          flowFetcher.data?.intent === "sendWelcomeEmail" &&
                          flowFetcher.data?.success
                        }
                        style={{
                          minHeight: 80,
                          padding: 10,
                          borderRadius: 8,
                          border: "1px solid #c9ccd0",
                          backgroundColor:
                            flowFetcher.data?.intent === "sendWelcomeEmail" &&
                            flowFetcher.data?.success
                              ? "#f3f4f6"
                              : "white",
                        }}
                      />
                    </label>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      marginTop: 16,
                      flexWrap: "wrap",
                    }}
                  >
                    {/* Hide Send button once email is sent successfully */}
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
                              contactName: `${customer?.firstName} ${customer?.lastName}`,
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

                    {/* ✅ Manual "Next" button — only appears after email is sent */}
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

              {/* ── Step: Complete ───────────────────────────────────────── */}
              {step === "complete" && (
                <div
                  style={{
                    border: "1px solid #e3e3e3",
                    borderRadius: 12,
                    padding: 16,
                  }}
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
                      <div>
                        Customer: {customer?.firstName} {customer?.lastName}
                      </div>
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

                  {/* ✅ Show approved success state OR ready-to-approve prompt */}
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

                      {/* ✅ Manual Done button — user chooses when to close */}
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

              {/* ── Error Display ────────────────────────────────────────── */}
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
