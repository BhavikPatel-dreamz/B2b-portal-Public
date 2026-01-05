import { useEffect, useMemo, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  sendCompanyAssignmentEmail
} from "app/utils/email";

interface RegistrationSubmission {
  id: string;
  companyName: string;
  contactName: string;
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
  } | null;
}

interface CompanyAccount {
  id: string;
  name: string;
  shopifyCompanyId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  creditLimit: string;
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
      ...payload.errors.map((err: any) =>
        typeof err === "string" ? err : err.message || "Unknown error",
      ),
    );
  }

  const userErrors =
    payload?.data?.customerCreate?.userErrors ||
    payload?.data?.companyCreate?.userErrors ||
    payload?.data?.companyContactCreate?.userErrors ||
    payload?.data?.companyAssignMainContact?.userErrors ||
    payload?.data?.companyContactAssign?.userErrors ||
    [];

  if (userErrors.length) {
    errors.push(
      ...userErrors.map(
        (err: any) => err?.message || (err?.field || []).join(".") || "Error",
      ),
    );
  }

  return errors;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!store) {
    return Response.json(
      { submissions: [], storeMissing: true },
      { status: 404 },
    );
  }

  const submissions = await prisma.registrationSubmission.findMany({
    where: { shopId: store.id },
    orderBy: { createdAt: "desc" },
  });

  const companies = await prisma.companyAccount.findMany({
    where: { shopId: store.id },
    orderBy: { name: "asc" },
  });

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
    storeMissing: false,
  });
};

