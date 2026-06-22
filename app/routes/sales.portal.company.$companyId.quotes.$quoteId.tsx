import nodeCrypto from "node:crypto";
import type React from "react";
import { useEffect, useRef, useState } from "react";
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
  getQuoteUrl,
  logQuoteActivity,
  sendQuoteToCustomer,
  serializeQuote,
} from "app/services/quote.server";
import {
  SalesPortalHeader,
  SalesPortalLayout,
} from "app/components/SalesPortalLayout";

type ActionResponse = {
  success?: boolean;
  message?: string;
  error?: string;
};

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
      company: {
        include: { shop: { select: { shopName: true, shopDomain: true } } },
      },
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

  const url = new URL(request.url);
  return Response.json({
    quote: serializeQuote(quote),
    user: {
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
    },
    allCompanies: user.salesCompanies.map((item) => ({
      id: item.company.id,
      name: item.company.name,
    })),
    quoteCount: await prisma.quote.count({ where: { companyId } }),
    orderCount: await prisma.b2BOrder.count({
      where: {
        companyId,
        orderStatus: { notIn: ["converted", "archived"] },
      },
    }),
    quoteUrl: getQuoteUrl(request, quote),
    created: url.searchParams.get("created") === "1",
    duplicatedFrom: url.searchParams.get("duplicatedFrom") || "",
    passedQuoteUrl: url.searchParams.get("quoteUrl") || "",
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
  if (intent === "logout") {
    return redirect("/sales/login", {
      headers: { "Set-Cookie": buildClearSessionCookie() },
    });
  }
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
        return Response.json(
          { error: "Only draft quotes can be edited." },
          { status: 400 },
        );
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
          expiresAt: expires
            ? new Date(`${expires}T23:59:59.999`)
            : quote.expiresAt,
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
      const result = await sendQuoteToCustomer({
        quoteId: quote.id,
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
      return redirect(
        `/sales/portal/company/${companyId}/quotes/${duplicate.id}?duplicatedFrom=${encodeURIComponent(quote.quoteNumber)}`,
      );
    }

    if (intent === "convert_quote") {
      const result = await convertQuoteToOrder({
        quoteId: quote.id,
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

export default function QuoteDetailPage() {
  const {
    quote,
    quoteUrl,
    created,
    duplicatedFrom,
    passedQuoteUrl,
    user,
    allCompanies,
    quoteCount,
    orderCount,
  } = useLoaderData<any>();
  const actionData = useActionData<ActionResponse>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";
  const pendingIntent = String(navigation.formData?.get("intent") || "");
  const submissionLock = useRef(false);
  const shareUrl = passedQuoteUrl || quoteUrl;
  const initialSuccessMessage = created
    ? `Quote created successfully. Secure link: ${shareUrl}`
    : duplicatedFrom
      ? `${quote.quoteNumber} was duplicated successfully from ${duplicatedFrom}.`
      : "";
  const [notification, setNotification] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(initialSuccessMessage ? { type: "success", message: initialSuccessMessage } : null);

  useEffect(() => {
    if (navigation.state === "idle") submissionLock.current = false;
  }, [navigation.state]);

  useEffect(() => {
    if (actionData?.error) {
      setNotification({ type: "error", message: actionData.error });
    } else if (actionData?.success) {
      setNotification({
        type: "success",
        message: actionData.message || "Quote updated successfully.",
      });
    }
  }, [actionData]);

  useEffect(() => {
    if (initialSuccessMessage) {
      setNotification({ type: "success", message: initialSuccessMessage });
    }
  }, [initialSuccessMessage]);

  const guardSubmission = (event: React.FormEvent<HTMLFormElement>) => {
    if (submissionLock.current || isSubmitting) {
      event.preventDefault();
      return false;
    }
    submissionLock.current = true;
    setNotification(null);
    return true;
  };

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
  const sendIntent = quote.status === "draft" ? "send_quote" : "resend_quote";

  return (
    <SalesPortalLayout
      company={{
        id: quote.companyId,
        name: quote.company.name,
        storeName: quote.company.shop.shopName || quote.company.shop.shopDomain,
      }}
      user={user}
      activePage="quotes"
      orderCount={orderCount}
      quoteCount={quoteCount}
    >
      <Link
        to={`/sales/portal/company/${quote.companyId}/quotes`}
        aria-disabled={isSubmitting}
        style={{
          ...styles.backLink,
          opacity: isSubmitting ? 0.55 : 1,
          pointerEvents: isSubmitting ? "none" : "auto",
        }}
      >
        Back to Quotes
      </Link>
      <SalesPortalHeader
        title={quote.quoteNumber}
        subtitle={quote.title}
        companyId={quote.companyId}
        companies={allCompanies}
        actions={
          <>
            <Form method="post" onSubmit={guardSubmission}>
              <input type="hidden" name="intent" value={sendIntent} />
              <button
                disabled={isSubmitting}
                aria-busy={pendingIntent === sendIntent}
                style={disabledButtonStyle(styles.primaryBtn, isSubmitting)}
              >
                {pendingIntent === sendIntent && <Spinner />}
                {pendingIntent === sendIntent
                  ? quote.status === "draft" ? "Sending Quote..." : "Resending Quote..."
                  : quote.status === "draft" ? "Send Quote" : "Resend Quote"}
              </button>
            </Form>
            <Form method="post" onSubmit={guardSubmission}>
              <input type="hidden" name="intent" value="duplicate_quote" />
              <button
                disabled={isSubmitting}
                aria-busy={pendingIntent === "duplicate_quote"}
                style={disabledButtonStyle(styles.secondaryBtn, isSubmitting)}
              >
                {pendingIntent === "duplicate_quote" && <Spinner dark />}
                {pendingIntent === "duplicate_quote" ? "Duplicating..." : "Duplicate"}
              </button>
            </Form>
            {quote.status === "approved" && (
              <Form method="post" onSubmit={guardSubmission}>
                <input type="hidden" name="intent" value="convert_quote" />
                <button
                  disabled={isSubmitting}
                  aria-busy={pendingIntent === "convert_quote"}
                  style={disabledButtonStyle(styles.primaryBtn, isSubmitting)}
                >
                  {pendingIntent === "convert_quote" && <Spinner />}
                  {pendingIntent === "convert_quote" ? "Converting..." : "Convert To Order"}
                </button>
              </Form>
            )}
            {["draft", "sent", "viewed"].includes(quote.status) && (
              <Form
                method="post"
                onSubmit={(event) => {
                  if (!confirm("Cancel this quote?")) {
                    event.preventDefault();
                    return;
                  }
                  guardSubmission(event);
                }}
              >
                <input type="hidden" name="intent" value="cancel_quote" />
                <button
                  disabled={isSubmitting}
                  aria-busy={pendingIntent === "cancel_quote"}
                  style={disabledButtonStyle(styles.secondaryBtn, isSubmitting)}
                >
                  {pendingIntent === "cancel_quote" && <Spinner dark />}
                  {pendingIntent === "cancel_quote" ? "Cancelling..." : "Cancel"}
                </button>
              </Form>
            )}
          </>
        }
      />

      {notification && (
        <div
          role={notification.type === "error" ? "alert" : "status"}
          aria-live={notification.type === "error" ? "assertive" : "polite"}
          style={{
            ...styles.toast,
            ...(notification.type === "error" ? styles.error : styles.success),
          }}
        >
          <div style={{ paddingRight: 28 }}>
            <strong>{notification.type === "error" ? "Action failed" : "Success"}</strong>
            <p style={{ margin: "4px 0 0" }}>{notification.message}</p>
          </div>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => setNotification(null)}
            style={styles.toastCloseButton}
          >
            x
          </button>
        </div>
      )}

      <div className="sales-quote-detail-grid" style={styles.grid}>
        <section style={styles.mainCol}>
          <div className="sales-quote-card" style={styles.card}>
            <div style={styles.cardHeader}>
              <h2 style={styles.cardTitle}>Customer Information</h2>
              <span style={styles.badge}>{quote.status}</span>
            </div>
            <div className="sales-quote-info-grid" style={styles.infoGrid}>
              <Info label="Company" value={quote.company.name} />
              <Info
                label="Customer"
                value={
                  `${quote.customerFirstName || ""} ${quote.customerLastName || ""}`.trim() ||
                  quote.customerEmail
                }
              />
              <Info label="Email" value={quote.customerEmail} />
              <Info
                label="Sales Agent"
                value={
                  quote.salesAgent?.firstName ||
                  quote.salesAgent?.email ||
                  "Sales Agent"
                }
              />
              <Info label="Created" value={fmtDate(quote.createdAt)} />
              <Info label="Expires" value={fmtDate(quote.expiresAt)} />
            </div>
          </div>

          <div
            className="sales-quote-card"
            style={{ ...styles.card, padding: 0, overflow: "hidden" }}
          >
            <div style={styles.cardHeading}>
              <h2 style={{ ...styles.cardTitle, margin: 0 }}>
                Product Summary
              </h2>
            </div>
            <div className="sales-quote-table-wrap">
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
                      <td style={styles.td}>
                        {item.productTitle}
                        <br />
                        <small>{item.sku || "No SKU"}</small>
                      </td>
                      <td style={styles.td}>
                        {item.variantTitle || "Default"}
                      </td>
                      <td style={styles.td}>{item.quantity}</td>
                      <td style={styles.td}>
                        {fmtMoney(item.unitPrice, item.currencyCode)}
                      </td>
                      <td style={{ ...styles.td, textAlign: "right" }}>
                        {fmtMoney(item.totalPrice, item.currencyCode)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="sales-quote-card" style={styles.card}>
            <h2 style={styles.cardTitle}>Activity History</h2>
            <div style={styles.timeline}>
              {quote.activities.map((activity: any) => (
                <div key={activity.id} style={styles.activity}>
                  <strong>{activity.action}</strong>
                  <span>{fmtDate(activity.createdAt)}</span>
                  {activity.message && <p>{activity.message}</p>}
                </div>
              ))}
              {!quote.activities.length && (
                <p style={styles.muted}>No activity yet.</p>
              )}
            </div>
          </div>
        </section>

        <aside className="sales-quote-side-column" style={styles.sideCol}>
          <div className="sales-quote-card" style={styles.card}>
            <h2 style={styles.cardTitle}>Quote Sharing</h2>
            <div style={styles.copyRow}>
              <input
                readOnly
                value={shareUrl}
                aria-label="Secure quote link"
                style={styles.input}
                onFocus={(e) => e.currentTarget.select()}
              />
              <button
                type="button"
                disabled={isSubmitting}
                style={disabledButtonStyle(styles.copyBtn, isSubmitting)}
                onClick={() => navigator.clipboard.writeText(shareUrl)}
              >
                Copy
              </button>
            </div>
            <p style={styles.muted}>
              Copy this secure quote link for the customer.
            </p>
          </div>

          <div className="sales-quote-card" style={styles.card}>
            <h2 style={styles.cardTitle}>Grand Total</h2>
            <Summary label="Subtotal" value={fmtMoney(quote.subtotal)} />
            <Summary
              label="Discount"
              value={`-${fmtMoney(quote.discountTotal)}`}
            />
            <Summary
              label={`Tax (${quote.taxRate}%)`}
              value={fmtMoney(quote.taxAmount)}
            />
            <Summary label="Shipping" value={fmtMoney(quote.shippingAmount)} />
            <div style={styles.totalRow}>
              <strong>Total</strong>
              <strong>{fmtMoney(quote.totalAmount)}</strong>
            </div>
          </div>

          {quote.status === "draft" && (
            <Form
              method="post"
              className="sales-quote-card"
              style={styles.card}
              onSubmit={guardSubmission}
            >
              <input type="hidden" name="intent" value="update_quote" />
              <h2 style={styles.cardTitle}>Edit Draft</h2>
              <label style={styles.label}>
                Title
                <input
                  name="title"
                  defaultValue={quote.title}
                  style={styles.input}
                  disabled={isSubmitting}
                />
              </label>
              <label style={styles.label}>
                Expiration
                <input
                  type="date"
                  name="expiresAt"
                  defaultValue={dateInput}
                  style={styles.input}
                  disabled={isSubmitting}
                />
              </label>
              <label style={styles.label}>
                Customer Notes
                <textarea
                  name="customerNotes"
                  defaultValue={quote.customerNotes || ""}
                  style={styles.textarea}
                  disabled={isSubmitting}
                />
              </label>
              <label style={styles.label}>
                Internal Notes
                <textarea
                  name="internalNotes"
                  defaultValue={quote.internalNotes || ""}
                  style={styles.textarea}
                  disabled={isSubmitting}
                />
              </label>
              <button
                disabled={isSubmitting}
                aria-busy={pendingIntent === "update_quote"}
                style={disabledButtonStyle(styles.primaryBtn, isSubmitting)}
              >
                {pendingIntent === "update_quote" && <Spinner />}
                {pendingIntent === "update_quote" ? "Saving Draft..." : "Save Draft"}
              </button>
            </Form>
          )}
        </aside>
      </div>
      <style>{`
        @keyframes quote-action-spin { to { transform: rotate(360deg); } }
        .sales-quote-table-wrap { overflow-x: auto; }
        @media (max-width: 1080px) {
          .sales-quote-detail-grid { grid-template-columns: minmax(0, 1fr) !important; }
          .sales-quote-side-column { position: static !important; }
        }
        @media (max-width: 700px) {
          .sales-quote-card { padding: 16px !important; }
          .sales-quote-info-grid { grid-template-columns: minmax(0, 1fr) !important; }
        }
      `}</style>
    </SalesPortalLayout>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span style={styles.metaLabel}>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.summaryRow}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Spinner({ dark = false }: { dark?: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        ...styles.buttonSpinner,
        borderColor: dark ? "#d1d5db" : "rgba(255, 255, 255, 0.45)",
        borderTopColor: dark ? "#374151" : "#ffffff",
      }}
    />
  );
}

function disabledButtonStyle(
  style: React.CSSProperties,
  disabled: boolean,
): React.CSSProperties {
  return {
    ...style,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    opacity: disabled ? 0.6 : 1,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

const styles: Record<string, React.CSSProperties> = {
  backLink: {
    color: "#2c6ecb",
    textDecoration: "none",
    fontWeight: 600,
    fontSize: 13,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) 360px",
    gap: 24,
    alignItems: "start",
  },
  mainCol: { display: "flex", flexDirection: "column", gap: 20 },
  sideCol: {
    display: "flex",
    flexDirection: "column",
    gap: 20,
    position: "sticky",
    top: 20,
  },
  card: {
    background: "#fff",
    border: "1px solid #e1e3e5",
    borderRadius: 8,
    padding: 20,
  },
  cardHeading: { padding: "18px 20px", borderBottom: "1px solid #e1e3e5" },
  cardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  cardTitle: { margin: "0 0 16px", fontSize: 18, color: "#111827" },
  infoGrid: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 },
  metaLabel: {
    display: "block",
    color: "#6b7280",
    fontSize: 12,
    marginBottom: 4,
  },
  badge: {
    background: "#fff0f4",
    color: "#b71950",
    borderRadius: 8,
    padding: "5px 10px",
    fontSize: 12,
    fontWeight: 700,
    textTransform: "capitalize",
  },
  table: { width: "100%", minWidth: 620, borderCollapse: "collapse" },
  th: {
    textAlign: "left",
    padding: "10px 8px",
    borderBottom: "1px solid #e5e7eb",
    color: "#6b7280",
    fontSize: 12,
  },
  td: { padding: "12px 8px", borderBottom: "1px solid #f3f4f6", fontSize: 13 },
  input: {
    width: "100%",
    boxSizing: "border-box",
    height: 40,
    border: "1px solid #c9cccf",
    borderRadius: 8,
    padding: "0 10px",
    font: "inherit",
    fontSize: 13,
  },
  textarea: {
    width: "100%",
    boxSizing: "border-box",
    minHeight: 78,
    border: "1px solid #c9cccf",
    borderRadius: 8,
    padding: 10,
    font: "inherit",
    resize: "vertical",
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    fontSize: 13,
    color: "#374151",
    fontWeight: 700,
    marginBottom: 12,
  },
  muted: { color: "#6b7280", fontSize: 13 },
  primaryBtn: {
    background: "#111827",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "10px 14px",
    fontWeight: 600,
    cursor: "pointer",
  },
  secondaryBtn: {
    background: "#fff",
    color: "#374151",
    border: "1px solid #c9cccf",
    borderRadius: 8,
    padding: "10px 14px",
    fontWeight: 600,
    cursor: "pointer",
  },
  copyRow: { display: "flex", gap: 8 },
  copyBtn: {
    border: "1px solid #c9cccf",
    borderRadius: 8,
    background: "#fff",
    color: "#2c6ecb",
    padding: "0 13px",
    fontWeight: 600,
    cursor: "pointer",
  },
  summaryRow: {
    display: "flex",
    justifyContent: "space-between",
    padding: "8px 0",
    color: "#4b5563",
  },
  totalRow: {
    display: "flex",
    justifyContent: "space-between",
    borderTop: "1px solid #e5e7eb",
    paddingTop: 14,
    marginTop: 8,
    fontSize: 18,
  },
  timeline: { display: "flex", flexDirection: "column", gap: 12 },
  activity: {
    borderLeft: "3px solid #e91e63",
    paddingLeft: 12,
    color: "#202223",
  },
  success: {
    background: "#ecfdf5",
    color: "#065f46",
    border: "1px solid #a7f3d0",
  },
  error: {
    background: "#fef2f2",
    color: "#991b1b",
    border: "1px solid #fecaca",
  },
  toast: {
    position: "fixed",
    top: 20,
    right: 20,
    zIndex: 11000,
    width: "min(400px, calc(100vw - 32px))",
    boxSizing: "border-box",
    borderRadius: 10,
    padding: 14,
    boxShadow: "0 12px 30px rgba(17, 24, 39, 0.16)",
    fontSize: 13,
  },
  toastCloseButton: {
    position: "absolute",
    top: 8,
    right: 10,
    border: "none",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    fontSize: 18,
    lineHeight: 1,
  },
  buttonSpinner: {
    width: 15,
    height: 15,
    border: "2px solid",
    borderRadius: "50%",
    animation: "quote-action-spin 0.8s linear infinite",
    flexShrink: 0,
  },
};
