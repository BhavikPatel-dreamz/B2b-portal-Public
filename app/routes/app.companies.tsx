import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  HeadersFunction,
} from "react-router";
import {
  useFetcher,
  useLoaderData,
  Link,
  useSearchParams,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { syncShopifyCompanies, parseForm, parseCredit } from "../utils/company.server";
import { formatCredit } from "../utils/company.utils";

type LoaderCompany = {
  id: string;
  name: string;
  shopifyCompanyId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  creditLimit: string;
  updatedAt: string;
  userCount: number;
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
      { companies: [], storeMissing: true, totalCount: 0, currentPage: 1, totalPages: 0 },
      { status: 404 },
    );
  }

  // Get page from URL search params
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const searchQuery = url.searchParams.get("search") || "";
  const limit = 10;
  const skip = (page - 1) * limit;

  // Build where clause with search
  const whereClause = {
    shopId: store.id,
    ...(searchQuery && {
      OR: [
        { name: { contains: searchQuery, mode: "insensitive" as const } },
        { shopifyCompanyId: { contains: searchQuery, mode: "insensitive" as const } },
        { contactName: { contains: searchQuery, mode: "insensitive" as const } },
        { contactEmail: { contains: searchQuery, mode: "insensitive" as const } },
      ],
    }),
  };

  // Get total count
  const totalCount = await prisma.companyAccount.count({
    where: whereClause,
  });

  const totalPages = Math.ceil(totalCount / limit);

  const companies = await prisma.companyAccount.findMany({
    where: whereClause,
    orderBy: { updatedAt: "desc" },
    skip,
    take: limit,
    include: {
      _count: {
        select: { users: true },
      },
    },
  });

  return Response.json({
    companies: companies.map(
      (company) =>
        ({
          ...company,
          creditLimit: company.creditLimit.toString(),
          updatedAt: company.updatedAt.toISOString(),
          userCount: company._count?.users ?? 0,
        }) satisfies LoaderCompany,
    ),
    storeMissing: false,
    totalCount,
    currentPage: page,
    totalPages,
    searchQuery,
  });
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

  switch (intent) {
    case "syncCompanies": {
      const result = await syncShopifyCompanies(admin, store, store.submissionEmail);
      return Response.json({
        intent,
        success: result.success,
        message: result.message,
        syncedCount: result.syncedCount,
        errors: result.errors,
      });
    }
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

export default function CompaniesPage() {
  const { companies, storeMissing, totalCount, currentPage, totalPages, searchQuery } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const updateFetcher = useFetcher<ActionResponse>();
  const syncFetcher = useFetcher<ActionResponse>();

  const isUpdating = updateFetcher.state !== "idle";
  const isSyncing = syncFetcher.state !== "idle";

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

          <syncFetcher.Form method="post">
            <input name="intent" value="syncCompanies" hidden readOnly />
            <s-button
              type="submit"
              variant="secondary"
              loading={isSyncing}
            >
              Company Sync
            </s-button>
          </syncFetcher.Form>
        </div>

        {/* Search Input */}
        <div style={{ marginBottom: 16 }}>
          <input
            type="text"
            placeholder="Search by company name, Shopify ID, or contact..."
            defaultValue={searchQuery}
            onChange={(e) => {
              const value = e.target.value;
              setSearchParams((prev) => {
                const newParams = new URLSearchParams(prev);
                if (value) {
                  newParams.set("search", value);
                  newParams.set("page", "1"); // Reset to page 1 on search
                } else {
                  newParams.delete("search");
                }
                return newParams;
              });
            }}
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid #c9ccd0",
              fontSize: 14,
              outline: "none",
            }}
          />
        </div>

        {companies.length === 0 ? (
          <s-empty-state heading={searchQuery ? "No companies found" : "No companies yet"} />
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
                  <th style={{ textAlign: "left", padding: "8px" }}>Users</th>
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
                    <td style={{ padding: "8px" }}>{company.userCount}</td>
                    <td style={{ padding: "8px" }}>
                      {formatCredit(company.creditLimit)}
                    </td>
                    <td style={{ padding: "8px" }}>
                      {new Date(company.updatedAt).toLocaleString()}
                    </td>
                    <td style={{ padding: "8px", minWidth: 180 }}>
                      <Link
                        to={`/app/companies/${company.id}`}
                        style={{
                          display: "inline-block",
                          padding: "6px 12px",
                          borderRadius: 6,
                          border: "1px solid #c9ccd0",
                          textDecoration: "none",
                          color: "#202223",
                          fontSize: 13,
                          fontWeight: 500,
                          backgroundColor: "white",
                          cursor: "pointer",
                        }}
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              gap: 12,
              marginTop: 24,
              paddingTop: 24,
              borderTop: "1px solid #e3e3e3",
            }}
          >
            <Link
              to={`?${new URLSearchParams({ ...(searchQuery && { search: searchQuery }), page: String(currentPage - 1) })}`}
              style={{
                padding: "8px 16px",
                borderRadius: 8,
                border: "1px solid #c9ccd0",
                textDecoration: "none",
                color: currentPage === 1 ? "#999" : "#202223",
                pointerEvents: currentPage === 1 ? "none" : "auto",
                opacity: currentPage === 1 ? 0.5 : 1,
              }}
            >
              Previous
            </Link>

            <div style={{ display: "flex", gap: 8 }}>
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((pageNum) => {
                // Show first page, last page, current page, and pages around current
                const showPage =
                  pageNum === 1 ||
                  pageNum === totalPages ||
                  Math.abs(pageNum - currentPage) <= 1;

                const showEllipsis =
                  (pageNum === 2 && currentPage > 3) ||
                  (pageNum === totalPages - 1 && currentPage < totalPages - 2);

                if (showEllipsis) {
                  return (
                    <span
                      key={pageNum}
                      style={{
                        padding: "8px 12px",
                        color: "#999",
                      }}
                    >
                      ...
                    </span>
                  );
                }

                if (!showPage) return null;

                return (
                  <Link
                    key={pageNum}
                    to={`?${new URLSearchParams({ ...(searchQuery && { search: searchQuery }), page: String(pageNum) })}`}
                    style={{
                      padding: "8px 12px",
                      borderRadius: 8,
                      border: "1px solid #c9ccd0",
                      textDecoration: "none",
                      color: pageNum === currentPage ? "white" : "#202223",
                      background: pageNum === currentPage ? "#005bd3" : "white",
                      fontWeight: pageNum === currentPage ? 600 : 400,
                    }}
                  >
                    {pageNum}
                  </Link>
                );
              })}
            </div>

            <Link
              to={`?${new URLSearchParams({ ...(searchQuery && { search: searchQuery }), page: String(currentPage + 1) })}`}
              style={{
                padding: "8px 16px",
                borderRadius: 8,
                border: "1px solid #c9ccd0",
                textDecoration: "none",
                color: currentPage === totalPages ? "#999" : "#202223",
                pointerEvents: currentPage === totalPages ? "none" : "auto",
                opacity: currentPage === totalPages ? 0.5 : 1,
              }}
            >
              Next
            </Link>

            <span style={{ marginLeft: 16, color: "#5c5f62", fontSize: 14 }}>
              Page {currentPage} of {totalPages} ({totalCount} companies)
            </span>
          </div>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
