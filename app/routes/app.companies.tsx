import { useMemo } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  HeadersFunction,
} from "react-router";
import { Link, useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

type LoaderCompany = {
  id: string;
  name: string;
  shopifyCompanyId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  creditLimit: string;
  updatedAt: string;
};

interface ActionResponse {
  intent: string;
  success: boolean;
  message?: string;
  errors?: string[];
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!store) {
    return Response.json(
      { companies: [], storeMissing: true },
      { status: 404 },
    );
  }

  const companies = await prisma.companyAccount.findMany({
    where: { shopId: store.id },
    orderBy: { updatedAt: "desc" },
  });

  return Response.json({
    companies: companies.map(
      (company) =>
        ({
          ...company,
          creditLimit: company.creditLimit.toString(),
          updatedAt: company.updatedAt.toISOString(),
        }) satisfies LoaderCompany,
    ),
    storeMissing: false,
  });
};

const parseForm = async (request: Request) => {
  const formData = await request.formData();
  return Object.fromEntries(formData);
};

const parseCredit = (value?: string) => {
  if (!value) return new Prisma.Decimal(0);
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return null;
  return new Prisma.Decimal(numeric);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
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

  switch (intent) {
    case "updateCredit": {
      const id = (form.id as string)?.trim();
      const creditRaw = (form.creditLimit as string) || "0";
      const credit = parseCredit(creditRaw);

      if (!id) {
        return Response.json({
          intent,
          success: false,
          errors: ["Company id is required"],
        });
      }
      if (!credit) {
        return Response.json({
          intent,
          success: false,
          errors: ["Credit must be a number"],
        });
      }

      await prisma.companyAccount.update({
        where: { id },
        data: { creditLimit: credit },
      });

      return Response.json({
        intent,
        success: true,
        message: "Credit updated",
      });
    }

    case "createCompany": {
      const name = (form.name as string)?.trim();
      const shopifyCompanyId =
        (form.shopifyCompanyId as string)?.trim() || null;
      const contactName = (form.contactName as string)?.trim() || null;
      const contactEmail = (form.contactEmail as string)?.trim() || null;
      const credit = parseCredit((form.creditLimit as string) || undefined);

      if (!name) {
        return Response.json({
          intent,
          success: false,
          errors: ["Company name is required"],
        });
      }
      if (!credit) {
        return Response.json({
          intent,
          success: false,
          errors: ["Credit must be a number"],
        });
      }

      if (shopifyCompanyId) {
        await prisma.companyAccount.upsert({
          where: {
            shopId_shopifyCompanyId: {
              shopId: store.id,
              shopifyCompanyId,
            },
          },
          update: {
            name,
            contactName,
            contactEmail,
            creditLimit: credit,
          },
          create: {
            shopId: store.id,
            shopifyCompanyId,
            name,
            contactName,
            contactEmail,
            creditLimit: credit,
          },
        });
      } else {
        await prisma.companyAccount.create({
          data: {
            shopId: store.id,
            shopifyCompanyId: null,
            name,
            contactName,
            contactEmail,
            creditLimit: credit,
          },
        });
      }

      return Response.json({ intent, success: true, message: "Company saved" });
    }

    default:
      return Response.json({
        intent,
        success: false,
        errors: ["Unknown intent"],
      });
  }
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

export default function CompaniesPage() {
  const { companies, storeMissing } = useLoaderData<typeof loader>();
  const updateFetcher = useFetcher<ActionResponse>();
  const createFetcher = useFetcher<ActionResponse>();

  const isUpdating = updateFetcher.state !== "idle";
  const isCreating = createFetcher.state !== "idle";

  const feedback = useMemo(() => {
    const latest = updateFetcher.data || createFetcher.data;
    if (!latest) return null;
    if (!latest.success && latest.errors?.length) {
      return {
        tone: "critical" as const,
        title: "Something went wrong",
        messages: latest.errors,
      };
    }
    if (latest.success && latest.message) {
      return {
        tone: "success" as const,
        title: latest.message,
        messages: [],
      };
    }
    return null;
  }, [updateFetcher.data, createFetcher.data]);

  if (storeMissing) {
    return (
      <s-page heading="Companies">
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
    <s-page heading="Companies">
      <s-section heading="Company list">
        {feedback && (
          <s-banner
            tone={feedback.tone}
            title={feedback.title}
            style={{ marginBottom: 15 }}
          >
            {feedback.messages.length > 0 && (
              <s-unordered-list>
                {feedback.messages.map((msg) => (
                  <s-list-item key={msg}>{msg}</s-list-item>
                ))}
              </s-unordered-list>
            )}
          </s-banner>
        )}

        {companies.length === 0 ? (
          <s-empty-state heading="No companies yet" />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {companies.map((company) => (
              <div
                key={company.id}
                style={{
                  border: "1px solid #e3e3e3",
                  borderRadius: 12,
                  padding: 16,
                  backgroundColor: "#ffffff",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
                }}
              >
                {/* Header Row */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    marginBottom: 12,
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <h3
                      style={{
                        margin: "0 0 4px 0",
                        fontSize: 16,
                        fontWeight: 600,
                      }}
                    >
                      {company.name}
                    </h3>
                    {company.shopifyCompanyId && (
                      <p
                        style={{
                          margin: 0,
                          fontSize: 12,
                          color: "#6d7175",
                        }}
                      >
                        ID:{" "}
                        {company.shopifyCompanyId.replace(
                          "gid://shopify/Company/",
                          "",
                        )}
                      </p>
                    )}
                  </div>

                  <Link
                    to={`/app/companies/${company.id}`}
                    style={{ textDecoration: "none" }}
                  >
                    <s-button size="slim">Company Details</s-button>
                  </Link>
                </div>

                {/* Details Grid */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                    gap: 16,
                    marginBottom: 16,
                    paddingTop: 12,
                    borderTop: "1px solid #f1f2f4",
                  }}
                >
                  <div>
                    <p
                      style={{
                        margin: "0 0 4px 0",
                        fontSize: 12,
                        color: "#6d7175",
                        fontWeight: 500,
                      }}
                    >
                      Contact
                    </p>
                    {company.contactName ? (
                      <div>
                        <p style={{ margin: 0, fontSize: 14 }}>
                          {company.contactName}
                        </p>
                        {company.contactEmail && (
                          <p
                            style={{
                              margin: "2px 0 0 0",
                              fontSize: 13,
                              color: "#6d7175",
                            }}
                          >
                            {company.contactEmail}
                          </p>
                        )}
                      </div>
                    ) : (
                      <p style={{ margin: 0, fontSize: 14, color: "#8c9196" }}>
                        Not set
                      </p>
                    )}
                  </div>

                  <div>
                    <p
                      style={{
                        margin: "0 0 4px 0",
                        fontSize: 12,
                        color: "#6d7175",
                        fontWeight: 500,
                      }}
                    >
                      Credit Limit
                    </p>
                    <p style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
                      {formatCredit(company.creditLimit)}
                    </p>
                  </div>

                  <div>
                    <p
                      style={{
                        margin: "0 0 4px 0",
                        fontSize: 12,
                        color: "#6d7175",
                        fontWeight: 500,
                      }}
                    >
                      Last Updated
                    </p>
                    <p style={{ margin: 0, fontSize: 14 }}>
                      {new Date(company.updatedAt).toLocaleString()}
                    </p>
                  </div>
                </div>

                {/* Credit Update Form */}
                <updateFetcher.Form
                  method="post"
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    paddingTop: 12,
                    borderTop: "1px solid #f1f2f4",
                  }}
                >
                  <input name="intent" value="updateCredit" hidden readOnly />
                  <input name="id" value={company.id} hidden readOnly />

                  <label
                    htmlFor={`credit-${company.id}`}
                    style={{
                      fontSize: 14,
                      fontWeight: 500,
                      color: "#202223",
                    }}
                  >
                    Update Credit Limit:
                  </label>

                  <input
                    id={`credit-${company.id}`}
                    name="creditLimit"
                    defaultValue={company.creditLimit}
                    type="number"
                    step="0.01"
                    min="0"
                    style={{
                      padding: "8px 12px",
                      borderRadius: 8,
                      border: "1px solid #c9cccf",
                      fontSize: 14,
                      width: 140,
                      outline: "none",
                    }}
                    onFocus={(e) => {
                      e.target.style.borderColor = "#005bd3";
                      e.target.style.boxShadow = "0 0 0 1px #005bd3";
                    }}
                    onBlur={(e) => {
                      e.target.style.borderColor = "#c9cccf";
                      e.target.style.boxShadow = "none";
                    }}
                  />

                  <s-button
                    type="submit"
                    variant="primary"
                    {...(isUpdating ? { loading: true } : {})}
                  >
                    Save Credit
                  </s-button>
                </updateFetcher.Form>
              </div>
            ))}
          </div>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
