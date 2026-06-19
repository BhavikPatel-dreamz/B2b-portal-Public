import type React from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import prisma from "app/db.server";
import { logQuoteActivity, serializeQuote } from "app/services/quote.server";

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const quoteId = params.quoteId;
  const secureToken = params.secureToken;
  if (!quoteId || !secureToken) {
    throw new Response("Quote not found", { status: 404 });
  }

  const quote = await prisma.quote.findFirst({
    where: { id: quoteId, secureToken },
    include: {
      company: { include: { shop: { select: { shopName: true, shopDomain: true, logo: true } } } },
      items: { orderBy: { createdAt: "asc" } },
      activities: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!quote) {
    throw new Response("Quote not found", { status: 404 });
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

  if (quote.status === "sent") {
    await prisma.quote.update({
      where: { id: quote.id },
      data: { status: "viewed", viewedAt: new Date() },
    });
    await logQuoteActivity({
      quoteId: quote.id,
      companyId: quote.companyId,
      customerEmail: quote.customerEmail,
      action: "Quote Viewed",
      message: "Customer opened the secure quote link.",
    });
    quote.status = "viewed";
  }

  return Response.json({ quote: serializeQuote(quote) });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const quoteId = params.quoteId;
  const secureToken = params.secureToken;
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const comments = String(formData.get("comments") || "").trim();

  const quote = await prisma.quote.findFirst({
    where: { id: quoteId, secureToken },
  });
  if (!quote) {
    return Response.json({ error: "Quote not found" }, { status: 404 });
  }
  if (quote.status === "expired" || quote.expiresAt < new Date()) {
    await prisma.quote.update({
      where: { id: quote.id },
      data: { status: "expired" },
    });
    return Response.json({ error: "This quote has expired." }, { status: 400 });
  }
  if (["approved", "rejected", "converted", "cancelled"].includes(quote.status)) {
    return Response.json({ error: "This quote has already been finalized." }, { status: 400 });
  }

  if (intent === "approve_quote" || intent === "reject_quote") {
    const approved = intent === "approve_quote";
    await prisma.quote.update({
      where: { id: quote.id },
      data: {
        status: approved ? "approved" : "rejected",
        approvedAt: approved ? new Date() : null,
        rejectedAt: approved ? null : new Date(),
        customerComments: comments || quote.customerComments,
      },
    });
    await logQuoteActivity({
      quoteId: quote.id,
      companyId: quote.companyId,
      customerEmail: quote.customerEmail,
      action: approved ? "Quote Approved" : "Quote Rejected",
      message: comments || null,
    });
    return Response.json({
      success: true,
      message: approved ? "Quote approved. Your sales agent will follow up." : "Quote rejected. Thank you for the feedback.",
    });
  }

  if (intent === "leave_comment") {
    await prisma.quote.update({
      where: { id: quote.id },
      data: { customerComments: comments },
    });
    await logQuoteActivity({
      quoteId: quote.id,
      companyId: quote.companyId,
      customerEmail: quote.customerEmail,
      action: "Quote Commented",
      message: comments,
    });
    return Response.json({ success: true, message: "Comment saved." });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
};

export default function PublicQuotePage() {
  const { quote } = useLoaderData<any>();
  const actionData = useActionData<any>();
  const canAct = ["sent", "viewed"].includes(quote.status);

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
    }).format(new Date(iso));

  return (
    <main style={styles.page}>
      <section style={styles.header}>
        <div>
          <p style={styles.kicker}>{quote.company.shop.shopName || quote.company.shop.shopDomain}</p>
          <h1 style={styles.title}>{quote.quoteNumber}</h1>
          <p style={styles.subtitle}>{quote.title}</p>
        </div>
        <span style={styles.badge}>{quote.status}</span>
      </section>

      {actionData?.error && <div style={styles.error}>{actionData.error}</div>}
      {actionData?.success && <div style={styles.success}>{actionData.message}</div>}

      <div style={styles.grid}>
        <section style={styles.card}>
          <h2 style={styles.cardTitle}>Quote Details</h2>
          <div style={styles.infoGrid}>
            <Info label="Company" value={quote.company.name} />
            <Info label="Customer" value={`${quote.customerFirstName || ""} ${quote.customerLastName || ""}`.trim() || quote.customerEmail} />
            <Info label="Email" value={quote.customerEmail} />
            <Info label="Expiration Date" value={fmtDate(quote.expiresAt)} />
          </div>

          {quote.customerNotes && (
            <div style={styles.note}>
              <strong>Notes</strong>
              <p>{quote.customerNotes}</p>
            </div>
          )}

          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Product</th>
                <th style={styles.th}>Variant</th>
                <th style={styles.th}>Qty</th>
                <th style={styles.th}>Unit Price</th>
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
        </section>

        <aside style={styles.side}>
          <div style={styles.card}>
            <h2 style={styles.cardTitle}>Summary</h2>
            <Summary label="Subtotal" value={fmtMoney(quote.subtotal)} />
            <Summary label="Discount" value={`-${fmtMoney(quote.discountTotal)}`} />
            <Summary label={`Tax (${quote.taxRate}%)`} value={fmtMoney(quote.taxAmount)} />
            <Summary label="Shipping" value={fmtMoney(quote.shippingAmount)} />
            <div style={styles.total}><strong>Total</strong><strong>{fmtMoney(quote.totalAmount)}</strong></div>
          </div>

          <Form method="post" style={styles.card}>
            <h2 style={styles.cardTitle}>Customer Response</h2>
            <textarea name="comments" defaultValue={quote.customerComments || ""} placeholder="Leave comments for the sales agent" style={styles.textarea} />
            <div style={styles.actions}>
              <button type="submit" name="intent" value="leave_comment" style={styles.secondaryBtn}>Save Comment</button>
              <button type="button" onClick={() => window.print()} style={styles.secondaryBtn}>Download PDF</button>
            </div>
            <div style={styles.actions}>
              <button disabled={!canAct} type="submit" name="intent" value="reject_quote" style={styles.rejectBtn}>Reject Quote</button>
              <button disabled={!canAct} type="submit" name="intent" value="approve_quote" style={styles.primaryBtn}>Approve Quote</button>
            </div>
          </Form>
        </aside>
      </div>
    </main>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><span style={styles.metaLabel}>{label}</span><strong>{value}</strong></div>;
}

function Summary({ label, value }: { label: string; value: string }) {
  return <div style={styles.summaryRow}><span>{label}</span><strong>{value}</strong></div>;
}

const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: "100vh", background: "#f8fafc", padding: 32, fontFamily: "'Inter', system-ui, sans-serif", color: "#111827" },
  header: { maxWidth: 1180, margin: "0 auto 24px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 },
  kicker: { margin: 0, color: "#6b7280", fontWeight: 800, textTransform: "uppercase", fontSize: 12 },
  title: { margin: "8px 0 4px", fontSize: 34 },
  subtitle: { margin: 0, color: "#6b7280" },
  badge: { background: "#f3f4f6", borderRadius: 999, padding: "6px 12px", fontWeight: 800, textTransform: "capitalize" },
  grid: { maxWidth: 1180, margin: "0 auto", display: "grid", gridTemplateColumns: "1fr 340px", gap: 24, alignItems: "start" },
  card: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: 20 },
  side: { display: "flex", flexDirection: "column", gap: 20, position: "sticky", top: 20 },
  cardTitle: { margin: "0 0 16px", fontSize: 18 },
  infoGrid: { display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16, marginBottom: 20 },
  metaLabel: { display: "block", color: "#6b7280", fontSize: 12, marginBottom: 4 },
  note: { background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 8, padding: 14, marginBottom: 20 },
  table: { width: "100%", borderCollapse: "collapse" },
  th: { textAlign: "left", borderBottom: "1px solid #e5e7eb", padding: "10px 8px", color: "#6b7280", fontSize: 12 },
  td: { borderBottom: "1px solid #f3f4f6", padding: "12px 8px", fontSize: 13 },
  summaryRow: { display: "flex", justifyContent: "space-between", padding: "8px 0", color: "#4b5563" },
  total: { display: "flex", justifyContent: "space-between", borderTop: "1px solid #e5e7eb", paddingTop: 14, marginTop: 8, fontSize: 18 },
  textarea: { width: "100%", boxSizing: "border-box", minHeight: 96, border: "1px solid #d1d5db", borderRadius: 8, padding: 10, font: "inherit", marginBottom: 12 },
  actions: { display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 10 },
  primaryBtn: { background: "#111827", color: "#fff", border: "none", borderRadius: 8, padding: "10px 14px", fontWeight: 800, cursor: "pointer" },
  secondaryBtn: { background: "#fff", color: "#374151", border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 14px", fontWeight: 800, cursor: "pointer" },
  rejectBtn: { background: "#fff", color: "#b91c1c", border: "1px solid #fecaca", borderRadius: 8, padding: "10px 14px", fontWeight: 800, cursor: "pointer" },
  success: { maxWidth: 1180, margin: "0 auto 16px", background: "#ecfdf5", color: "#065f46", border: "1px solid #a7f3d0", borderRadius: 8, padding: 12 },
  error: { maxWidth: 1180, margin: "0 auto 16px", background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca", borderRadius: 8, padding: 12 },
};