const parseForm = async (request: Request) => {
  const formData = await request.formData();
  return Object.fromEntries(formData);
};

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
        const errors = buildUserErrorList(payload);
        if (errors.length) {
          return Response.json({ intent, success: false, errors });
        }

        const customer = payload?.data?.customerCreate?.customer;
        return Response.json({
          intent,
          success: true,
          customer,
          message: "Customer created",
        });
      }

      case "createCompany": {
        const companyName = (form.companyName as string)?.trim();
        const locationName =
          (form.locationName as string)?.trim() || `${companyName} HQ`;
        const address1 = (form.address1 as string)?.trim();
        const city = (form.city as string)?.trim();
        const countryCode = (form.countryCode as string)?.trim();
        const provinceCode = (form.provinceCode as string)?.trim();
        const zip = (form.zip as string)?.trim();
        const phone = (form.locationPhone as string)?.trim();

        if (!companyName || !address1 || !city || !countryCode || !zip) {
          return Response.json({
            intent,
            success: false,
            errors: [
              "Company name, location name, address, city, country, and zip are required",
            ],
          });
        }


        const createCompanyResponse = await admin.graphql(
          `#graphql
 mutation CompanyCreate($input: CompanyCreateInput!) {
    companyCreate(input: $input) {
      company {
        id
        name
      }
      userErrors {
        field
        message
      }
    }
  }
  `,
          {
            variables: {
              input: {
                company: {
                  name: companyName, // ✅ REQUIRED
                },
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
        console.log(companyId, "454445454");

        const createLocationResponse = await admin.graphql(
          `#graphql
  mutation CompanyLocationCreate($companyId: ID!, $input: CompanyLocationInput!) {
    companyLocationCreate(companyId: $companyId, input: $input) {
      companyLocation {
        id
        name
      }
      userErrors {
        field
        message
      }
    }
  }
  `,
          {
            variables: {
              companyId,
              input: {
                name: locationName,
                shippingAddress: {
                  address1,
                  city,
                  countryCode,
                  zip,
                  phone: phone || undefined,
                },
              },
            },
          },
        );

        const locationPayload = await createLocationResponse.json();
        const locationErrors = buildUserErrorList(locationPayload);

        if (locationErrors.length) {
          return Response.json({
            intent,
            success: false,
            errors: locationErrors,
          });
        }

        const location =
          locationPayload.data.companyLocationCreate.companyLocation;

        return Response.json({
          intent,
          success: true,
          company: {
            id: companyId,
            name: companyName,
            locationId: location.id,
            locationName: location.name,
          },
          message: "Company and location created",
        });
      }


      case "assignMainContact": {
        const companyId = (form.companyId as string)?.trim();
        const customerIdRaw = (form.customerId as string)?.trim();

        if (!companyId || !customerIdRaw) {
          return Response.json({
            intent,
            success: false,
            errors: ["Company and customer are required"],
          });
        }

        const customerId = normalizeCustomerId(customerIdRaw);

        const response = await admin.graphql(
          `#graphql
    mutation AssignMainContact($companyId: ID!, $customerId: ID!) {
      companyAssignCustomerAsContact(companyId: $companyId, customerId: $customerId) {
        companyContact {
          id
        }
        userErrors {
          field
          message
        }
      }
    }`,
          { variables: { companyId, customerId } },
        );

        const payload = await response.json();
        const errors = buildUserErrorList(payload);

        if (errors.length) {
          return Response.json({ intent, success: false, errors });
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

        if (!email) {
          return Response.json({
            intent,
            success: false,
            errors: ["Email required"],
          });
        }

        // Call the function with separate arguments, not an object
        await sendCompanyAssignmentEmail(email, companyName, contactName);

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
        const note = (form.reviewNotes as string)?.trim() || null;

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
            reviewNotes: note,
            shopifyCustomerId: customerId,
            workflowCompleted: true,
          },
        });

        if (companyId || companyName) {
          await prisma.companyAccount.upsert({
            where: {
              shopId_shopifyCompanyId: {
                shopId: store.id,
                shopifyCompanyId: companyId || null,
              },
            },
            update: {
              name: companyName || undefined,
              contactName,
              contactEmail,
            },
            create: {
              shopId: store.id,
              shopifyCompanyId: companyId || null,
              name: companyName || "Company",
              contactName,
              contactEmail,
              creditLimit: new Prisma.Decimal(0),
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

const formatCredit = (value?: string | null) => {
  if (!value) return "$0.00";
  const num = Number(value);
  if (Number.isNaN(num)) return value;
  return num.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });
};

const StepBadge = ({ label, active }: { label: string; active: boolean }) => (
  <span
    style={{
      display: "inline-block",
      padding: "4px 10px",
      borderRadius: 12,
      background: active ? "#1f73b7" : "#dfe3e8",
      color: active ? "white" : "#202223",
      fontSize: 12,
      letterSpacing: 0.2,
    }}
  >
    {label}
  </span>
);

export default function RegistrationApprovals() {
  const { submissions, companies, storeMissing } = useLoaderData<typeof loader>();
  const [selected, setSelected] = useState<RegistrationSubmission | null>(null);
  const [step, setStep] = useState<
    | "check"
    | "createCustomer"
    | "createCompany"
    | "assign"
    | "email"
    | "complete"
  >("check");
  const [customer, setCustomer] = useState<ActionJson["customer"]>(null);
  const [company, setCompany] = useState<ActionJson["company"]>(null);
  const [reviewNotes, setReviewNotes] = useState("");
  const flowFetcher = useFetcher<ActionJson>();
  const rejectFetcher = useFetcher<ActionJson>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();

  const isFlowLoading = flowFetcher.state !== "idle";
  const isRejecting = rejectFetcher.state !== "idle";

  useEffect(() => {
    if (!flowFetcher.data) return;

    if (
      flowFetcher.data.intent === "checkCustomer" &&
      flowFetcher.data.customer
    ) {
      setCustomer(flowFetcher.data.customer);
      setStep("createCompany");
      return;
    }

    if (
      flowFetcher.data.intent === "createCustomer" &&
      flowFetcher.data.success
    ) {
      setCustomer(flowFetcher.data.customer || null);
      setStep("createCompany");
      shopify.toast.show?.("Customer created");
      return;
    }

    if (
      flowFetcher.data.intent === "createCompany" &&
      flowFetcher.data.success
    ) {
      setCompany(flowFetcher.data.company || null);
      setStep("assign");
      shopify.toast.show?.("Company created");
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
      revalidator.revalidate();
      shopify.toast.show?.("Registration approved");
    }
  }, [flowFetcher.data, shopify, revalidator]);

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
          <s-banner tone="critical" title="Store not found">
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
      <s-section heading="Pending requests">
        {submissions.length === 0 ? (
          <s-empty-state heading="No submissions yet" />
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
                {submissions.map((submission) => (
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
                              : "attention"
                        }
                      >
                        {submission.status}
                      </s-badge>
                    </td>
                    <td style={{ padding: "8px" }}>
                      {formatDate(submission.createdAt)}
                    </td>
                    <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                      {/* Only show buttons if status is PENDING */}
                      {submission.status === "PENDING" ? (
                        <>
                          <s-button
                            size="slim"
                            onClick={() => startApproval(submission)}
                            {...(isFlowLoading && selected?.id === submission.id
                              ? { loading: true }
                              : {})}
                          >
                            Approve
                          </s-button>
                          <s-button
                            tone="critical"
                            variant="tertiary"
                            size="slim"
                            onClick={() => rejectSubmission(submission)}
                            style={{ marginLeft: 8 }}
                            {...(isRejecting && selected?.id === submission.id
                              ? { loading: true }
                              : {})}
                          >
                            Reject
                          </s-button>
                        </>
                      ) : (
                        <span style={{ color: "#5c5f62", fontSize: 14 }}>
                          {submission.status === "APPROVED" ? "Approved" : "Rejected"}
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

      <s-section heading="Companies">
        {companies.length === 0 ? (
          <s-empty-state heading="No companies yet" />
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
                  <th style={{ textAlign: "left", padding: "8px" }}>
                    Company
                  </th>
                  <th style={{ textAlign: "left", padding: "8px" }}>
                    Shopify company ID
                  </th>
                  <th style={{ textAlign: "left", padding: "8px" }}>
                    Contact
                  </th>
                  <th style={{ textAlign: "left", padding: "8px" }}>
                    Credit
                  </th>
                  <th style={{ textAlign: "left", padding: "8px" }}>
                    Updated
                  </th>
                </tr>
              </thead>
              <tbody>
                {companies.map((company) => (
                  <tr
                    key={company.id}
                    style={{ borderTop: "1px solid #e3e3e3" }}
                  >
                    <td style={{ padding: "8px" }}>{company.name}</td>
                    <td style={{ padding: "8px", fontSize: 12, color: "#5c5f62" }}>
                      {company.shopifyCompanyId || "–"}
                    </td>
                    <td style={{ padding: "8px" }}>
                      {company.contactName ? (
                        <span>
                          {company.contactName}
                          {company.contactEmail ? ` • ${company.contactEmail}` : ""}
                        </span>
                      ) : (
                        <span style={{ color: "#5c5f62" }}>Not set</span>
                      )}
                    </td>
                    <td style={{ padding: "8px" }}>{formatCredit(company.creditLimit)}</td>
                    <td style={{ padding: "8px" }}>{formatDate(company.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </s-section>

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
              width: "min(1100px, 90vw)",
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
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  marginBottom: 16,
                  flexWrap: "wrap",
                }}
              >
                <StepBadge
                  label="1. Check customer"
                  active={step === "check"}
                />
                <StepBadge
                  label="2. Create customer"
                  active={step === "createCustomer"}
                />
                <StepBadge
                  label="3. Create company"
                  active={step === "createCompany"}
                />
                <StepBadge
                  label="4. Assign contact"
                  active={step === "assign"}
                />
                <StepBadge label="5. Welcome email" active={step === "email"} />
                <StepBadge label="6. Complete" active={step === "complete"} />
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 18,
                }}
              >
                <div
                  style={{
                    border: "1px solid #e3e3e3",
                    borderRadius: 12,
                    padding: 16,
                  }}
                >
                  <h4 style={{ marginTop: 0 }}>Customer</h4>
                  <p style={{ color: "#5c5f62", marginTop: 4 }}>
                    Check if a customer already exists with this email. If not,
                    create a customer profile.
                  </p>

                  <s-button
                    onClick={() =>
                      flowFetcher.submit(
                        { intent: "checkCustomer", email: selected.email },
                        { method: "post" },
                      )
                    }
                    {...(isFlowLoading &&
                    flowFetcher.data?.intent === "checkCustomer"
                      ? { loading: true }
                      : {})}
                  >
                    Re-check customer
                  </s-button>

                  <div style={{ marginTop: 12 }}>
                    {customer ? (
                      <s-banner tone="success" title="Customer found">
                        <s-text>
                          {customer.firstName || ""} {customer.lastName || ""} ·{" "}
                          {customer.email}
                        </s-text>
                      </s-banner>
                    ) : (
                      <s-banner tone="attention" title="No customer found">
                        <s-text>Create a new customer below.</s-text>
                      </s-banner>
                    )}
                  </div>

                  {!customer && (
                    <form
                      style={{ display: "grid", gap: 8, marginTop: 12 }}
                      onSubmit={(e) => {
                        e.preventDefault();
                        const form = e.currentTarget;
                        const data = new FormData(form);
                        data.append("intent", "createCustomer");
                        flowFetcher.submit(data, { method: "post" });
                      }}
                    >
                      <input
                        name="intent"
                        value="createCustomer"
                        hidden
                        readOnly
                      />
                      <label
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 4,
                        }}
                      >
                        <span style={{ fontSize: 12, color: "#5c5f62" }}>
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
                        <span style={{ fontSize: 12, color: "#5c5f62" }}>
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
                        <span style={{ fontSize: 12, color: "#5c5f62" }}>
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
                        <span style={{ fontSize: 12, color: "#5c5f62" }}>
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
                      <s-button
                        type="submit"
                        {...(isFlowLoading &&
                        flowFetcher.data?.intent === "createCustomer"
                          ? { loading: true }
                          : {})}
                      >
                        Create customer
                      </s-button>
                    </form>
                  )}
                </div>

                <div
                  style={{
                    border: "1px solid #e3e3e3",
                    borderRadius: 12,
                    padding: 16,
                  }}
                >
                  <h4 style={{ marginTop: 0 }}>Company & location</h4>
                  <p style={{ color: "#5c5f62", marginTop: 4 }}>
                    Create the company record and main location for this
                    registration.
                  </p>

                  <form
                    style={{ display: "grid", gap: 8 }}
                    onSubmit={(e) => {
                      e.preventDefault();
                      const form = e.currentTarget;
                      const data = new FormData(form);
                      data.append("intent", "createCompany");
                      flowFetcher.submit(data, { method: "post" });
                    }}
                  >
                    <input
                      name="intent"
                      value="createCompany"
                      hidden
                      readOnly
                    />
                    <label
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 4,
                      }}
                    >
                      <span style={{ fontSize: 12, color: "#5c5f62" }}>
                        Company name
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
                      <span style={{ fontSize: 12, color: "#5c5f62" }}>
                        Location name
                      </span>
                      <input
                        name="locationName"
                        defaultValue={`${selected.companyName} HQ`}
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
                      <span style={{ fontSize: 12, color: "#5c5f62" }}>
                        Address 1
                      </span>
                      <input
                        name="address1"
                        required
                        placeholder="123 Example St"
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
                      <span style={{ fontSize: 12, color: "#5c5f62" }}>
                        City
                      </span>
                      <input
                        name="city"
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
                      <span style={{ fontSize: 12, color: "#5c5f62" }}>
                        Province/State code
                      </span>
                      <input
                        name="provinceCode"
                        placeholder="CA"
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
                      <span style={{ fontSize: 12, color: "#5c5f62" }}>
                        Country code
                      </span>
                      <input
                        name="countryCode"
                        placeholder="US"
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
                      <span style={{ fontSize: 12, color: "#5c5f62" }}>
                        Postal code
                      </span>
                      <input
                        name="zip"
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
                      <span style={{ fontSize: 12, color: "#5c5f62" }}>
                        Phone
                      </span>
                      <input
                        name="locationPhone"
                        style={{
                          padding: 10,
                          borderRadius: 8,
                          border: "1px solid #c9ccd0",
                        }}
                      />
                    </label>
                    <s-button
                      type="submit"
                      {...(isFlowLoading &&
                      flowFetcher.data?.intent === "createCompany"
                        ? { loading: true }
                        : {})}
                    >
                      Create company
                    </s-button>
                  </form>

                  {company && (
                    <s-banner
                      tone="success"
                      title="Company ready"
                      style={{ marginTop: 12 }}
                    >
                      <s-text>
                        {company.name} ·{" "}
                        {company.locationName || "Main location"}
                      </s-text>
                    </s-banner>
                  )}
                </div>
              </div>

              <div
                style={{
                  marginTop: 18,
                  border: "1px solid #e3e3e3",
                  borderRadius: 12,
                  padding: 16,
                }}
              >
                <h4 style={{ marginTop: 0 }}>Assign contact & notify</h4>
                <p style={{ color: "#5c5f62", marginTop: 4 }}>
                  Assign the customer as the main contact for this company, then
                  send a welcome email.
                </p>

                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <s-button
                    disabled={!company || !customer}
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
                    Assign main contact
                  </s-button>

                  <s-button
                    disabled={!customer}
                    onClick={() =>
                      flowFetcher.submit(
                        {
                          intent: "sendWelcomeEmail",
                          email: selected.email,
                          contactName: selected.contactName,
                          companyName: selected.companyName,
                        },
                        { method: "post" },
                      )
                    }
                    {...(isFlowLoading &&
                    flowFetcher.data?.intent === "sendWelcomeEmail"
                      ? { loading: true }
                      : {})}
                  >
                    Send welcome email
                  </s-button>
                </div>

                <div style={{ marginTop: 12 }}>
                  <label
                    style={{ display: "flex", flexDirection: "column", gap: 6 }}
                  >
                    <span style={{ fontSize: 12, color: "#5c5f62" }}>
                      Review notes
                    </span>
                    <textarea
                      value={reviewNotes}
                      onChange={(e) => setReviewNotes(e.target.value)}
                      placeholder="Optional notes for this decision"
                      style={{
                        minHeight: 80,
                        padding: 10,
                        borderRadius: 8,
                        border: "1px solid #c9ccd0",
                      }}
                    />
                  </label>
                </div>

                <div
                  style={{
                    marginTop: 12,
                    display: "flex",
                    gap: 10,
                    flexWrap: "wrap",
                  }}
                >
                  <s-button
                    variant="primary"
                    disabled={!customer}
                    onClick={completeApproval}
                    {...(isFlowLoading &&
                    flowFetcher.data?.intent === "completeApproval"
                      ? { loading: true }
                      : {})}
                  >
                    Mark as approved
                  </s-button>
                  <s-button
                    variant="tertiary"
                    onClick={() => setSelected(null)}
                  >
                    Cancel
                  </s-button>
                </div>

                {flowFetcher.data?.errors &&
                  flowFetcher.data.errors.length > 0 && (
                    <s-banner
                      tone="critical"
                      title="Something went wrong"
                      style={{ marginTop: 12 }}
                    >
                      <s-unordered-list>
                        {flowFetcher.data.errors.map((err) => (
                          <s-list-item key={err}>{err}</s-list-item>
                        ))}
                      </s-unordered-list>
                    </s-banner>
                  )}
              </div>
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
