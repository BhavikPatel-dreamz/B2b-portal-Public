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
  paymentTerm: string;
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
    zip?: string | null;
    creditLimit?: string | null;
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
  // Fetch submissions for all statuses
  const [pendingSubmissions, approvedSubmissions, rejectedSubmissions] =
    await Promise.all([
      prisma.registrationSubmission.findMany({
        where: {
          shopId: store.id,
          status: "PENDING",
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.registrationSubmission.findMany({
        where: {
          shopId: store.id,
          status: "APPROVED",
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.registrationSubmission.findMany({
        where: {
          shopId: store.id,
          status: "REJECTED",
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);

  // Combine all submissions
  const submissions = [
    ...pendingSubmissions,
    ...approvedSubmissions,
    ...rejectedSubmissions,
  ];

  const companies = await prisma.companyAccount.findMany({
    where: { shopId: store.id },
    orderBy: { name: "asc" },
  });

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
    companies: companies.map((company) => ({
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
    /* 1️⃣ Get contact roles */
    const companyRes = await admin.graphql(
      `#graphql
      query getCompany($companyId: ID!) {
        company(id: $companyId) {
          contactRoles(first: 10) {
            edges { node { id name } }
          }
        }
      }`,
      { variables: { companyId } },
    );

    const companyJson = await companyRes.json();
    const roles = companyJson.data?.company?.contactRoles?.edges || [];

    const companyContactRoleId =
      roles.find(
        (edge: { node: { name: string } }) =>
          edge.node.name.toLowerCase() === "company admin",
      )?.node?.id || roles[0]?.node?.id;

    if (!companyContactRoleId) {
      return {
        success: false,
        error: "No company contact roles available",
        step: "getRoles",
      };
    }

    /* 2️⃣ Assign customer as contact */
    const contactRes = await admin.graphql(
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
    );

    const contactJson = await contactRes.json();
    const contactPayload = contactJson.data?.companyAssignCustomerAsContact;

    if (contactPayload?.userErrors?.length) {
      return {
        success: false,
        error: contactPayload.userErrors[0].message,
        step: "assignContact",
      };
    }

    const companyContactId = contactPayload.companyContact.id;

    /* 3️⃣ Assign role + PROVIDED location */
    const roleRes = await admin.graphql(
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
    );

    const roleJson = await roleRes.json();
    const rolePayload = roleJson.data?.companyContactAssignRole;

    if (rolePayload?.userErrors?.length) {
      return {
        success: false,
        error: rolePayload.userErrors[0].message,
        step: "assignRole",
      };
    }

    /* 4️⃣ Assign main contact */
    const mainContactRes = await admin.graphql(
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
    );

    const mainContactJson = await mainContactRes.json();
    const mainContactPayload = mainContactJson.data?.companyAssignMainContact;

    if (mainContactPayload?.userErrors?.length) {
      return {
        success: false,
        error: mainContactPayload.userErrors[0].message,
        step: "assignMainContact",
      };
    }

    return {
      success: true,
      companyContactId,
      company: mainContactPayload.company,
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

        const response = await admin.graphql(
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
        );

        const payload = await response.json();
        const customer = payload?.data?.customers?.nodes?.[0] || null;

        const Registration = await prisma.registrationSubmission.findFirst({
          where: { email },
        });

        const user = await prisma.user.findFirst({
          where: { email },
        });
        if (!user && Registration) {
          await prisma.user.create({
            data: {
              email,
              firstName: Registration?.contactName?.split(" ")[0] || undefined,
              lastName: Registration?.contactName?.split(" ")[1] || undefined,
              status: "PENDING",
              shopId: store.id,
              isActive: false,
              role: "STORE_ADMIN",
              userCreditLimit: 0,
              password: "",
            },
          });
        }

        return Response.json({
          intent,
          success: true,
          customer,
          message: customer ? "Customer exists" : "No customer found",
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

        // Validate and format phone number
        let formattedPhone = undefined;
        if (phone) {
          // Remove all non-digit characters
          const digitsOnly = phone.replace(/\D/g, "");

          // Only include phone if it has a reasonable length (e.g., 10+ digits)
          if (digitsOnly.length >= 10) {
            // Format as E.164 if it looks like a US number (10 digits)
            if (digitsOnly.length === 10) {
              formattedPhone = `+1${digitsOnly}`;
            } else if (digitsOnly.length === 11 && digitsOnly.startsWith("1")) {
              formattedPhone = `+${digitsOnly}`;
            } else if (digitsOnly.startsWith("91") && digitsOnly.length >= 12) {
              // Indian number format
              formattedPhone = `+${digitsOnly}`;
            } else {
              // For other formats, just add + if not present
              formattedPhone = phone.startsWith("+") ? phone : `+${digitsOnly}`;
            }
          }
          // If phone is invalid, we'll just skip it rather than error
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
                ...(formattedPhone && { phone: formattedPhone }),
              },
            },
          },
        );

        const payload = await response.json();

        // Check for errors
        const userErrors = payload?.data?.customerCreate?.userErrors || [];

        // If there are any errors, return them
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
              phone: formattedPhone || phone || "",
              shopifyCustomerId: customer?.id || null,
              status: "PENDING",
              companyName: "",
              businessType: "",
              shopId: store.id,
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
        const companyName = (form.companyName as string)?.trim();
        const businessType = (form.businessType as string)?.trim();

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
        const registrationData = await prisma.registrationSubmission.findFirst({
          where: { shopifyCustomerId: customerId },
        });
        if (registrationData) {
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
        } else {
          await prisma.registrationSubmission.create({
            data: {
              contactName: `${firstName} ${lastName || ""}`.trim(),
              email,
              phone: phone || "",
              status: "PENDING",
              shopifyCustomerId: customerId || null,
              companyName: companyName || "",
              businessType: businessType || "",
              shopId: store.id,
            },
          });
        }
        const userData = await prisma.user.findFirst({
          where: {
            email,
          },
        });
        if (!userData) {
          await prisma.user.create({
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
        } else {
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
        if (!companyName) {
          return Response.json({
            intent,
            success: false,
            errors: ["Company name is required"],
          });
        }

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
        /* 0️⃣ Read & validate form data */
        const companyName = (form.companyName as string)?.trim();
        const paymentTermsTemplateId = (form.paymentTerms as string)?.trim();
        const creditLimit = (form.creditLimit as string)?.trim();

        if (!companyName) {
          return Response.json({
            intent,
            success: false,
            errors: ["Company name is required"],
          });
        }

        /* 1️⃣ Create Company (Shopify AUTO creates 1 location) */
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

        const companyId = companyPayload.data.companyCreate.company.id;

        /* 2️⃣ Update company metafield (credit limit) */
        if (creditLimit) {
          await updateCompanyMetafield(admin, companyId, {
            namespace: "b2b_credit",
            key: "credit_limit",
            value: creditLimit.toString(),
            type: "number_decimal",
          });
        }

        /* 3️⃣ Save company in Prisma (ONLY company data) */
        let companyData = await prisma.companyAccount.findFirst({
          where: { shopifyCompanyId: companyId },
        });

        if (!companyData) {
          companyData = await prisma.companyAccount.create({
            data: {
              shopId: store.id,
              name: companyName,
              shopifyCompanyId: companyId,
              paymentTerm: paymentTermsTemplateId || null,
              creditLimit: creditLimit ? Number(creditLimit) : undefined,
            },
          });
        }

        /* 4️⃣ Fetch AUTO-created company location */
        const locationQueryResponse = await admin.graphql(
          `#graphql
    query GetCompanyLocation($companyId: ID!) {
      company(id: $companyId) {
        locations(first: 1) {
          nodes {
            id
            name
          }
        }
      }
    }`,
          { variables: { companyId } },
        );

        const locationPayload = await locationQueryResponse.json();
        const location = locationPayload?.data?.company?.locations?.nodes?.[0];

        if (!location) {
          return Response.json({
            intent,
            success: false,
            errors: ["Company location not found"],
          });
        }

        /* 5️⃣ Assign payment terms to EXISTING location */
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
                companyLocationId: location.id,
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

        /* 6️⃣ Update user credit limit (optional logic) */
        if (companyData && creditLimit) {
          const user = await prisma.user.findFirst({
            where: { companyId: companyData.id },
          });

          if (user) {
            await prisma.user.update({
              where: { id: user.id },
              data: {
                userCreditLimit: new Prisma.Decimal(creditLimit),
              },
            });
          }
        }

        /* 7️⃣ Final response */
        return Response.json({
          intent,
          success: true,
          company: {
            id: companyId,
            name: companyName,
            locationId: location.id,
            locationName: location.name,
          },
          message: "Company created successfully",
        });
      }

      case "updateCompany": {
        /* 0️⃣ Read & validate form data */
        const companyId = (form.companyId as string)?.trim();
        const companyName = (form.companyName as string)?.trim();
        const paymentTermsTemplateId = (form.paymentTerms as string)?.trim();
        const creditLimit = (form.creditLimit as string)?.trim();

        if (!companyId || !companyName) {
          return Response.json({
            intent,
            success: false,
            errors: ["Company ID and company name are required"],
          });
        }

        /* 1️⃣ Update Company name in Shopify */
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

        /* 2️⃣ Update Credit Limit metafield */
        if (creditLimit) {
          await updateCompanyMetafield(admin, companyId, {
            namespace: "b2b_credit",
            key: "credit_limit",
            value: creditLimit.toString(),
            type: "number_decimal",
          });
        }

        /* 3️⃣ Update company in Prisma */
        const companyExists = await prisma.companyAccount.findFirst({
          where: { shopifyCompanyId: companyId },
        });

        if (companyExists) {
          await prisma.companyAccount.update({
            where: { id: companyExists.id },
            data: {
              name: companyName,
              paymentTerm: paymentTermsTemplateId || null,
              creditLimit: creditLimit ? Number(creditLimit) : undefined,
            },
          });
        }

        /* 4️⃣ Fetch EXISTING (auto-created) company location */
        const locationQueryResponse = await admin.graphql(
          `#graphql
    query GetCompanyLocation($companyId: ID!) {
      company(id: $companyId) {
        locations(first: 1) {
          nodes {
            id
            name
          }
        }
      }
    }`,
          { variables: { companyId } },
        );

        const locationPayload = await locationQueryResponse.json();
        const location = locationPayload?.data?.company?.locations?.nodes?.[0];

        if (!location) {
          return Response.json({
            intent,
            success: false,
            errors: ["Company location not found"],
          });
        }

        /* 5️⃣ Update payment terms on EXISTING location */
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
                companyLocationId: location.id,
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

        /* 6️⃣ Update user credit limit */
        if (companyExists && creditLimit) {
          const user = await prisma.user.findFirst({
            where: { companyId: companyExists.id },
          });

          if (user) {
            await prisma.user.update({
              where: { id: user.id },
              data: {
                userCreditLimit: new Prisma.Decimal(creditLimit),
              },
            });
          }
        }

        /* 7️⃣ Final response */
        return Response.json({
          intent,
          success: true,
          company: {
            id: companyId,
            name: companyName,
            locationId: location.id,
            locationName: location.name,
          },
          message: "Company updated successfully",
        });
      }

      case "assignMainContact": {
        const companyId = (form.companyId as string)?.trim();
        const customerId = normalizeCustomerId(form.customerId as string);
        const locationId = (form.locationId as string)?.trim();

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

        return Response.json({
          intent,
          success: true,
          message: "Main contact assigned successfully",
        });
      }

      case "sendWelcomeEmail": {
        const email = (form.email as string)?.trim();
        const companyName = (form.companyName as string)?.trim();
        const contactName = (form.contactName as string)?.trim();
        const note = (form.reviewNotes as string)?.trim() || null; // ✅ Extracting reviewNotes

        if (!email) {
          return Response.json({
            intent,
            success: false,
            errors: ["Email required"],
          });
        }

        await sendCompanyAssignmentEmail(
          store.shopName || "Shop Name",
          store.storeOwnerName || "Store Owner",
          email,
          companyName,
          contactName,
          note || "", // ✅ Passing note as first parameter
        );

        const registerData = await prisma.registrationSubmission.findFirst({
          where: {
            email,
          },
        });
        if (registerData) {
          await prisma.registrationSubmission.update({
            where: { id: registerData.id },
            data: {
              reviewNotes: note,
            },
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
          onClick?.(e);
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

  // Add status filter state

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

  const checkRef = useRef<HTMLDivElement>(null);
  const createCustomerRef = useRef<HTMLDivElement>(null);
  const createCompanyRef = useRef<HTMLDivElement>(null);
  const assignRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLDivElement>(null);
  const completeRef = useRef<HTMLDivElement>(null);

  type StepName =
    | "check"
    | "createCustomer"
    | "updateCompany"
    | "createCompany"
    | "assign"
    | "email"
    | "complete";

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

  // Filter submissions based on selected status
  const filteredSubmissions = useMemo(() => {
    return submissions.filter(
      (submission) => submission.status === statusFilter,
    );
  }, [submissions, statusFilter]);

  useEffect(() => {
    if (!flowFetcher.data) return;

    if (
      flowFetcher.data.intent === "checkCustomer" &&
      flowFetcher.data.customer
    ) {
      setCustomer(flowFetcher.data.customer);
      flowFetcher.submit(
        { intent: "checkCompany", companyName: selected?.companyName || "" },
        { method: "post" },
      );
      return;
    }

    if (
      (flowFetcher.data.intent === "createCustomer" ||
        flowFetcher.data.intent === "updateCustomer") &&
      flowFetcher.data.success
    ) {
      setCustomer(flowFetcher.data.customer || null);
      if (flowFetcher.data.intent === "createCustomer") {
        setStep("createCompany");
      }
      setShowCustomerModal(false);
      shopify.toast.show?.(
        flowFetcher.data.intent === "createCustomer"
          ? "Customer created"
          : "Customer updated",
      );
      return;
    }
 
    if (flowFetcher.data.intent === "checkCompany") {
      setStep("createCompany");

      if (flowFetcher.data.company) {
        // Company exists - set company data and switch to UPDATE mode
        setCompany(flowFetcher.data.company);
        setEditMode("update"); // ← KEY FIX: show edit form, not create form

        if (flowFetcher.data.existsInDb) {
          shopify.toast.show?.(
            "Company already exists - you can review or edit details",
          );
        } else {
          shopify.toast.show?.("Company found in Shopify");
        }
      } else {
        // Company doesn't exist - show create form
        setCompany(null);
        setEditMode("create"); // ← ensure clean create mode
      }
      return;
    }
    if (
      flowFetcher.data.intent === "assignMainContact" &&
      flowFetcher.data.success
    ) {
      setStep("email");
      shopify.toast.show?.("Main contact assigned");
      return;
    }

    if (
      flowFetcher.data.intent === "sendWelcomeEmail" &&
      flowFetcher.data.success
    ) {
      setStep("complete");
      shopify.toast.show?.("Welcome email sent");
      return;
    }

    if (
      flowFetcher.data.intent === "completeApproval" &&
      flowFetcher.data.success
    ) {
      setSelected(null);
      setCustomer(null);
      setCompany(null);
      setStep("check");
      setReviewNotes("");
      setEditMode("create");
      revalidator.revalidate();
      shopify.toast.show?.("Registration approved");
    }
  }, [flowFetcher, shopify, revalidator, selected]);

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
      {
        intent: "checkCustomer",
        email: submission.email,
      },
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
        contactName: selected.contactName,
        contactEmail: selected.email,
        paymentTermsTemplateId: selected.paymentTerm || "",
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
          <button
            onClick={() => setStatusFilter("PENDING")}
            style={{
              padding: "8px 16px",
              background: "none",
              border: "none",
              borderBottom:
                statusFilter === "PENDING"
                  ? "2px solid #2c6ecb"
                  : "2px solid transparent",
              color: statusFilter === "PENDING" ? "#2c6ecb" : "#5c5f62",
              fontWeight: statusFilter === "PENDING" ? 600 : 400,
              cursor: "pointer",
              transition: "all 0.2s",
            }}
          >
            Pending ({submissions.filter((s) => s.status === "PENDING").length})
          </button>
          <button
            onClick={() => setStatusFilter("APPROVED")}
            style={{
              padding: "8px 16px",
              background: "none",
              border: "none",
              borderBottom:
                statusFilter === "APPROVED"
                  ? "2px solid #2c6ecb"
                  : "2px solid transparent",
              color: statusFilter === "APPROVED" ? "#2c6ecb" : "#5c5f62",
              fontWeight: statusFilter === "APPROVED" ? 600 : 400,
              cursor: "pointer",
              transition: "all 0.2s",
            }}
          >
            Approved (
            {submissions.filter((s) => s.status === "APPROVED").length})
          </button>
          <button
            onClick={() => setStatusFilter("REJECTED")}
            style={{
              padding: "8px 16px",
              background: "none",
              border: "none",
              borderBottom:
                statusFilter === "REJECTED"
                  ? "2px solid #2c6ecb"
                  : "2px solid transparent",
              color: statusFilter === "REJECTED" ? "#2c6ecb" : "#5c5f62",
              fontWeight: statusFilter === "REJECTED" ? 600 : 400,
              cursor: "pointer",
              transition: "all 0.2s",
            }}
          >
            Rejected (
            {submissions.filter((s) => s.status === "REJECTED").length})
          </button>
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
                  <th style={{ textAlign: "left", padding: "8px" }}>Company</th>
                  <th style={{ textAlign: "left", padding: "8px" }}>Contact</th>
                  <th style={{ textAlign: "left", padding: "8px" }}>Email</th>
                  <th style={{ textAlign: "left", padding: "8px" }}>Phone</th>
                  <th style={{ textAlign: "left", padding: "8px" }}>Status</th>
                  <th style={{ textAlign: "left", padding: "8px" }}>Created</th>
                  <th style={{ textAlign: "left", padding: "8px" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredSubmissions.map((submission) => (
                  <tr
                    key={submission.id}
                    style={{ borderTop: "1px solid #e3e3e3" }}
                  >
                    <td style={{ padding: "8px" }}>{submission.companyName}</td>
                    <td style={{ padding: "8px" }}>{submission.contactName}</td>
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
                            {...(isFlowLoading && selected?.id === submission.id
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
                              {...(isRejecting && selected?.id === submission.id
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

      {/* Customer Create/Update Modal */}
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
              >
                Close
              </s-button>
            </div>
            <div style={{ padding: "18px 24px" }}>
              <form
                style={{ display: "grid", gap: 12 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = e.currentTarget;
                  const data = new FormData(form);
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
                    Email *
                  </span>
                  <input
                    name="email"
                    type="email"
                    defaultValue={customer?.email || selected?.email || ""}
                    required
                    style={{
                      padding: 10,
                      borderRadius: 8,
                      border: "1px solid #c9ccd0",
                    }}
                  />
                </label>
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
                    First name *
                  </span>
                  <input
                    name="firstName"
                    defaultValue={
                      customer?.firstName || contactNameParts.firstName || ""
                    }
                    required
                    style={{
                      padding: 10,
                      borderRadius: 8,
                      border: "1px solid #c9ccd0",
                    }}
                  />
                </label>
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
                    Last name
                  </span>
                  <input
                    name="lastName"
                    defaultValue={
                      customer?.lastName || contactNameParts.lastName || ""
                    }
                    style={{
                      padding: 10,
                      borderRadius: 8,
                      border: "1px solid #c9ccd0",
                    }}
                  />
                </label>
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
                    Phone
                  </span>
                  <input
                    name="phone"
                    defaultValue={customer?.phone || selected?.phone || ""}
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
                    {...(isFlowLoading &&
                    (flowFetcher.data?.intent === "createCustomer" ||
                      flowFetcher.data?.intent === "updateCustomer")
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
              >
                Close
              </s-button>
            </div>
            <div style={{ padding: "18px 24px" }}>
              <form
                style={{ display: "grid", gap: 12 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = e.currentTarget;
                  const data = new FormData(form);
                  data.append(
                    "intent",
                    editMode === "create" ? "createCompany" : "updateCompany",
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
                    style={{
                      fontSize: 12,
                      color: "#5c5f62",
                      fontWeight: 500,
                    }}
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
                    {...(isFlowLoading &&
                    (flowFetcher.data?.intent === "createCompany" ||
                      flowFetcher.data?.intent === "updateCompany")
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
                <h3 style={{ margin: 0 }}>Approve {selected.companyName}</h3>
                <p style={{ margin: "4px 0", color: "#5c5f62" }}>
                  {selected.contactName} • {selected.email}
                </p>
              </div>
              <s-button variant="tertiary" onClick={() => setSelected(null)}>
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
                  label="2. Create customer"
                  active={step === "createCustomer"}
                  onClick={() => goToStep("createCustomer", createCustomerRef)}
                />
                <StepBadge
                  label="3. Create company"
                  active={step === "createCompany"}
                  onClick={() => goToStep("createCompany", createCompanyRef)}
                />
                <StepBadge
                  label="4. Assign contact"
                  active={step === "assign"}
                  onClick={() => goToStep("assign", assignRef)}
                />
                <StepBadge
                  label="5. Welcome email"
                  active={step === "email"}
                  onClick={() => goToStep("email", emailRef)}
                />
                <StepBadge
                  label="6. Complete"
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
                  <h4 style={{ marginTop: 0 }}>Check Customer</h4>
                  <p style={{ color: "#5c5f62", marginTop: 4 }}>
                    Checking if a customer already exists with email:{" "}
                    {selected.email}
                  </p>

                  {isFlowLoading &&
                  flowFetcher.data?.intent === "checkCustomer" ? (
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
                      <div style={{ marginTop: 12, display: "flex", gap: 10 }}>
                        <s-button onClick={() => setStep("createCompany")}>
                          Continue to Company Setup
                        </s-button>
                        <s-button
                          onClick={() => {
                            setCustomerMode("update");
                            setStep("createCustomer");
                          }}
                        >
                          Update Customer
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
                          No existing customer found. You Will need to create
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

              {/* Step: Create Customer */}
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

                      {/* Show update form */}
                      <form
                        style={{ display: "grid", gap: 12, marginTop: 12 }}
                        onSubmit={(e) => {
                          e.preventDefault();
                          const form = e.currentTarget;
                          const data = new FormData(form);
                          data.append("intent", "updateCustomer");
                          data.append("customerId", customer.id);
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
                          <span>Email *</span>
                          <input
                            name="email"
                            defaultValue={customer.email}
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
                          <span>First Name *</span>
                          <input
                            name="firstName"
                            defaultValue={customer.firstName ?? ""}
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
                          <span>Last Name</span>
                          <input
                            name="lastName"
                            defaultValue={customer.lastName ?? ""}
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
                          <span>Phone</span>
                          <input
                            name="phone"
                            defaultValue={customer.phone ?? ""}
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
                            {...(isFlowLoading ? { loading: true } : {})}
                          >
                            Update Customer
                          </s-button>
                          <s-button
                            variant="tertiary"
                            onClick={() => setStep("check")}
                          >
                            Back
                          </s-button>
                        </div>
                      </form>
                    </>
                  ) : (
                    // Existing creation form remains

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
                          const form = e.currentTarget;
                          const data = new FormData(form);
                          data.append("intent", "createCustomer");
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
                            Email
                          </span>
                          <input
                            name="email"
                            defaultValue={selected.email}
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
                            First name
                          </span>
                          <input
                            name="firstName"
                            defaultValue={contactNameParts.firstName}
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
                            Last name
                          </span>
                          <input
                            name="lastName"
                            defaultValue={contactNameParts.lastName}
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
                            Phone
                          </span>
                          <input
                            name="phone"
                            defaultValue={selected.phone}
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
                            {...(isFlowLoading &&
                            flowFetcher.data?.intent === "createCustomer"
                              ? { loading: true }
                              : {})}
                          >
                            Create Customer
                          </s-button>
                          <s-button
                            variant="tertiary"
                            onClick={() => setStep("check")}
                          >
                            Back
                          </s-button>
                        </div>
                      </form>
                    </div>
                  )}
                </div>
              )}

              {/* Step: Create Company */}
              {step === "createCompany" && (
                <div
                  style={{
                    border: "1px solid #e3e3e3",
                    borderRadius: 12,
                    padding: 16,
                  }}
                >
                  <h4 style={{ marginTop: 0 }}>Create Company & Location</h4>
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

                      {/* Show buttons when NOT in edit mode */}
                      {editMode !== "update" && (
                        <div
                          style={{ marginTop: 12, display: "flex", gap: 10 }}
                        >
                          <s-button onClick={() => setStep("assign")}>
                            Continue to Assign Contact
                          </s-button>
                          <s-button
                            variant="secondary"
                            onClick={() => setEditMode("update")}
                          >
                            Edit Company Details
                          </s-button>
                        </div>
                      )}

                      {/* Inline Edit Form - shows when editMode is "update" */}
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
                            const form = e.currentTarget;
                            const data = new FormData(form);
                            data.append("intent", "updateCompany");
                            data.append("companyId", company?.id || "");
                            data.append(
                              "locationId",
                              company?.locationId || "",
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
                              {...(isFlowLoading &&
                              flowFetcher.data?.intent === "updateCompany"
                                ? { loading: true }
                                : {})}
                            >
                              Update Company
                            </s-button>
                            <s-button
                              variant="tertiary"
                              type="button"
                              onClick={() => setEditMode("create")}
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
                        const form = e.currentTarget;
                        const data = new FormData(form);
                        data.append("intent", "createCompany");
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
                        <div
                          style={{
                            display: "flex",
                            alignItems: "stretch",
                            border: "1px solid #c9ccd0",
                            borderRadius: 8,
                            overflow: "hidden",
                          }}
                        >
                          <input
                            name="creditLimit"
                            type="number"
                            value={selected.creditLimit}
                            onChange={(e) =>
                              setCreditLimit(Number(e.target.value) || 0)
                            }
                            required
                            style={{
                              padding: 10,
                              border: "none",
                              borderLeft: "1px solid #c9ccd0",
                              borderRight: "1px solid #c9ccd0",
                              width: 120,
                              textAlign: "center",
                              outline: "none",
                            }}
                          />
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                        <s-button
                          type="submit"
                          {...(isFlowLoading &&
                          flowFetcher.data?.intent === "createCompany"
                            ? { loading: true }
                            : {})}
                        >
                          Create Company
                        </s-button>
                        <s-button
                          variant="tertiary"
                          onClick={() =>
                            setStep(customer ? "check" : "createCustomer")
                          }
                        >
                          Back
                        </s-button>
                      </div>
                    </form>
                  )}
                </div>
              )}
              {/* Step: Assign Contact */}
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
                        Customer: {selected?.contactName}
                        <br />
                        Company: {selected?.companyName}
                      </s-text>
                    </s-banner>
                  </div>

                  <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                    <s-button
                      onClick={() =>
                        flowFetcher.submit(
                          {
                            intent: "assignMainContact",
                            companyId: company?.id || "",
                            customerId: customer?.id || "",
                            locationId: company?.locationId || "",
                          },
                          { method: "post" },
                        )
                      }
                      {...(isFlowLoading &&
                      flowFetcher.data?.intent === "assignMainContact"
                        ? { loading: true }
                        : {})}
                    >
                      Assign Main Contact
                    </s-button>
                    <s-button
                      variant="tertiary"
                      onClick={() => setStep("createCompany")}
                    >
                      Back
                    </s-button>
                  </div>
                </div>
              )}

              {/* Step: Send Welcome Email */}
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
                        To: {selected.email}
                        <br />
                        Contact: {selected.contactName}
                        <br />
                        Company: {selected.companyName}
                      </s-text>
                    </s-banner>
                  </div>

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
                        style={{
                          minHeight: 80,
                          padding: 10,
                          borderRadius: 8,
                          border: "1px solid #c9ccd0",
                        }}
                      />
                    </label>
                  </div>

                  <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                    <s-button
                      onClick={() =>
                        flowFetcher.submit(
                          {
                            intent: "sendWelcomeEmail",
                            email: selected.email,
                            contactName: selected.contactName,
                            companyName: selected.companyName,
                            reviewNotes: reviewNotes, // Add this line
                          },
                          { method: "post" },
                        )
                      }
                      {...(isFlowLoading &&
                      flowFetcher.data?.intent === "sendWelcomeEmail"
                        ? { loading: true }
                        : {})}
                    >
                      Send Welcome Email
                    </s-button>
                    <s-button
                      variant="tertiary"
                      onClick={() => setStep("assign")}
                    >
                      Back
                    </s-button>
                    <s-button
                      variant="tertiary"
                      onClick={() => setStep("complete")}
                    >
                      Skip Email
                    </s-button>
                  </div>
                </div>
              )}

              {/* Step: Complete */}
              {step === "complete" && (
                <div
                  style={{
                    border: "1px solid #e3e3e3",
                    borderRadius: 12,
                    padding: 16,
                  }}
                >
                  <h4 style={{ marginTop: 0 }}>Complete Approval</h4>
                  <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                    <s-button
                      variant="primary"
                      onClick={completeApproval}
                      {...(isFlowLoading &&
                      flowFetcher.data?.intent === "completeApproval"
                        ? { loading: true }
                        : {})}
                    >
                      Mark as Approved
                    </s-button>
                    <s-button
                      variant="tertiary"
                      onClick={() => setStep("email")}
                    >
                      Back
                    </s-button>
                    <s-button
                      variant="tertiary"
                      onClick={() => setSelected(null)}
                    >
                      Cancel
                    </s-button>
                  </div>
                </div>
              )}

              {/* Error Display */}
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
