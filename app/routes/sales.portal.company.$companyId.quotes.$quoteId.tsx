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
  hasCompanyAccess,
  requireSalesSession,
} from "app/utils/sales-session.server";
import {
  convertQuoteToOrder,
  getQuoteUrl,
  logQuoteActivity,
  sendQuoteToCustomer,
  serializeQuote,
} from "app/services/quote.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { user } = await requireSalesSession(request);
  const companyId = params.companyId;
  const quoteId = params.quoteId;
  if (!companyId || !quoteId || !hasCompanyAccess(user, companyId)) {
    return redirect("/sales/portal");
  }

  const quote = await prisma.quote.findFirst({
    where: { id: quoteId, companyId },
    include: {
      company: { include: { shop: { select: { shopName: true, shopDomain: true } } } },
      salesAgent: { select: { firstName: true, lastName: true, email: true } },
      items: { orderBy: { createdAt: "asc" } },
      activities: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!quote) {
    return redirect(`/sales/portal/company/${companyId}/quotes`);
  }

  if (
    ["draft", "sent", "viewed"].includes(quote.status) &&
    quote.expiresAt < new Date()
  ) {
    await prisma.quote.update({
      where: { id: quote.id },
      data: { status: "expired" },
    });
    quote.status = "expired";
  }

  return Response.json({
    quote: serializeQuote(quote),
    quoteUrl: getQuoteUrl(request, quote),
    created: new URL(request.url).searchParams.get("created") === "1",
    passedQuoteUrl: new URL(request.url).searchParams.get("quoteUrl") || "",
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { user } = await requireSalesSession(request);
  const companyId = params.companyId;
  const quoteId = params.quoteId;
  if (!companyId || !quoteId || !hasCompanyAccess(user, companyId)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const quote = await prisma.quote.findFirst({
    where: { id: quoteId, companyId },
    include: { items: true },
  });
  if (!quote) {
    return Response.json({ error: "Quote not found" }, { status: 404 });
  }

  try {
    if (intent === "update_quote") {
      if (quote.status !== "draft") {
        return Response.json({ error: "Only draft quotes can be edited." }, { status: 400 });
      }
      const title = String(formData.get("title") || "").trim();
      const customerNotes = String(formData.get("customerNotes") || "");
      const internalNotes = String(formData.get("internalNotes") || "");
      const expires = String(formData.get("expiresAt") || "");
      await prisma.quote.update({
        where: { id: quote.id },
        data: {
          title: title || quote.title,
          customerNotes,
          internalNotes,
          expiresAt: expires ? new Date(`${expires}T23:59:59.999`) : quote.expiresAt,
        },
      });
      await logQuoteActivity({
        quoteId: quote.id,
        userId: user.id,
        companyId,
        customerEmail: quote.customerEmail,
        action: "Quote Updated",
      });
      return Response.json({ success: true, message: "Quote updated." });
    }

    if (intent === "send_quote" || intent === "resend_quote") {
      const result = await sendQuoteToCustomer({ quoteId: quote.id, request, userId: user.id });
      return Response.json({ success: true, message: `Quote sent. Link: ${result.quoteUrl}` });
    }

    if (intent === "cancel_quote") {
      await prisma.quote.update({
        where: { id: quote.id },
        data: { status: "cancelled", cancelledAt: new Date() },
      });
      await logQuoteActivity({
        quoteId: quote.id,
        userId: user.id,
        companyId,
        customerEmail: quote.customerEmail,
        action: "Quote Cancelled",
      });
      return Response.json({ success: true, message: "Quote cancelled." });
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
      const result = await convertQuoteToOrder({ quoteId: quote.id, salesAgentId: user.id });
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

export default function QuoteDetailPage() {
  const { quote, quoteUrl, created, passedQuoteUrl } = useLoaderData<any>();
  const actionData = useActionData<any>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";
  const shareUrl = passedQuoteUrl || quoteUrl;

  const fmtMoney = (amount: string, currency = quote.currencyCode) =>
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
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  const dateInput = quote.expiresAt.slice(0, 10);

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div>
          <Link to={`/sales/portal/company/${quote.companyId}/quotes`} style={styles.backLink}>Back to Quotes</Link>
          <h1 style={styles.title}>{quote.quoteNumber}</h1>
          <p style={styles.subtitle}>{quote.title}</p>
        </div>
        <div style={styles.headerActions}>
          <Form method="post"><input type="hidden" name="intent" value="send_quote" /><button disabled={isSubmitting} style={styles.primaryBtn}>{quote.status === "draft" ? "Send Quote" : "Resend Quote"}</button></Form>
          <Form method="post"><input type="hidden" name="intent" value="duplicate_quote" /><button style={styles.secondaryBtn}>Duplicate</button></Form>
          {quote.status === "approved" && <Form method="post"><input type="hidden" name="intent" value="convert_quote" /><button disabled={isSubmitting} style={styles.primaryBtn}>Convert To Order</button></Form>}
          {["draft", "sent", "viewed"].includes(quote.status) && <Form method="post"><input type="hidden" name="intent" value="cancel_quote" /><button style={styles.secondaryBtn}>Cancel</button></Form>}
        </div>
      </header>

      {created && <div style={styles.success}>Quote created. Secure link: {shareUrl}</div>}
      {actionData?.error && <div style={styles.error}>{actionData.error}</div>}
      {actionData?.success && <div style={styles.success}>{actionData.message}</div>}

      <div style={styles.grid}>
        <section style={styles.mainCol}>
          <div style={styles.card}>
            <div style={styles.cardHeader}>
              <h2 style={styles.cardTitle}>Customer Information</h2>
              <span style={styles.badge}>{quote.status}</span>
            </div>
            <div style={styles.infoGrid}>
              <Info label="Company" value={quote.company.name} />
              <Info label="Customer" value={`${quote.customerFirstName || ""} ${quote.customerLastName || ""}`.trim() || quote.customerEmail} />
              <Info label="Email" value={quote.customerEmail} />
              <Info label="Sales Agent" value={quote.salesAgent?.firstName || quote.salesAgent?.email || "Sales Agent"} />
              <Info label="Created" value={fmtDate(quote.createdAt)} />
              <Info label="Expires" value={fmtDate(quote.expiresAt)} />
            </div>
          </div>

          <div style={styles.card}>
            <h2 style={styles.cardTitle}>Product Summary</h2>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Product</th>
                  <th style={styles.th}>Variant</th>
                  <th style={styles.th}>Qty</th>
                  <th style={styles.th}>Unit</th>
                  <th style={{ ...styles.th, textAlign: "right" }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {quote.items.map((item: any) => (
                  <tr key={item.id}>
                    <td style={styles.td}>{item.productTitle}<br /><small>{item.sku || "No SKU"}</small></td>
                    <td style={styles.td}>{item.variantTitle || "Default"}</td>
                    <td style={styles.td}>{item.quantity}</td>
                    <td style={styles.td}>{fmtMoney(item.unitPrice, item.currencyCode)}</td>
                    <td style={{ ...styles.td, textAlign: "right" }}>{fmtMoney(item.totalPrice, item.currencyCode)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={styles.card}>
            <h2 style={styles.cardTitle}>Activity History</h2>
            <div style={styles.timeline}>
              {quote.activities.map((activity: any) => (
                <div key={activity.id} style={styles.activity}>
                  <strong>{activity.action}</strong>
                  <span>{fmtDate(activity.createdAt)}</span>
                  {activity.message && <p>{activity.message}</p>}
                </div>
              ))}
              {!quote.activities.length && <p style={styles.muted}>No activity yet.</p>}
            </div>
          </div>
        </section>

        <aside style={styles.sideCol}>
          <div style={styles.card}>
            <h2 style={styles.cardTitle}>Quote Sharing</h2>
            <input readOnly value={shareUrl} style={styles.input} onFocus={(e) => e.currentTarget.select()} />
            <p style={styles.muted}>Copy this secure quote link for the customer.</p>
          </div>

          <div style={styles.card}>
            <h2 style={styles.cardTitle}>Grand Total</h2>
            <Summary label="Subtotal" value={fmtMoney(quote.subtotal)} />
            <Summary label="Discount" value={`-${fmtMoney(quote.discountTotal)}`} />
            <Summary label={`Tax (${quote.taxRate}%)`} value={fmtMoney(quote.taxAmount)} />
            <Summary label="Shipping" value={fmtMoney(quote.shippingAmount)} />
            <div style={styles.totalRow}><strong>Total</strong><strong>{fmtMoney(quote.totalAmount)}</strong></div>
          </div>

          {quote.status === "draft" && (
            <Form method="post" style={styles.card}>
              <input type="hidden" name="intent" value="update_quote" />
              <h2 style={styles.cardTitle}>Edit Draft</h2>
              <label style={styles.label}>Title<input name="title" defaultValue={quote.title} style={styles.input} /></label>
              <label style={styles.label}>Expiration<input type="date" name="expiresAt" defaultValue={dateInput} style={styles.input} /></label>
              <label style={styles.label}>Customer Notes<textarea name="customerNotes" defaultValue={quote.customerNotes || ""} style={styles.textarea} /></label>
              <label style={styles.label}>Internal Notes<textarea name="internalNotes" defaultValue={quote.internalNotes || ""} style={styles.textarea} /></label>
              <button disabled={isSubmitting} style={styles.primaryBtn}>Save Draft</button>
            </Form>
          )}
        </aside>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><span style={styles.metaLabel}>{label}</span><strong>{value}</strong></div>;
}

function Summary({ label, value }: { label: string; value: string }) {
  return <div style={styles.summaryRow}><span>{label}</span><strong>{value}</strong></div>;
}

const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: "100vh", background: "#f8fafc", padding: 32, fontFamily: "'Inter', system-ui, sans-serif" },
  header: { display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", marginBottom: 24 },
  headerActions: { display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" },
  backLink: { color: "#2563eb", textDecoration: "none", fontWeight: 700 },
  title: { margin: "8px 0 4px", fontSize: 32, color: "#111827" },
  subtitle: { margin: 0, color: "#6b7280" },
  grid: { display: "grid", gridTemplateColumns: "1fr 360px", gap: 24, alignItems: "start" },
  mainCol: { display: "flex", flexDirection: "column", gap: 20 },
  sideCol: { display: "flex", flexDirection: "column", gap: 20, position: "sticky", top: 20 },
  card: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: 20 },
  cardHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 },
  cardTitle: { margin: "0 0 16px", fontSize: 18, color: "#111827" },
  infoGrid: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 },
  metaLabel: { display: "block", color: "#6b7280", fontSize: 12, marginBottom: 4 },
  badge: { background: "#f3f4f6", color: "#374151", borderRadius: 999, padding: "5px 10px", fontWeight: 800, textTransform: "capitalize" },
  table: { width: "100%", borderCollapse: "collapse" },
  th: { textAlign: "left", padding: "10px 8px", borderBottom: "1px solid #e5e7eb", color: "#6b7280", fontSize: 12 },
  td: { padding: "12px 8px", borderBottom: "1px solid #f3f4f6", fontSize: 13 },
  input: { width: "100%", boxSizing: "border-box", height: 40, border: "1px solid #d1d5db", borderRadius: 8, padding: "0 10px", font: "inherit" },
  textarea: { width: "100%", boxSizing: "border-box", minHeight: 78, border: "1px solid #d1d5db", borderRadius: 8, padding: 10, font: "inherit" },
  label: { display: "flex", flexDirection: "column", gap: 6, fontSize: 13, color: "#374151", fontWeight: 700, marginBottom: 12 },
  muted: { color: "#6b7280", fontSize: 13 },
  primaryBtn: { background: "#111827", color: "#fff", border: "none", borderRadius: 8, padding: "10px 14px", fontWeight: 800, cursor: "pointer" },
  secondaryBtn: { background: "#fff", color: "#374151", border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 14px", fontWeight: 800, cursor: "pointer" },
  summaryRow: { display: "flex", justifyContent: "space-between", padding: "8px 0", color: "#4b5563" },
  totalRow: { display: "flex", justifyContent: "space-between", borderTop: "1px solid #e5e7eb", paddingTop: 14, marginTop: 8, fontSize: 18 },
  timeline: { display: "flex", flexDirection: "column", gap: 12 },
  activity: { borderLeft: "3px solid #111827", paddingLeft: 12 },
  success: { background: "#ecfdf5", color: "#065f46", border: "1px solid #a7f3d0", borderRadius: 8, padding: 12, marginBottom: 16 },
  error: { background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca", borderRadius: 8, padding: 12, marginBottom: 16 },
};
