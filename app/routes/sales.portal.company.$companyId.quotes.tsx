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

const editableStatuses = ["draft"];

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { user } = await requireSalesSession(request);
  const companyId = params.companyId;
  if (!companyId || !hasCompanyAccess(user, companyId)) {
    return redirect("/sales/portal");
  }

  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "";
  const customer = url.searchParams.get("customer") || "";
  const agent = url.searchParams.get("agent") || "";
  const dateFrom = url.searchParams.get("dateFrom") || "";
  const dateTo = url.searchParams.get("dateTo") || "";

  await prisma.quote.updateMany({
    where: {
      companyId,
      status: { in: ["draft", "sent", "viewed"] },
      expiresAt: { lt: new Date() },
    },
    data: { status: "expired" },
  });

  const company = await prisma.companyAccount.findUnique({
    where: { id: companyId },
    include: { shop: { select: { shopName: true, shopDomain: true } } },
  });
  if (!company) {
    return redirect("/sales/portal");
  }

  const where: any = { companyId };
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

  const [quotes, agents] = await Promise.all([
    prisma.quote.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        salesAgent: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    }),
    prisma.user.findMany({
      where: {
        role: "SALES_USER",
        salesCompanies: { some: { companyId } },
      },
      select: { id: true, firstName: true, lastName: true, email: true },
      orderBy: { firstName: "asc" },
    }),
  ]);

  return Response.json({
    company: {
      id: company.id,
      name: company.name,
      storeName: company.shop.shopName || company.shop.shopDomain,
    },
    user: {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
    },
    allCompanies: user.salesCompanies.map((sc) => ({
      id: sc.company.id,
      name: sc.company.name,
    })),
    agents,
    filters: { status, customer, agent, dateFrom, dateTo },
    quotes: quotes.map((quote) => ({
      ...quote,
      subtotal: quote.subtotal.toString(),
      totalAmount: quote.totalAmount.toString(),
      expiresAt: quote.expiresAt.toISOString(),
      createdAt: quote.createdAt.toISOString(),
    })),
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { user } = await requireSalesSession(request);
  const companyId = params.companyId;
  if (!companyId || !hasCompanyAccess(user, companyId)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

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
        where: { id: quoteId, companyId },
        include: { items: true },
      })
    : null;
  if (!quote) {
    return Response.json({ error: "Quote not found" }, { status: 404 });
  }

  try {
    if (intent === "send_quote" || intent === "resend_quote") {
      const result = await sendQuoteToCustomer({ quoteId, request, userId: user.id });
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
        companyId,
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
        companyId,
        customerEmail: duplicate.customerEmail,
        action: "Quote Created",
        message: `Duplicated from ${quote.quoteNumber}.`,
      });
      return redirect(`/sales/portal/company/${companyId}/quotes/${duplicate.id}`);
    }

    if (intent === "convert_quote") {
      const result = await convertQuoteToOrder({ quoteId, salesAgentId: user.id });
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
  const { company, user, allCompanies, agents, filters, quotes } =
    useLoaderData<any>();
  const actionData = useActionData<any>();
  const navigation = useNavigation();

  const fmtMoney = (amount: string, currency = "USD") =>
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

  return (
    <div style={styles.shell}>
      <aside style={styles.sidebar}>
        <div style={styles.logo}>SmartB2B</div>
        <div style={styles.companyBox}>
          <span style={styles.kicker}>Current Company</span>
          <strong>{company.name}</strong>
          <small>{company.storeName}</small>
        </div>
        <nav style={styles.nav}>
          <Link to={`/sales/portal?companyId=${company.id}`} style={styles.navItem}>Overview</Link>
          <Link to={`/sales/portal/company/${company.id}/orders`} style={styles.navItem}>Orders</Link>
          <Link to={`/sales/portal/company/${company.id}/quotes`} style={{ ...styles.navItem, ...styles.activeNav }}>Quotes</Link>
        </nav>
        {allCompanies.length > 1 && (
          <div style={styles.switcher}>
            {allCompanies.filter((c: any) => c.id !== company.id).map((c: any) => (
              <Link key={c.id} to={`/sales/portal?companyId=${c.id}`} style={styles.companyLink}>{c.name}</Link>
            ))}
          </div>
        )}
        <div style={styles.sidebarFooter}>
          <span>{user.firstName || user.email}</span>
          <Form method="post">
            <input type="hidden" name="intent" value="logout" />
            <button style={styles.secondaryBtn}>Sign Out</button>
          </Form>
        </div>
      </aside>

      <main style={styles.main}>
        <header style={styles.header}>
          <div>
            <h1 style={styles.title}>Quotes</h1>
            <p style={styles.subtitle}>Create, send, track, and convert customer quotes for {company.name}.</p>
          </div>
          <Link to={`/sales/portal/company/${company.id}/create-quote`} style={styles.primaryBtn}>Create Quote</Link>
        </header>

        {actionData?.error && <div style={styles.error}>{actionData.error}</div>}
        {actionData?.success && <div style={styles.success}>{actionData.message}</div>}

        <Form method="get" style={styles.filters}>
          <input name="customer" placeholder="Customer" defaultValue={filters.customer} style={styles.input} />
          <select name="status" defaultValue={filters.status} style={styles.input}>
            <option value="">All statuses</option>
            {["draft", "sent", "viewed", "approved", "rejected", "expired", "converted", "cancelled"].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select name="agent" defaultValue={filters.agent} style={styles.input}>
            <option value="">All agents</option>
            {agents.map((agent: any) => (
              <option key={agent.id} value={agent.id}>{agent.firstName || agent.email} {agent.lastName || ""}</option>
            ))}
          </select>
          <input type="date" name="dateFrom" defaultValue={filters.dateFrom} style={styles.input} />
          <input type="date" name="dateTo" defaultValue={filters.dateTo} style={styles.input} />
          <button style={styles.secondaryBtn}>Filter</button>
        </Form>

        <div style={styles.card}>
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
                <tr key={quote.id}>
                  <td style={styles.td}><Link to={`/sales/portal/company/${company.id}/quotes/${quote.id}`} style={styles.link}>{quote.quoteNumber}</Link></td>
                  <td style={styles.td}>{quote.customerFirstName || ""} {quote.customerLastName || ""}<br /><small>{quote.customerEmail}</small></td>
                  <td style={styles.td}>{company.name}</td>
                  <td style={styles.td}><strong>{fmtMoney(quote.totalAmount, quote.currencyCode)}</strong></td>
                  <td style={styles.td}>{badge(quote.status)}</td>
                  <td style={styles.td}>{fmtDate(quote.createdAt)}</td>
                  <td style={styles.td}>{fmtDate(quote.expiresAt)}</td>
                  <td style={styles.td}>{quote.salesAgent?.firstName || quote.salesAgent?.email}</td>
                  <td style={{ ...styles.td, textAlign: "right" }}>
                    <div style={styles.actions}>
                      <Link to={`/sales/portal/company/${company.id}/quotes/${quote.id}`} style={styles.smallLink}>View</Link>
                      <QuoteAction quoteId={quote.id} intent="send_quote" label={quote.status === "draft" ? "Send" : "Resend"} disabled={navigation.state !== "idle"} />
                      <QuoteAction quoteId={quote.id} intent="duplicate_quote" label="Duplicate" />
                      {quote.status === "approved" && <QuoteAction quoteId={quote.id} intent="convert_quote" label="Convert" />}
                      {editableStatuses.includes(quote.status) && <QuoteAction quoteId={quote.id} intent="cancel_quote" label="Cancel" />}
                      <QuoteAction quoteId={quote.id} intent="delete_quote" label="Delete" danger />
                    </div>
                  </td>
                </tr>
              ))}
              {!quotes.length && (
                <tr><td colSpan={9} style={styles.empty}>No quotes found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </main>
    </div>
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
      <button disabled={disabled} style={{ ...styles.actionBtn, color: danger ? "#b91c1c" : "#2563eb" }}>
        {label}
      </button>
    </Form>
  );
}

