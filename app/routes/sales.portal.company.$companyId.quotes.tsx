import nodeCrypto from "node:crypto";
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
import prisma from "app/db.server";
import {
  buildClearSessionCookie,
  hasCompanyAccess,
  requireSalesSession,
} from "app/utils/sales-session.server";
import {
  convertQuoteToOrder,
  logQuoteActivity,
  sendQuoteToCustomer,
} from "app/services/quote.server";
import {
  SalesPortalHeader,
  SalesPortalLayout,
  salesPortalButtonStyles,
} from "app/components/SalesPortalLayout";

const editableStatuses = ["draft", "sent", "viewed", "approved"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { user } = await requireSalesSession(request);

  const url = new URL(request.url);
  const companyIdParam = url.searchParams.get("company") || "";
  const status = url.searchParams.get("status") || "";
  const customer = url.searchParams.get("customer") || "";
  const agent = url.searchParams.get("agent") || "";
  const dateFrom = url.searchParams.get("dateFrom") || "";
  const dateTo = url.searchParams.get("dateTo") || "";

  const companies = user.salesCompanies.map((sc) => ({
    id: sc.company.id,
    name: sc.company.name,
  }));
  const headerCompanies =
    companies.length > 1 ? [{ id: "all", name: "All companies" }, ...companies] : companies;

  if (!companies.length) return redirect("/sales/portal");

  const selectedCompanyId =
    companyIdParam || (companies.length > 1 ? "all" : companies[0].id);

  const currentCompany =
    selectedCompanyId === "all"
      ? { id: "all", name: "All companies" }
      : companies.find((c) => c.id === selectedCompanyId) || companies[0];

  const filterCompanyId =
    selectedCompanyId === "all"
      ? { in: user.salesCompanies.map((sc) => sc.companyId) }
      : selectedCompanyId;

  const companyIdsForQuery =
    selectedCompanyId === "all"
      ? user.salesCompanies.map((sc) => sc.companyId)
      : [selectedCompanyId];

  await prisma.quote.updateMany({
    where: {
      companyId: { in: companyIdsForQuery },
      status: { in: ["draft", "sent", "viewed"] },
      expiresAt: { lt: new Date() },
    },
    data: { status: "expired" },
  });

  const themeCompanyId =
    selectedCompanyId === "all" ? companies[0].id : selectedCompanyId;
  const companyDetails = await prisma.companyAccount.findUnique({
    where: { id: themeCompanyId },
    select: { shop: { select: { themeColor: true } } },
  });

  const where: any = { companyId: filterCompanyId };
  if (status) where.status = status;
  if (customer) {
    where.OR = [
      { customerEmail: { contains: customer, mode: "insensitive" } },
      { customerFirstName: { contains: customer, mode: "insensitive" } },
      { customerLastName: { contains: customer, mode: "insensitive" } },
    ];
  }
  if (agent) where.salesAgentId = agent;
  if (dateFrom || dateTo) {
    where.createdAt = {};
    if (dateFrom) where.createdAt.gte = new Date(dateFrom);
    if (dateTo) {
      const end = new Date(dateTo);
      end.setHours(23, 59, 59, 999);
      where.createdAt.lte = end;
    }
  }

  const companyAccessFilter =
    selectedCompanyId === "all"
      ? { some: { companyId: { in: companyIdsForQuery } } }
      : { some: { companyId: selectedCompanyId } };

  const [quotes, agents, quoteCount, orderCount] = await Promise.all([
    prisma.quote.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        salesAgent: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        company: { select: { id: true, name: true } },
      },
    }),
    prisma.user.findMany({
      where: {
        role: "SALES_USER",
        salesCompanies: companyAccessFilter,
      },
      select: { id: true, firstName: true, lastName: true, email: true },
      orderBy: { firstName: "asc" },
    }),
    prisma.quote.count({
      where: { companyId: filterCompanyId },
    }),
    prisma.b2BOrder.count({
      where: {
        companyId: filterCompanyId,
        orderStatus: { notIn: ["converted", "archived"] },
      },
    }),
  ]);

  return Response.json({
    currentCompany: {
      ...currentCompany,
      themeColor: companyDetails?.shop.themeColor ?? null,
    },
    user: {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
    },
    companies: headerCompanies,
    agents,
    quoteCount,
    orderCount,
    filters: {
      status,
      customer,
      agent,
      dateFrom,
      dateTo,
      companyId: selectedCompanyId,
    },
    themeCompanyId,
    quotes: quotes.map((quote) => ({
      ...quote,
      subtotal: quote.subtotal.toString(),
      totalAmount: quote.totalAmount.toString(),
      expiresAt: quote.expiresAt.toISOString(),
      createdAt: quote.createdAt.toISOString(),
    })),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { user } = await requireSalesSession(request);

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const quoteId = String(formData.get("quoteId") || "");

  if (intent === "logout") {
    return redirect("/sales/login", {
      headers: { "Set-Cookie": buildClearSessionCookie() },
    });
  }

  const quote = quoteId
    ? await prisma.quote.findFirst({
        where: { id: quoteId, companyId: { in: user.salesCompanies.map((sc) => sc.companyId) } },
        include: { items: true },
      })
    : null;
  if (!quote) {
    return Response.json({ error: "Quote not found" }, { status: 404 });
  }

  try {
    if (intent === "send_quote" || intent === "resend_quote") {
      const result = await sendQuoteToCustomer({
        quoteId,
        request,
        userId: user.id,
      });
      return Response.json({
        success: true,
        message: `Quote sent. Link: ${result.quoteUrl}`,
      });
    }

    if (intent === "cancel_quote") {
      await prisma.quote.update({
        where: { id: quoteId },
        data: { status: "cancelled", cancelledAt: new Date() },
      });
      await logQuoteActivity({
        quoteId,
        userId: user.id,
        companyId: quote.companyId,
        customerEmail: quote.customerEmail,
        action: "Quote Cancelled",
      });
      return Response.json({ success: true, message: "Quote cancelled." });
    }

    if (intent === "delete_quote") {
      await prisma.quote.delete({ where: { id: quoteId } });
      return Response.json({ success: true, message: "Quote deleted." });
    }

    if (intent === "duplicate_quote") {
      const duplicate = await prisma.quote.create({
        data: {
          quoteNumber: `${quote.quoteNumber}-COPY-${Date.now().toString().slice(-4)}`,
          shopId: quote.shopId,
          companyId: quote.companyId,
          salesAgentId: user.id,
          title: `${quote.title} Copy`,
          status: "draft",
          secureToken: nodeCrypto.randomBytes(24).toString("hex"),
          customerUserId: quote.customerUserId,
          customerShopifyId: quote.customerShopifyId,
          customerEmail: quote.customerEmail,
          customerFirstName: quote.customerFirstName,
          customerLastName: quote.customerLastName,
          currencyCode: quote.currencyCode,
          subtotal: quote.subtotal,
          discountAmount: quote.discountAmount,
          discountType: quote.discountType,
          discountTotal: quote.discountTotal,
          shippingAmount: quote.shippingAmount,
          taxRate: quote.taxRate,
          taxAmount: quote.taxAmount,
          totalAmount: quote.totalAmount,
          customerNotes: quote.customerNotes,
          internalNotes: quote.internalNotes,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          items: {
            create: quote.items.map((item) => ({
              productId: item.productId,
              productTitle: item.productTitle,
              variantId: item.variantId,
              variantTitle: item.variantTitle,
              sku: item.sku,
              image: item.image,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              discount: item.discount,
              totalPrice: item.totalPrice,
              currencyCode: item.currencyCode,
            })),
          },
        },
      });
      await logQuoteActivity({
        quoteId: duplicate.id,
        userId: user.id,
        companyId: quote.companyId,
        customerEmail: duplicate.customerEmail,
        action: "Quote Created",
        message: `Duplicated from ${quote.quoteNumber}.`,
      });
      return redirect(
        `/sales/portal/quotes/${duplicate.id}`,
      );
    }

    if (intent === "convert_quote") {
      const result = await convertQuoteToOrder({
        quoteId,
        salesAgentId: user.id,
      });
      return Response.json({
        success: true,
        message: `Quote converted to order ${result.shopifyOrder.name || result.shopifyOrder.id}.`,
      });
    }
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Quote action failed" },
      { status: 400 },
    );
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
};

export default function QuoteListingPage() {
  const {
    currentCompany,
    user,
    companies,
    agents,
    filters,
    quotes,
    quoteCount,
    orderCount,
    themeCompanyId,
  } = useLoaderData<any>();
  const safeCompany =
    currentCompany ?? { id: "all", name: "All companies", themeColor: null, storeName: "" };
  const actionData = useActionData<any>();
  const navigation = useNavigation();

  const fmtMoney = (amount: string, currency: string) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
    }).format(Number(amount) || 0);
  const fmtDate = (iso: string) =>
    new Intl.DateTimeFormat("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(new Date(iso));
  const badge = (status: string) => {
    const colors: Record<string, string> = {
      draft: "#6b21a8",
      sent: "#0369a1",
      viewed: "#1d4ed8",
      approved: "#166534",
      rejected: "#991b1b",
      expired: "#92400e",
      converted: "#334155",
      cancelled: "#6b7280",
    };
    return (
      <span style={{ ...styles.badge, color: colors[status] || "#374151" }}>
        {status.replace(/_/g, " ")}
      </span>
    );
  };

  const hasActiveFilters =
    filters.customer ||
    filters.status ||
    filters.agent ||
    filters.dateFrom ||
    filters.dateTo ||
    (filters.companyId && filters.companyId !== "all" && companies.length > 1);

  return (
    <SalesPortalLayout
      company={safeCompany}
      user={user}
      activePage="quotes"
      orderCount={orderCount}
      quoteCount={quoteCount}
      themeColor={safeCompany.themeColor}
    >
      <SalesPortalHeader
        title="Quotes"
        subtitle={
          safeCompany.id === "all"
            ? "Create, send, track, and convert customer quotes across all companies."
            : `Create, send, track, and convert customer quotes for ${safeCompany.name}.`
        }
        companyId={safeCompany.id}
        companies={companies}
        companySwitchPath="/sales/portal/quotes?company="
        actions={
          <Link
            to={`/sales/portal/company/${themeCompanyId ?? safeCompany.id}/create-quote`}
            style={salesPortalButtonStyles.primary}
          >
            + Create Quote
          </Link>
        }
      />

      {actionData?.error && <div style={styles.error}>{actionData.error}</div>}
      {actionData?.success && (
        <div style={styles.success}>{actionData.message}</div>
      )}

      <Form method="get" className="sales-quote-filters" style={styles.filters}>
        {companies.length > 1 && (
          <select
            name="company"
            defaultValue={filters.companyId}
            style={styles.input}
          >
            <option value="all">All companies</option>
            {companies.map((company: any) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </select>
        )}
        <input
          name="customer"
          placeholder="Customer"
          defaultValue={filters.customer}
          style={styles.input}
        />
        <select
          name="status"
          defaultValue={filters.status}
          style={styles.input}
        >
          <option value="">All statuses</option>
          {[
            "draft",
            "sent",
            "viewed",
            "approved",
            "rejected",
            "expired",
            "converted",
            "cancelled",
          ].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select name="agent" defaultValue={filters.agent} style={styles.input}>
          <option value="">All agents</option>
          {agents.map((agent: any) => (
            <option key={agent.id} value={agent.id}>
              {agent.firstName || agent.email} {agent.lastName || ""}
            </option>
          ))}
        </select>
        <input
          type="date"
          name="dateFrom"
          defaultValue={filters.dateFrom}
          style={styles.input}
        />
        <input
          type="date"
          name="dateTo"
          defaultValue={filters.dateTo}
          style={styles.input}
        />
        <button style={styles.secondaryBtn}>Filter</button>
        {hasActiveFilters && (
          <Link to="/sales/portal/quotes" style={styles.clearBtn}>
            Clear
          </Link>
        )}
      </Form>

      <div
        className="sales-quote-card sales-quote-table-wrap"
        style={styles.card}
      >
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Quote Number</th>
              <th style={styles.th}>Customer</th>
              <th style={styles.th}>Company</th>
              <th style={styles.th}>Total</th>
              <th style={styles.th}>Status</th>
              <th style={styles.th}>Created</th>
              <th style={styles.th}>Expiration</th>
              <th style={styles.th}>Sales Agent</th>
              <th style={{ ...styles.th, textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {quotes.map((quote: any) => (
              <tr key={quote.id} className="sales-quote-row">
                <td style={styles.td}>
                  <Link
                    to={`/sales/portal/quotes/${quote.id}`}
                    style={styles.link}
                  >
                    {quote.quoteNumber}
                  </Link>
                </td>
                <td style={styles.td}>
                  {quote.customerFirstName || ""} {quote.customerLastName || ""}
                  <br />
                  <small>{quote.customerEmail}</small>
                </td>
                <td style={styles.td}>{quote.company?.name || safeCompany.name}</td>
                <td style={styles.td}>
                  <strong>
                    {fmtMoney(quote.totalAmount, quote.currencyCode)}
                  </strong>
                </td>
                <td style={styles.td}>{badge(quote.status)}</td>
                <td style={styles.td}>{fmtDate(quote.createdAt)}</td>
                <td style={styles.td}>{fmtDate(quote.expiresAt)}</td>
                <td style={styles.td}>
                  {quote.salesAgent?.firstName || quote.salesAgent?.email}
                </td>
                <td style={{ ...styles.td, textAlign: "right" }}>
                  <div style={styles.actions}>
                    <Link
                      to={`/sales/portal/quotes/${quote.id}`}
                      style={styles.smallLink}
                    >
                      View
                    </Link>
                    {/* <QuoteAction
                      quoteId={quote.id}
                      intent="send_quote"
                      label={quote.status === "draft" ? "Send" : "Resend"}
                      disabled={navigation.state !== "idle"}
                    /> */}
                    {/* <QuoteAction
                      quoteId={quote.id}
                      intent="duplicate_quote"
                      label="Duplicate"
                    />
                    {quote.status === "approved" && (
                      <QuoteAction
                        quoteId={quote.id}
                        intent="convert_quote"
                        label="Convert"
                      />
                    )}
                    {editableStatuses.includes(quote.status) && (
                      <QuoteAction
                        quoteId={quote.id}
                        intent="cancel_quote"
                        label="Cancel"
                      />
                    )} */}
                    <QuoteAction
                      quoteId={quote.id}
                      intent="delete_quote"
                      label="Delete"
                      danger
                    />
                  </div>
                </td>
              </tr>
            ))}
            {!quotes.length && (
              <tr>
                <td colSpan={9} style={styles.empty}>
                  No quotes found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </SalesPortalLayout>
  );
}

function QuoteAction({
  quoteId,
  intent,
  label,
  danger,
  disabled,
}: {
  quoteId: string;
  intent: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <Form method="post" style={{ display: "inline" }}>
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="quoteId" value={quoteId} />
      <button
        disabled={disabled}
        style={{ ...styles.actionBtn, color: danger ? "#b91c1c" : "var(--sales-portal-accent)" }}
      >
        {label}
      </button>
    </Form>
  );
}

const styles: Record<string, React.CSSProperties> = {
  primaryBtn: {
    display: "inline-flex",
    alignItems: "center",
    background: "var(--sales-portal-accent)",
    color: "var(--sales-portal-accent-contrast)",
    padding: "10px 18px",
    borderRadius: 8,
    textDecoration: "none",
    fontWeight: 600,
    fontSize: 14,
    border: "none",
    cursor: "pointer",
  },
  secondaryBtn: {
    background: "var(--sales-portal-accent-lighter)",
    color: "var(--sales-portal-accent-dark)",
    padding: "9px 12px",
    borderRadius: 8,
    border: "1px solid var(--sales-portal-accent-tint)",
    fontWeight: 700,
    cursor: "pointer",
  },
  clearBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--sales-portal-accent-dark)",
    textDecoration: "none",
    fontSize: 13,
    fontWeight: 600,
  },
  filters: {
    display: "grid",
    gridTemplateColumns:
      "minmax(180px, 1.2fr) minmax(140px, 1fr) minmax(140px, 1fr) 150px 150px auto auto",
    gap: 10,
    marginBottom: 18,
    padding: 16,
    background: "#fff",
    border: "1px solid #eaeaea",
    borderRadius: 8,
  },
  input: {
    width: "100%",
    height: 40,
    border: "1px solid #c9cccf",
    borderRadius: 8,
    padding: "0 11px",
    background: "#fff",
    color: "#202223",
    font: "inherit",
    fontSize: 13,
  },
  card: {
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: 8,
    overflow: "auto",
  },
  table: { width: "100%", borderCollapse: "collapse" },
  th: {
    textAlign: "left",
    fontSize: 12,
    color: "#6b7280",
    padding: "12px 14px",
    borderBottom: "1px solid #e5e7eb",
    whiteSpace: "nowrap",
  },
  td: {
    padding: "12px 14px",
    borderBottom: "1px solid #f3f4f6",
    fontSize: 13,
    verticalAlign: "middle",
  },
  link: { color: "var(--sales-portal-accent)", fontWeight: 700, textDecoration: "none" },
  smallLink: { color: "var(--sales-portal-accent)", textDecoration: "none", fontWeight: 600 },
  badge: {
    background: "#f4f6f8",
    borderRadius: 8,
    padding: "4px 9px",
    fontSize: 12,
    fontWeight: 700,
    textTransform: "capitalize",
  },
  actions: {
    display: "flex",
    gap: 8,
    justifyContent: "flex-end",
    flexWrap: "wrap",
  },
  actionBtn: {
    border: "none",
    background: "transparent",
    cursor: "pointer",
    fontWeight: 700,
    padding: 0,
  },
  actionLink: {
    color: "var(--sales-portal-accent)",
    textDecoration: "none",
    fontWeight: 700,
  },
  error: {
    background: "#fef2f2",
    color: "#991b1b",
    border: "1px solid #fecaca",
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  success: {
    background: "#ecfdf5",
    color: "#065f46",
    border: "1px solid #a7f3d0",
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  empty: { padding: 28, color: "#6b7280", textAlign: "center" },
};
