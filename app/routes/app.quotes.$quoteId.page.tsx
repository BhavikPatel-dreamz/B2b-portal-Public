import { useState } from "react";
import {
  useLoaderData,
  Link,
  Form,
  useNavigation,
  useActionData,
  useRevalidator,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useEffect } from "react";

function fmtMoney(amount: string | number, currency: string) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(Number(amount) || 0);
}

function fmtDate(iso: string) {
  if (!iso) return "–";
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(iso));
}

function fmtDateTime(iso: string) {
  if (!iso) return "–";
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

const STATUS_COLORS: Record<string, string> = {
  draft: "#6b21a8",
  sent: "#0369a1",
  viewed: "#1d4ed8",
  approved: "#166534",
  rejected: "#991b1b",
  expired: "#92400e",
  converted: "#334155",
  cancelled: "#6b7280",
};

export default function AdminQuoteDetailPage() {
  const { quote, shopDomain } = useLoaderData<any>();
  const actionData = useActionData<any>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();

  const [showAllActivities, setShowAllActivities] = useState(false);
  const [showDiscountForm, setShowDiscountForm] = useState(false);
  const [discountValue, setDiscountValue] = useState(
    quote.discountType === "PERCENTAGE" ? String(quote.discountAmount) : String(quote.discountAmount),
  );
  const [discountType, setDiscountType] = useState(quote.discountType || "FIXED_AMOUNT");
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);
  const [invoiceData, setInvoiceData] = useState<any>(null);

  const isSubmitting = navigation.state !== "idle";
  const submittingIntent = isSubmitting ? String(navigation.formData?.get("intent") || "") : "";

  useEffect(() => {
    if (actionData?.invoiceData) {
      setInvoiceData(actionData.invoiceData);
      setShowInvoiceModal(true);
    } else if (actionData?.success) {
      shopify.toast.show?.(actionData.message || "Done");
      setShowDiscountForm(false);
      revalidator.revalidate();
    } else if (actionData?.error) {
      shopify.toast.show?.(actionData.error, { isError: true });
    }
  }, [actionData]);

  const isDraft = quote.status === "draft";
  const canEdit = isDraft;
  const canEditDiscount = isDraft || quote.status === "sent";
  const canConvert = ["approved", "sent", "viewed"].includes(quote.status);

  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.hero}>
        <Link
          to="/app/quotes"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            color: "#2c6ecb",
            textDecoration: "none",
            fontSize: "14px",
            fontWeight: 600,
            margin: "15px 15px 5px",
          }}
        >
          <svg viewBox="0 0 20 20" style={{ width: "16px", height: "16px" }} fill="currentColor">
            <path
              fillRule="evenodd"
              d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z"
              clipRule="evenodd"
            />
          </svg>
          Back to Quotes
        </Link>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, padding: "0 15px 15px" }}>
          <div>
            <h2 style={styles.heroTitle}>
              {quote.shopifyDraftOrderName || quote.shopifyDraftOrderId || quote.quoteNumber}
              <span
                style={{
                  marginLeft: 12,
                  padding: "4px 12px",
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  background: "#f4f6f8",
                  color: STATUS_COLORS[quote.status] || "#374151",
                  textTransform: "capitalize",
                }}
              >
                {quote.status}
              </span>
            </h2>
            <p style={styles.heroText}>{quote.title || "No title"}</p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {canEdit && (
              <Form method="post" style={{ display: "inline" }}>
                <input type="hidden" name="intent" value="send_invoice" />
                <button
                  disabled={isSubmitting}
                  style={{ ...styles.btn, background: "#005bd3", color: "white" }}
                >
                  {submittingIntent === "send_invoice" ? "Sending..." : "Send Invoice"}
                </button>
              </Form>
            )}
            {!canEdit && quote.shopifyDraftOrderId && (
              <Form method="post" style={{ display: "inline" }}>
                <input type="hidden" name="intent" value="send_invoice" />
                <button
                  disabled={isSubmitting}
                  style={{ ...styles.btn, background: "#005bd3", color: "white" }}
                >
                  {submittingIntent === "send_invoice" ? "Updating..." : "Update Invoice"}
                </button>
              </Form>
            )}
            {canConvert && (
              <Form method="post" style={{ display: "inline" }}>
                <input type="hidden" name="intent" value="create_order_manual" />
                <button
                  disabled={isSubmitting}
                  style={{ ...styles.btn, background: "#166534", color: "white" }}
                >
                  {submittingIntent === "create_order_manual" ? "Creating..." : "Create Order (Manual)"}
                </button>
              </Form>
            )}
            {quote.shopifyDraftOrderId && (
              <Form method="post" style={{ display: "inline" }}>
                <input type="hidden" name="intent" value="preview_invoice" />
                <button
                  disabled={isSubmitting}
                  style={{ ...styles.btn, background: "#fff", border: "1px solid #c9ccd0" }}
                >
                  {submittingIntent === "preview_invoice" ? "Loading..." : "Preview Invoice"}
                </button>
              </Form>
            )}
            {isDraft && (
              <Form method="post" style={{ display: "inline" }}>
                <input type="hidden" name="intent" value="cancel_quote" />
                <button
                  disabled={isSubmitting}
                  onClick={(e) => { if (!confirm("Cancel this quote?")) e.preventDefault(); }}
                  style={{ ...styles.btn, background: "#fff", border: "1px solid #c9ccd0", color: "#b91b1b" }}
                >
                  Cancel
                </button>
              </Form>
            )}
            <Form method="post" style={{ display: "inline" }}>
              <input type="hidden" name="intent" value="delete_quote" />
              <button
                disabled={isSubmitting}
                onClick={(e) => { if (!confirm("Delete this quote permanently?")) e.preventDefault(); }}
                style={{ ...styles.btn, background: "#fff", border: "1px solid #fecaca", color: "#b91b1b" }}
              >
                Delete
              </button>
            </Form>
          </div>
        </div>
      </div>

      <div style={styles.content}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 20, alignItems: "start" }}>
          {/* Main Column */}
          <div style={{ display: "flex", flexDirection: "column", gap: 20, minWidth: 0, overflow: "hidden" }}>
            {/* Customer Info */}
            <div style={styles.card}>
              <h3 style={styles.cardTitle}>Customer Information</h3>
              <div style={styles.infoGrid}>
                <div>
                  <span style={styles.label}>Company</span>
                  <Link to={`/app/companies/${quote.companyId}`} style={styles.link}>{quote.companyName}</Link>
                </div>
                <div>
                  <span style={styles.label}>Customer</span>
                  <span>{quote.customerFirstName || ""} {quote.customerLastName || ""}</span>
                </div>
                <div>
                  <span style={styles.label}>Email</span>
                  <span>{quote.customerEmail}</span>
                </div>
                <div>
                  <span style={styles.label}>Sales Agent</span>
                  <span>{quote.salesAgentName}</span>
                </div>
                <div>
                  <span style={styles.label}>Created</span>
                  <span>{fmtDate(quote.createdAt)}</span>
                </div>
                <div>
                  <span style={styles.label}>Expires</span>
                  <span>{fmtDate(quote.expiresAt)}</span>
                </div>
              </div>
            </div>

            {/* Line Items */}
            <div style={styles.card}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                <h3 style={{ ...styles.cardTitle, margin: 0 }}>Line Items ({quote.items.length})</h3>
                {canEditDiscount && (
                  <button
                    type="button"
                    onClick={() => setShowDiscountForm(!showDiscountForm)}
                    style={{ ...styles.btn, background: "#fff", border: "1px solid #c9ccd0", fontSize: 13 }}
                  >
                    {showDiscountForm ? "Hide Discount" : "Order Discount"}
                  </button>
                )}
              </div>

              {/* Order Discount Form */}
              {showDiscountForm && canEditDiscount && (
                <div style={styles.discountForm}>
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                    <Form method="post" style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                      <input type="hidden" name="intent" value="apply_order_discount" />
                      <div>
                        <label style={styles.label}>Type</label>
                        <select
                          name="discountType"
                          value={discountType}
                          onChange={(e) => setDiscountType(e.target.value)}
                          style={styles.select}
                        >
                          <option value="FIXED_AMOUNT">Fixed Amount ({quote.currencyCode})</option>
                          <option value="PERCENTAGE">Percentage (%)</option>
                        </select>
                      </div>
                      <div>
                        <label style={styles.label}>Amount</label>
                        <input
                          name="discountAmount"
                          type="number"
                          step="0.01"
                          min="0"
                          value={discountValue}
                          onChange={(e) => setDiscountValue(e.target.value)}
                          style={styles.input}
                        />
                      </div>
                      <button type="submit" disabled={isSubmitting} style={{ ...styles.btn, background: "#005bd3", color: "white" }}>
                        Apply
                      </button>
                    </Form>
                    {Number(quote.discountTotal) > 0 && (
                      <Form method="post" style={{ display: "inline" }}>
                        <input type="hidden" name="intent" value="remove_order_discount" />
                        <button type="submit" disabled={isSubmitting} style={{ ...styles.btn, background: "#fff", border: "1px solid #c9ccd0", color: "#b91b1b" }}>
                          Remove
                        </button>
                      </Form>
                    )}
                  </div>
                </div>
              )}

              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={{ ...styles.th, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis" }}>Product</th>
                    <th style={styles.th}>SKU</th>
                    <th style={{ ...styles.th, textAlign: "center" }}>Qty</th>
                    <th style={{ ...styles.th, textAlign: "right" }}>Unit Price</th>
                    <th style={{ ...styles.th, textAlign: "right" }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {quote.items.map((item: any) => (
                    <tr key={item.id} style={{ borderTop: "1px solid #eef1f4" }}>
                      <td style={{ ...styles.td, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                          {item.image && (
                            <img src={item.image} alt="" style={{ width: 36, height: 36, borderRadius: 6, objectFit: "cover", flexShrink: 0 }} />
                          )}
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.productTitle}</div>
                            {item.variantTitle && <div style={{ fontSize: 12, color: "#5c5f62", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.variantTitle}</div>}
                          </div>
                        </div>
                      </td>
                      <td style={styles.td}>{item.sku || "–"}</td>
                      <td style={{ ...styles.td, textAlign: "center" }}>
                        {item.quantity}
                      </td>
                      <td style={{ ...styles.td, textAlign: "right" }}>
                        {fmtMoney(item.unitPrice, item.currencyCode)}
                      </td>
                      <td style={{ ...styles.td, textAlign: "right", fontWeight: 600 }}>
                        {fmtMoney(item.totalPrice, item.currencyCode)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Activity */}
            <div style={styles.card}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <h3 style={styles.cardTitle}>Activity</h3>
                {quote.activities?.length > 10 && (
                  <button
                    type="button"
                    onClick={() => setShowAllActivities((v) => !v)}
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      padding: "2px 6px",
                      fontSize: 16,
                      color: "#2c6ecb",
                      lineHeight: 1,
                    }}
                    title={showAllActivities ? "Show less" : "Show all"}
                  >
                    {showAllActivities ? "\u25B2" : "\u25BC"}
                  </button>
                )}
              </div>
              {quote.activities?.length ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                  {(showAllActivities ? quote.activities : quote.activities.slice(0, 10)).map((act: any, idx: number, arr: any[]) => (
                    <div
                      key={act.id}
                      style={{
                        display: "flex",
                        gap: 12,
                        padding: "10px 0",
                        borderBottom: idx < arr.length - 1 ? "1px solid #f3f4f6" : "none",
                      }}
                    >
                      <div
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: "50%",
                          background: "#2c6ecb",
                          marginTop: 6,
                          flexShrink: 0,
                        }}
                      />
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{act.action}</div>
                        {act.message && <div style={{ fontSize: 13, color: "#5c5f62", marginTop: 2 }}>{act.message}</div>}
                        <div style={{ fontSize: 12, color: "#8c9196", marginTop: 2 }}>{fmtDateTime(act.createdAt)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ color: "#5c5f62", margin: 0 }}>No activity yet.</p>
              )}
            </div>
          </div>

          {/* Sidebar */}
          <div style={{ display: "flex", flexDirection: "column", gap: 20, position: "sticky", top: 20 }}>
            {/* Order Summary */}
            <div style={styles.card}>
              <h3 style={styles.cardTitle}>Order Summary</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={styles.summaryRow}>
                  <span>Subtotal</span>
                  <span>{fmtMoney(quote.subtotal, quote.currencyCode)}</span>
                </div>
                {Number(quote.discountTotal) > 0 && (
                  <div style={{ ...styles.summaryRow, color: "#166534" }}>
                    <span>
                      Discount
                      {quote.discountType === "PERCENTAGE" && ` (${quote.discountAmount}%)`}
                    </span>
                    <span>-{fmtMoney(quote.discountTotal, quote.currencyCode)}</span>
                  </div>
                )}
                {Number(quote.taxAmount) > 0 && (
                  <div style={styles.summaryRow}>
                    <span>Tax ({Number(quote.taxRate).toFixed(1)}%)</span>
                    <span>{fmtMoney(quote.taxAmount, quote.currencyCode)}</span>
                  </div>
                )}
                {Number(quote.shippingAmount) > 0 && (
                  <div style={styles.summaryRow}>
                    <span>Shipping</span>
                    <span>{fmtMoney(quote.shippingAmount, quote.currencyCode)}</span>
                  </div>
                )}
                <div style={{ ...styles.summaryRow, borderTop: "2px solid #e5e7eb", paddingTop: 10, marginTop: 4, fontWeight: 700, fontSize: 16 }}>
                  <span>Total</span>
                  <span>{fmtMoney(quote.totalAmount, quote.currencyCode)}</span>
                </div>
              </div>
            </div>

            {/* Quick Info */}
            <div style={styles.card}>
              <h3 style={styles.cardTitle}>Details</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#5c5f62" }}>Quote #</span>
                  <span style={{ fontWeight: 600 }}>{quote.shopifyDraftOrderId || quote.quoteNumber}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#5c5f62" }}>Status</span>
                  <span style={{ fontWeight: 600, color: STATUS_COLORS[quote.status], textTransform: "capitalize" }}>{quote.status}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#5c5f62" }}>Currency</span>
                  <span>{quote.currencyCode}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#5c5f62" }}>Items</span>
                  <span>{quote.items.length}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#5c5f62" }}>Created</span>
                  <span>{fmtDate(quote.createdAt)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#5c5f62" }}>Expires</span>
                  <span>{fmtDate(quote.expiresAt)}</span>
                </div>
                {quote.sentAt && (
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "#5c5f62" }}>Sent</span>
                    <span>{fmtDate(quote.sentAt)}</span>
                  </div>
                )}
                {quote.convertedOrderId && (
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "#5c5f62" }}>Order ID</span>
                    <span style={{ fontWeight: 600 }}>{quote.convertedOrderId.slice(0, 12)}...</span>
                  </div>
                )}
              </div>
            </div>

            {/* Customer Comments */}
            {quote.customerComments && (
              <div style={styles.card}>
                <h3 style={styles.cardTitle}>Customer Comments</h3>
                <p style={{ margin: 0, fontSize: 13 }}>{quote.customerComments}</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Invoice Preview Modal */}
      {showInvoiceModal && invoiceData && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.5)",
          }}
          onClick={() => { setShowInvoiceModal(false); setInvoiceData(null); }}
        >
          <div
            style={{
              position: "relative",
              width: "90vw",
              maxWidth: 800,
              maxHeight: "90vh",
              background: "#fff",
              borderRadius: 12,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: "1px solid #e3e7ec" }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Invoice Preview — {quote.shopifyDraftOrderName || quote.quoteNumber}</h3>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button
                  type="button"
                  onClick={() => window.print()}
                  style={{ ...styles.btn, background: "#005bd3", color: "#fff", padding: "6px 12px", fontSize: 12 }}
                >
                  Print / Save PDF
                </button>
                <button
                  type="button"
                  onClick={() => { setShowInvoiceModal(false); setInvoiceData(null); }}
                  style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "#5c5f62", padding: "0 4px", lineHeight: 1 }}
                >
                  &times;
                </button>
              </div>
            </div>
            <div style={{ padding: "24px 32px", overflowY: "auto", flex: 1 }}>
              {/* Header */}
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 24 }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>INVOICE</h2>
                  <p style={{ margin: "4px 0 0", color: "#5c5f62", fontSize: 13 }}>{quote.shopifyDraftOrderName || quote.quoteNumber}</p>
                </div>
                <div style={{ textAlign: "right", fontSize: 13, color: "#5c5f62" }}>
                  <p style={{ margin: 0 }}><strong>Date:</strong> {invoiceData.createdAt ? new Date(invoiceData.createdAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "–"}</p>
                  {invoiceData.invoiceSentAt && (
                    <p style={{ margin: "2px 0 0" }}><strong>Sent:</strong> {new Date(invoiceData.invoiceSentAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</p>
                  )}
                </div>
              </div>

              {/* Customer */}
              {invoiceData.customer && (
                <div style={{ marginBottom: 24, fontSize: 13 }}>
                  <strong>Bill To:</strong>
                  <p style={{ margin: "4px 0 0" }}>
                    {[invoiceData.customer.firstName, invoiceData.customer.lastName].filter(Boolean).join(" ")}
                  </p>
                  {invoiceData.customer.email && <p style={{ margin: "2px 0 0", color: "#5c5f62" }}>{invoiceData.customer.email}</p>}
                </div>
              )}

              {/* Line Items Table */}
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginBottom: 24 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: "8px 10px", background: "#f4f6f8", borderBottom: "1px solid #e3e7ec", fontWeight: 600, color: "#5c5f62" }}>Product</th>
                    <th style={{ textAlign: "left", padding: "8px 10px", background: "#f4f6f8", borderBottom: "1px solid #e3e7ec", fontWeight: 600, color: "#5c5f62" }}>SKU</th>
                    <th style={{ textAlign: "center", padding: "8px 10px", background: "#f4f6f8", borderBottom: "1px solid #e3e7ec", fontWeight: 600, color: "#5c5f62" }}>Qty</th>
                    <th style={{ textAlign: "right", padding: "8px 10px", background: "#f4f6f8", borderBottom: "1px solid #e3e7ec", fontWeight: 600, color: "#5c5f62" }}>Unit Price</th>
                    <th style={{ textAlign: "right", padding: "8px 10px", background: "#f4f6f8", borderBottom: "1px solid #e3e7ec", fontWeight: 600, color: "#5c5f62" }}>Discount</th>
                    <th style={{ textAlign: "right", padding: "8px 10px", background: "#f4f6f8", borderBottom: "1px solid #e3e7ec", fontWeight: 600, color: "#5c5f62" }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {(invoiceData.lineItems || []).map((item: any, idx: number) => (
                    <tr key={idx}>
                      <td style={{ padding: "8px 10px", borderBottom: "1px solid #f0f0f0" }}>
                        {item.title}
                        {item.variantTitle && <span style={{ color: "#5c5f62" }}> — {item.variantTitle}</span>}
                      </td>
                      <td style={{ padding: "8px 10px", borderBottom: "1px solid #f0f0f0", color: "#5c5f62" }}>{item.sku || "–"}</td>
                      <td style={{ padding: "8px 10px", borderBottom: "1px solid #f0f0f0", textAlign: "center" }}>{item.quantity}</td>
                      <td style={{ padding: "8px 10px", borderBottom: "1px solid #f0f0f0", textAlign: "right" }}>
                        {fmtMoney(item.originalUnitPrice, invoiceData.currencyCode)}
                      </td>
                      <td style={{ padding: "8px 10px", borderBottom: "1px solid #f0f0f0", textAlign: "right", color: Number(item.discount) > 0 ? "#b91b1b" : undefined }}>
                        {Number(item.discount) > 0 ? `-${fmtMoney(item.discount, invoiceData.currencyCode)}` : "–"}
                      </td>
                      <td style={{ padding: "8px 10px", borderBottom: "1px solid #f0f0f0", textAlign: "right", fontWeight: 600 }}>
                        {fmtMoney(item.discountedTotal, invoiceData.currencyCode)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Totals */}
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <div style={{ width: 280, fontSize: 13 }}>
                  <div style={styles.summaryRow}><span>Subtotal</span><span>{fmtMoney(invoiceData.subtotal, invoiceData.currencyCode)}</span></div>
                  {Number(invoiceData.totalDiscounts) > 0 && (
                    <div style={styles.summaryRow}><span>Discount</span><span style={{ color: "#b91b1b" }}>-{fmtMoney(invoiceData.totalDiscounts, invoiceData.currencyCode)}</span></div>
                  )}
                  {Number(invoiceData.totalShipping) > 0 && (
                    <div style={styles.summaryRow}><span>Shipping</span><span>{fmtMoney(invoiceData.totalShipping, invoiceData.currencyCode)}</span></div>
                  )}
                  {Number(invoiceData.totalTax) > 0 && (
                    <div style={styles.summaryRow}><span>Tax</span><span>{fmtMoney(invoiceData.totalTax, invoiceData.currencyCode)}</span></div>
                  )}
                  <div style={{ ...styles.summaryRow, fontWeight: 700, fontSize: 15, borderTop: "2px solid #e3e7ec", marginTop: 8, paddingTop: 8 }}>
                    <span>Total</span>
                    <span>{fmtMoney(invoiceData.totalPrice, invoiceData.currencyCode)}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    background: "#f1f2f4",
    minHeight: "100vh",
    padding: 24,
    boxSizing: "border-box",
    fontFamily: '-apple-system, BlinkMacSystemFont, "San Francisco", "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
  },
  hero: {
    width: "100%",
    maxWidth: 1200,
    margin: "0 auto 18px",
    borderRadius: 14,
    border: "1px solid #dfe3e8",
    background: "linear-gradient(135deg, #ffffff 0%)",
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
  },
  heroTitle: {
    fontSize: 22,
    lineHeight: 1.15,
    fontWeight: 650,
    color: "#202223",
    margin: "15px 15px 4px",
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
  },
  heroText: {
    fontSize: 14,
    color: "#5c5f62",
    margin: "0 15px 0",
  },
  content: {
    width: "100%",
    maxWidth: 1200,
    margin: "0 auto",
  },
  card: {
    background: "#ffffff",
    border: "1px solid #e3e7ec",
    borderRadius: 12,
    padding: 18,
    minWidth: 0,
    overflow: "hidden",
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: 650,
    color: "#202223",
    margin: "0 0 14px",
  },
  infoGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
    gap: 12,
  },
  label: {
    display: "block",
    fontSize: 12,
    fontWeight: 600,
    color: "#5c5f62",
    marginBottom: 2,
  },
  link: { color: "#2c6ecb", textDecoration: "none", fontWeight: 600 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13, tableLayout: "fixed" },
  th: {
    textAlign: "left",
    padding: "10px 12px",
    fontSize: 12,
    fontWeight: 650,
    color: "#5c5f62",
    background: "#fbfbfc",
    borderBottom: "1px solid #e3e7ec",
    whiteSpace: "nowrap",
  },
  td: {
    padding: "12px",
    verticalAlign: "middle",
    color: "#202223",
  },
  btn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "9px 16px",
    borderRadius: 8,
    border: "1px solid transparent",
    fontWeight: 600,
    fontSize: 13,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  smallBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "5px 10px",
    borderRadius: 6,
    border: "1px solid transparent",
    fontWeight: 600,
    fontSize: 12,
    cursor: "pointer",
  },
  input: {
    height: 36,
    border: "1px solid #c9ccd0",
    borderRadius: 8,
    padding: "0 10px",
    fontSize: 13,
    background: "#fff",
    color: "#202223",
    font: "inherit",
  },
  inputFull: {
    width: "100%",
    height: 40,
    border: "1px solid #c9ccd0",
    borderRadius: 8,
    padding: "0 11px",
    fontSize: 13,
    background: "#fff",
    color: "#202223",
    font: "inherit",
    boxSizing: "border-box",
  },
  select: {
    height: 36,
    border: "1px solid #c9ccd0",
    borderRadius: 8,
    padding: "0 8px",
    fontSize: 13,
    background: "#fff",
    color: "#202223",
    font: "inherit",
  },
  textarea: {
    width: "100%",
    border: "1px solid #c9ccd0",
    borderRadius: 8,
    padding: "8px 11px",
    fontSize: 13,
    background: "#fff",
    color: "#202223",
    font: "inherit",
    resize: "vertical",
    boxSizing: "border-box",
  },
  discountForm: {
    padding: 14,
    background: "#f8fbff",
    border: "1px solid #dde3ea",
    borderRadius: 10,
    marginBottom: 14,
  },
  summaryRow: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: 13,
    color: "#202223",
  },
};
