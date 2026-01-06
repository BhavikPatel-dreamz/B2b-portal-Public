import { useMemo } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  HeadersFunction,
} from "react-router";
import {
  useFetcher,
  useLoaderData,
  useNavigation,
  useNavigate,
} from "react-router";
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
  const navigate = useNavigate();
  const navigation = useNavigation();

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
     <s-section>
  <div
    style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 12,
    }}
  >
    <h4 style={{ margin: 0 }}>Company list</h4>

    <s-button
      type="submit"
      variant="secondary"
      loading={isCreating}
    >
      Company Sync
    </s-button>
  </div>


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
                  <th style={{ textAlign: "left", padding: "8px" }}>Company</th>
                  <th style={{ textAlign: "left", padding: "8px" }}>
                    Shopify company ID
                  </th>
                  <th style={{ textAlign: "left", padding: "8px" }}>Contact</th>
                  <th style={{ textAlign: "left", padding: "8px" }}>Credit</th>
                  <th style={{ textAlign: "left", padding: "8px" }}>Updated</th>
                  <th style={{ textAlign: "left", padding: "8px" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {companies.map((company) => (
                  <tr
                    key={company.id}
                    style={{ borderTop: "1px solid #e3e3e3" }}
                  >
                    <td style={{ padding: "8px" }}>{company.name}</td>
                    <td
                      style={{ padding: "8px", fontSize: 12, color: "#5c5f62" }}
                    >
                      {company.shopifyCompanyId
                        ? company.shopifyCompanyId.replace(
                            "gid://shopify/Company/",
                            "",
                          )
                        : "–"}
                    </td>

                    <td style={{ padding: "8px" }}>
                      {company.contactName ? (
                        <span>
                          {company.contactName}
                          {company.contactEmail
                            ? ` • ${company.contactEmail}`
                            : ""}
                        </span>
                      ) : (
                        <span style={{ color: "#5c5f62" }}>Not set</span>
                      )}
                    </td>
                    <td style={{ padding: "8px" }}>
                      {formatCredit(company.creditLimit)}
                    </td>
                    <td style={{ padding: "8px" }}>
                      {new Date(company.updatedAt).toLocaleString()}
                    </td>
                    <td style={{ padding: "8px", minWidth: 180 }}>
                      <updateFetcher.Form
                        method="post"
                        style={{
                          display: "flex",
                          gap: 6,
                          alignItems: "center",
                        }}
                      >
                        <input
                          name="intent"
                          value="updateCredit"
                          hidden
                          readOnly
                        />
                        <input name="id" value={company.id} hidden readOnly />
                        <input
                          name="creditLimit"
                          defaultValue={company.creditLimit}
                          type="number"
                          step="0.01"
                          min="0"
                          style={{
                            padding: 8,
                            borderRadius: 8,
                            border: "1px solid #c9ccd0",
                            width: 120,
                          }}
                        />
                        <div style={{ display: "flex", gap: 8 }}>
                          <s-button
                            size="slim"
                            type="submit"
                            variant="primary"
                            loading={isUpdating}
                          >
                            Save
                          </s-button>

                          <s-button
                            size="slim"
                            variant="secondary"
                            loading={
                              navigation.state === "loading" &&
                              navigation.location?.pathname.includes(company.id)
                            }
                            onClick={() =>
                              navigate(`/app/companies/${company.id}`)
                            }
                          >
                            View
                          </s-button>
                        </div>
                      </updateFetcher.Form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
