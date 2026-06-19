import type React from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import type { Prisma } from "@prisma/client";
import prisma from "app/db.server";
import { getAdminForShop } from "app/shopify.server";
import {
  SalesPortalHeader,
  SalesPortalLayout,
  salesPortalButtonStyles,
} from "app/components/SalesPortalLayout";
import {
  buildClearSessionCookie,
  requireSalesSession,
} from "app/utils/sales-session.server";
import {
  getAccessibleOrder,
  getOrderAccessWhere,
  getOrderNumber,
  getSalesOrderAccessLevel,
  getShopifyOrderWhere,
} from "app/services/sales-order-management.server";
import {
  assertNoShopifyUserErrors,
  shopifyOrderGraphql,
} from "app/services/shopify-order-creation.server";
import { restoreCredit } from "app/services/creditService";

function draftWhere(): Prisma.B2BOrderWhereInput {
  return {
    orderStatus: "draft",
    NOT: getShopifyOrderWhere(),
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { user } = await requireSalesSession(request);
  const url = new URL(request.url);
  const search = (url.searchParams.get("search") || "").trim();
  const companyId = url.searchParams.get("company") || "";
  const accessLevel = getSalesOrderAccessLevel(user);
  const accessWhere = getOrderAccessWhere(user);
  const draftAccessWhere: Prisma.B2BOrderWhereInput = {
    companyId: { in: user.salesCompanies.map((item) => item.companyId) },
    orderStatus: { notIn: ["converted", "archived"] },
  };

  const filters: Prisma.B2BOrderWhereInput[] = [draftWhere()];
  if (companyId) filters.push({ companyId });
  if (search) {
    filters.push({
      OR: [
        { orderNumber: { contains: search, mode: "insensitive" } },
        { shopifyOrderId: { contains: search, mode: "insensitive" } },
        { customerName: { contains: search, mode: "insensitive" } },
        { customerEmail: { contains: search, mode: "insensitive" } },
        { company: { name: { contains: search, mode: "insensitive" } } },
      ],
    });
  }

  const where: Prisma.B2BOrderWhereInput = {
    AND: [draftAccessWhere, ...filters],
  };
  const draftBaseWhere: Prisma.B2BOrderWhereInput = {
    AND: [draftAccessWhere, draftWhere()],
  };
  const orderBaseWhere: Prisma.B2BOrderWhereInput = {
    AND: [accessWhere, getShopifyOrderWhere()],
  };

  const [drafts, draftCount, orderCount, quoteCount, companies] =
    await Promise.all([
      prisma.b2BOrder.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        take: 250,
        include: {
          company: { select: { id: true, name: true } },
          createdByUser: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
          items: { select: { quantity: true } },
        },
      }),
      prisma.b2BOrder.count({ where: draftBaseWhere }),
      prisma.b2BOrder.count({ where: orderBaseWhere }),
      prisma.quote.count({
        where: {
          companyId: { in: user.salesCompanies.map((item) => item.companyId) },
          ...(accessLevel === "agent" ? { salesAgentId: user.id } : {}),
        },
      }),
      Promise.resolve(
        user.salesCompanies.map((item) => ({
          id: item.company.id,
          name: item.company.name,
        })),
      ),
    ]);

  if (!companies.length) return redirect("/sales/portal");
  const currentCompany =
    companies.find((company) => company.id === companyId) || companies[0];

  return Response.json({
    user: {
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
    },
    currentCompany,
    companies,
    counts: { drafts: draftCount, orders: orderCount, quotes: quoteCount },
    filters: { search, companyId },
    drafts: drafts.map((draft) => ({
      id: draft.id,
      orderNumber: getOrderNumber(draft),
      shopifyOrderId: draft.shopifyOrderId,
      customerName: draft.customerName,
      customerEmail: draft.customerEmail,
      company: draft.company,
      salesAgent: draft.createdByUser,
      itemCount: draft.items.length,
      quantity: draft.items.reduce((sum, item) => sum + item.quantity, 0),
      orderTotal: draft.orderTotal.toString(),
      currencyCode: draft.currencyCode,
      paymentStatus: draft.paymentStatus,
      orderStatus: draft.orderStatus,
      createdAt: draft.createdAt.toISOString(),
      updatedAt: draft.updatedAt.toISOString(),
    })),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { user } = await requireSalesSession(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "logout") {
    return redirect("/sales/login", {
      headers: { "Set-Cookie": buildClearSessionCookie() },
    });
  }

  if (intent !== "delete_draft") {
    return Response.json({ error: "Unknown action" }, { status: 400 });
  }

  const draftId = String(formData.get("draftId") || "");
  if (!draftId) {
    return Response.json({ error: "Draft not found." }, { status: 404 });
  }

  const draft = await getAccessibleOrder(user, draftId);
  if (!draft || draft.orderStatus !== "draft") {
    return Response.json({ error: "Draft not found." }, { status: 404 });
  }

  try {
    const admin = draft.company.shop.accessToken
      ? await getAdminForShop(draft.company.shop.shopDomain)
      : undefined;

    if (
      draft.shopifyOrderId &&
      admin &&
      !draft.shopifyOrderId.startsWith("gid://shopify/Order/")
    ) {
      const draftOrderId = draft.shopifyOrderId.startsWith("gid://")
        ? draft.shopifyOrderId
        : `gid://shopify/DraftOrder/${draft.shopifyOrderId}`;
      const deleteData = await shopifyOrderGraphql<{
        draftOrderDelete: {
          deletedId: string | null;
          userErrors: Array<{ field?: string[] | null; message: string }>;
        };
      }>({
        admin,
        operation: "DeleteSalesPortalDraftOrder",
        query: `#graphql
          mutation DeleteSalesPortalDraftOrder($input: DraftOrderDeleteInput!) {
            draftOrderDelete(input: $input) {
              deletedId
              userErrors { field message }
            }
          }
        `,
        variables: { input: { id: draftOrderId } },
      });
      assertNoShopifyUserErrors(
        "DeleteSalesPortalDraftOrder",
        deleteData.draftOrderDelete.userErrors,
      );
    }

    if (
      ["pending", "partial"].includes(draft.paymentStatus) &&
      draft.remainingBalance.greaterThan(0)
    ) {
      await restoreCredit(
        draft.companyId,
        draft.id,
        draft.remainingBalance,
        user.id,
        "cancelled",
        admin as any,
      );
    }

    const draftIdentifiers = [
      draft.id,
      draft.shopifyOrderId,
      draft.shopifyOrderId?.split("/").pop(),
    ].filter(Boolean) as string[];

    await prisma.creditTransaction.deleteMany({
      where: { companyId: draft.companyId, orderId: { in: draftIdentifiers } },
    });

    if (draft.shopifyOrderId) {
      const numericShopifyId = draft.shopifyOrderId.split("/").pop();
      await prisma.notification.deleteMany({
        where: {
          shopifyOrderId: {
            in: [draft.shopifyOrderId, numericShopifyId].filter(
              Boolean,
            ) as string[],
          },
        },
      });
    }

    await prisma.b2BOrder.delete({ where: { id: draft.id } });
  } catch (error) {
    console.error("[sales-draft] delete failed", {
      draftId: draft.id,
      shopifyOrderId: draft.shopifyOrderId,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Draft delete failed.",
      },
      { status: 400 },
    );
  }

  const redirectUrl = new URL(request.url);
  redirectUrl.searchParams.set("deletedDraft", getOrderNumber(draft));
  return redirect(`${redirectUrl.pathname}${redirectUrl.search}`);
};

export default function DraftListPage() {
  const data = useLoaderData<any>();
  const actionData = useActionData<any>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const deletedDraft =
    typeof window === "undefined"
      ? ""
      : new URLSearchParams(window.location.search).get("deletedDraft");

  const money = (amount: string | number, currency = "USD") =>
    new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
      Number(amount) || 0,
    );
  const date = (value: string) =>
    new Intl.DateTimeFormat("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(new Date(value));
  const agentName = (agent: any) =>
    [agent.firstName, agent.lastName].filter(Boolean).join(" ") ||
    agent.email;

  return (
    <SalesPortalLayout
      company={data.currentCompany}
      user={data.user}
      activePage="drafts"
      orderCount={data.counts.orders}
      draftCount={data.counts.drafts}
      quoteCount={data.counts.quotes}
    >
      <SalesPortalHeader
        title="Drafts"
        subtitle="Review, open, or delete draft order records."
        companyId={data.currentCompany.id}
        companies={data.companies}
        actions={
          <Link
            to={`/sales/portal/company/${data.currentCompany.id}/create-order`}
            style={salesPortalButtonStyles.primary}
          >
            + Create Order
          </Link>
        }
      />

      {deletedDraft && (
        <div style={styles.successBanner}>{deletedDraft} was deleted.</div>
      )}
      {actionData?.error && (
        <div style={styles.errorBanner}>{actionData.error}</div>
      )}

      <Form method="get" className="draft-filter-grid" style={styles.filters}>
        <input
          name="search"
          defaultValue={data.filters.search}
          placeholder="Search draft, customer, company, or email"
          style={styles.input}
        />
        <select
          name="company"
          defaultValue={data.filters.companyId}
          style={styles.input}
        >
          <option value="">All companies</option>
          {data.companies.map((company: any) => (
            <option key={company.id} value={company.id}>
              {company.name}
            </option>
          ))}
        </select>
        <button style={styles.filterButton}>Apply Filters</button>
        <Link to="/sales/portal/drafts" style={styles.clearButton}>
          Clear
        </Link>
      </Form>

      <div className="sales-draft-table-wrap" style={styles.tableCard}>
        <table style={styles.table}>
          <thead>
            <tr>
              {[
                "Draft",
                "Customer",
                "Company",
                "Sales Agent",
                "Items",
                "Quantity",
                "Total",
                "Updated",
                "Actions",
              ].map((heading) => (
                <th key={heading} style={styles.th}>
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.drafts.map((draft: any) => (
              <tr key={draft.id} style={styles.tr}>
                <td style={styles.td}>
                  <Link
                    to={`/sales/portal/drafts/${draft.id}`}
                    style={styles.draftLink}
                  >
                    {draft.orderNumber}
                  </Link>
                  <small style={styles.secondaryText}>
                    {draft.shopifyOrderId || `Local ${draft.id.slice(-8)}`}
                  </small>
                </td>
                <td style={styles.td}>
                  <strong>{draft.customerName || "Not captured"}</strong>
                  <small style={styles.secondaryText}>
                    {draft.customerEmail || "No email"}
                  </small>
                </td>
                <td style={styles.td}>{draft.company.name}</td>
                <td style={styles.td}>{agentName(draft.salesAgent)}</td>
                <td style={styles.td}>{draft.itemCount}</td>
                <td style={styles.td}>{draft.quantity}</td>
                <td style={styles.td}>
                  <strong>{money(draft.orderTotal, draft.currencyCode)}</strong>
                </td>
                <td style={styles.td}>{date(draft.updatedAt)}</td>
                <td style={styles.td}>
                  <div style={styles.rowActions}>
                    <Link
                      to={`/sales/portal/drafts/${draft.id}`}
                      style={styles.actionLink}
                    >
                      View
                    </Link>
                    <Form
                      method="post"
                      style={styles.inlineForm}
                      onSubmit={(event) => {
                        if (
                          !confirm(
                            `Delete draft ${draft.orderNumber} from the Sales Portal?`,
                          )
                        ) {
                          event.preventDefault();
                        }
                      }}
                    >
                      <input type="hidden" name="intent" value="delete_draft" />
                      <input type="hidden" name="draftId" value={draft.id} />
                      <button
                        type="submit"
                        disabled={busy}
                        style={styles.deleteButton}
                      >
                        Delete
                      </button>
                    </Form>
                  </div>
                </td>
              </tr>
            ))}
            {!data.drafts.length && (
              <tr>
                <td colSpan={9} style={styles.empty}>
                  No drafts match the selected filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <style>{responsiveCss}</style>
    </SalesPortalLayout>
  );
}

const responsiveCss = `
  .sales-draft-table-wrap { overflow-x: auto; }
  @media (max-width: 760px) {
    .draft-filter-grid { grid-template-columns: minmax(0, 1fr) !important; }
  }
`;

const styles: Record<string, React.CSSProperties> = {
  successBanner: {
    marginBottom: 16,
    padding: 12,
    border: "1px solid #a7f3d0",
    borderRadius: 8,
    background: "#ecfdf5",
    color: "#065f46",
    fontSize: 13,
  },
  errorBanner: {
    marginBottom: 16,
    padding: 12,
    border: "1px solid #fecaca",
    borderRadius: 8,
    background: "#fef2f2",
    color: "#991b1b",
    fontSize: 13,
  },
  filters: {
    display: "grid",
    gridTemplateColumns: "minmax(240px, 1fr) 220px auto auto",
    gap: 12,
    marginBottom: 20,
    alignItems: "center",
  },
  input: {
    width: "100%",
    border: "1px solid #d1d5db",
    borderRadius: 8,
    padding: "10px 12px",
    minHeight: 40,
    font: "inherit",
    background: "#fff",
  },
  filterButton: {
    minHeight: 40,
    border: "1px solid #111827",
    borderRadius: 8,
    background: "#111827",
    color: "#fff",
    padding: "0 16px",
    fontWeight: 600,
    cursor: "pointer",
  },
  clearButton: {
    minHeight: 40,
    border: "1px solid #d1d5db",
    borderRadius: 8,
    background: "#fff",
    color: "#374151",
    padding: "10px 16px",
    fontWeight: 600,
    textDecoration: "none",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  },
  tableCard: {
    background: "#fff",
    border: "1px solid #e1e3e5",
    borderRadius: 8,
    overflow: "hidden",
  },
  table: { width: "100%", borderCollapse: "collapse" },
  th: {
    textAlign: "left",
    color: "#6d7175",
    fontSize: 12,
    fontWeight: 600,
    padding: "12px 14px",
    borderBottom: "1px solid #e1e3e5",
    whiteSpace: "nowrap",
    background: "#f9fafb",
  },
  tr: { borderBottom: "1px solid #f1f1f1" },
  td: {
    padding: "14px",
    verticalAlign: "top",
    fontSize: 13,
    color: "#202223",
  },
  draftLink: { color: "#2c6ecb", fontWeight: 700, textDecoration: "none" },
  secondaryText: {
    display: "block",
    color: "#6d7175",
    marginTop: 4,
    fontSize: 12,
  },
  rowActions: {
    display: "flex",
    gap: 8,
    alignItems: "center",
    whiteSpace: "nowrap",
  },
  actionLink: {
    color: "#2c6ecb",
    textDecoration: "none",
    fontWeight: 600,
  },
  inlineForm: { display: "inline" },
  deleteButton: {
    border: "1px solid #fecaca",
    borderRadius: 6,
    background: "#fff",
    color: "#b91c1c",
    padding: "6px 10px",
    cursor: "pointer",
    fontWeight: 600,
  },
  empty: {
    padding: 32,
    textAlign: "center",
    color: "#6d7175",
    fontSize: 14,
  },
};