const styles: Record<string, React.CSSProperties> = {
  shell: { display: "flex", minHeight: "100vh", background: "#f8fafc", fontFamily: "'Inter', system-ui, sans-serif" },
  sidebar: { width: 270, background: "#fff", borderRight: "1px solid #e5e7eb", padding: 24, display: "flex", flexDirection: "column", gap: 20 },
  logo: { fontWeight: 800, fontSize: 22, color: "#111827" },
  companyBox: { display: "flex", flexDirection: "column", gap: 4, padding: 14, border: "1px solid #e5e7eb", borderRadius: 8, background: "#fafafa" },
  kicker: { fontSize: 11, textTransform: "uppercase", color: "#6b7280", fontWeight: 700 },
  nav: { display: "flex", flexDirection: "column", gap: 8 },
  navItem: { padding: "10px 12px", color: "#374151", textDecoration: "none", borderRadius: 8, fontWeight: 600 },
  activeNav: { background: "#111827", color: "#fff" },
  switcher: { display: "flex", flexDirection: "column", gap: 6 },
  companyLink: { color: "#2563eb", textDecoration: "none", fontSize: 13 },
  sidebarFooter: { marginTop: "auto", display: "flex", flexDirection: "column", gap: 10 },
  main: { flex: 1, padding: 32, minWidth: 0 },
  header: { display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center", marginBottom: 24 },
  title: { margin: 0, fontSize: 30, color: "#111827" },
  subtitle: { margin: "6px 0 0", color: "#6b7280" },
  primaryBtn: { background: "#111827", color: "#fff", padding: "11px 16px", borderRadius: 8, textDecoration: "none", fontWeight: 700, border: "none" },
  secondaryBtn: { background: "#fff", color: "#374151", padding: "9px 12px", borderRadius: 8, border: "1px solid #d1d5db", fontWeight: 700, cursor: "pointer" },
  filters: { display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 150px 150px auto", gap: 10, marginBottom: 18 },
  input: { height: 40, border: "1px solid #d1d5db", borderRadius: 8, padding: "0 10px", background: "#fff" },
  card: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, overflow: "auto" },
  table: { width: "100%", borderCollapse: "collapse" },
  th: { textAlign: "left", fontSize: 12, color: "#6b7280", padding: "12px 14px", borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" },
  td: { padding: "12px 14px", borderBottom: "1px solid #f3f4f6", fontSize: 13, verticalAlign: "middle" },
  link: { color: "#2563eb", fontWeight: 800, textDecoration: "none" },
  smallLink: { color: "#2563eb", textDecoration: "none", fontWeight: 700 },
  badge: { background: "#f3f4f6", borderRadius: 999, padding: "4px 9px", fontSize: 12, fontWeight: 800, textTransform: "capitalize" },
  actions: { display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" },
  actionBtn: { border: "none", background: "transparent", cursor: "pointer", fontWeight: 700, padding: 0 },
  error: { background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca", borderRadius: 8, padding: 12, marginBottom: 16 },
  success: { background: "#ecfdf5", color: "#065f46", border: "1px solid #a7f3d0", borderRadius: 8, padding: 12, marginBottom: 16 },
  empty: { padding: 28, color: "#6b7280", textAlign: "center" },
};
