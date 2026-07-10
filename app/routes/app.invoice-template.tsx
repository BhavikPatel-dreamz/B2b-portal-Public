import { useEffect, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
} from "react-router";
import { Link, useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

type LoaderData = {
  shopName: string;
  logo: string;
  contactEmail: string;
  invoiceTemplate: string;
};

type ActionData = {
  success: boolean;
  message?: string;
  errors?: string[];
  invoiceTemplate?: string;
};

const DEFAULT_LOGO =
  "https://cdn.shopify.com/s/files/applications/c6da0a0589e2c3c978aadf2afec07db7_200x200.png?v=1776950914";

const DEFAULT_INVOICE_TEMPLATE =
 `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #1a1a1a;
      padding: 40px 48px;
      background: #f0f0f0;
      font-size: 14px;
      line-height: 1.5;
    }

    .actions { display: flex; justify-content: flex-end; gap: 12px; margin-bottom: 20px; max-width: 960px; margin-left: auto; margin-right: auto; }
    .btn { appearance: none; border: 1px solid #c9cccf; background: white; color: #303030; border-radius: 8px; padding: 10px 16px; font-size: 14px; font-weight: 600; cursor: pointer; text-decoration: none; }
    .btn.primary { background: #303030; color: white; border-color: #303030; }

    .invoice-container {
      max-width: 960px;
      margin: 0 auto;
      background: #fff;
      border: 1px solid #d1d5db;
      border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.07);
      padding: 48px 52px;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 40px;
      padding-bottom: 32px;
      border-bottom: 1px solid #e5e7eb;
    }
    .logo { width: 110px; height: 110px; object-fit: contain; border-radius: 18px; }
    .invoice-meta { text-align: right; color: #555; font-size: 14px; line-height: 2; border-collapse: collapse; }
    .invoice-meta td:first-child { color: #888; padding-right: 24px; }
    .invoice-meta td:last-child { font-weight: 500; color: #1a1a1a; }

    .addresses {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 36px;
      gap: 40px;
      padding-bottom: 32px;
      border-bottom: 1px solid #e5e7eb;
    }
    .address-box { flex: 1; }
    .address-box h2 { font-size: 15px; font-weight: 700; color: #1a1a1a; margin-bottom: 8px; }
    .address-box .sub-label { font-weight: 700; font-size: 13px; color: #1a1a1a; margin-bottom: 4px; }
    .address-box p { font-size: 13px; color: #444; line-height: 1.6; margin: 0 0 2px 0; }
    .address-right { text-align: right; }
    .address-right h2 { text-align: right; }
    .address-right p, .address-right .sub-label { text-align: right; }

    .table { width: 100%; border-collapse: collapse; margin-bottom: 32px; border-radius: 8px; overflow: hidden; }
    .table thead tr { background: #1a73e8; color: #fff; }
    .table th { padding: 12px 14px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; text-align: left; }
    .table th.num { text-align: right; }
    .table tbody tr { border-left: 1px solid #e5e7eb; border-right: 1px solid #e5e7eb; }
    .table tbody tr:nth-child(even) { background: #f9fafb; }
    .table td { padding: 14px; font-size: 14px; color: #333; border-bottom: 1px solid #e5e7eb; }
    .table td.num { text-align: right; }
    .table tbody tr:last-child td { border-bottom: 1px solid #e5e7eb; }

    .totals-wrapper { display: flex; justify-content: flex-end; margin-bottom: 8px; }
    .totals-box {
      width: 320px;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      overflow: hidden;
    }
    .total-row {
      display: flex;
      justify-content: space-between;
      padding: 10px 16px;
      font-size: 14px;
      color: #333;
      border-bottom: 1px solid #e5e7eb;
    }
    .total-row:last-child { border-bottom: none; }
    .total-row.grand-total {
      background: #1a73e8;
      color: #fff;
      font-weight: 800;
      font-size: 15px;
    }
    .total-row.grand-total span { color: #fff; }

    @media print {
      body { padding: 0; background: #fff; }
      .actions { display: none; }
      .invoice-container {
        border: none;
        box-shadow: none;
        border-radius: 0;
        padding: 32px;
      }
    }
  </style>
</head>
<body>
  <div class="actions">
    <button class="btn primary" onclick="window.print()">Print / Save PDF</button>
  </div>
  <div class="invoice-container">

    <!-- Header -->
    <div class="header">
      <img
        src="{{logoUrl}}"
        class="logo"
        alt="{{shopName}}"
        onerror="this.src='https://cdn.shopify.com/s/files/applications/c6da0a0589e2c3c978aadf2afec07db7_200x200.png?v=1776950914'"
      />
      <table class="invoice-meta">
        <tr><td>Invoice no.:</td><td>{{orderNumber}}</td></tr>
        <tr><td>Invoice date:</td><td>{{orderDate}}</td></tr>
        <tr><td>Due:</td><td>{{dueDate}}</td></tr>
      </table>
    </div>

    <!-- Bill From / Bill To -->
    <div class="addresses">
      <div class="address-box">
        <h2>Bill From</h2>
        <p class="sub-label">{{shopName}}</p>
        <p>{{contactEmail}}, {{shopUrl}}, {{shopPhone}}</p>
        <p>{{shopAddress}}</p>
      </div>
      <div class="address-box address-right">
        <h2>Bill To</h2>
        <p class="sub-label">{{companyName}}</p>
        <p>{{customerName}}, {{customerPhone}}</p>
        <p>{{shippingAddress}}</p>
      </div>
    </div>

    <!-- Line Items Table -->
    <table class="table">
      <thead>
        <tr>
          <th>Description</th>
          <th class="num">Rate, USD</th>
          <th class="num">Qty/Hrs</th>
          <th class="num">Tax</th>
          <th class="num">Amount, USD</th>
        </tr>
      </thead>
      <tbody>
        {{lineItems}}
      </tbody>
    </table>

    <!-- Totals -->
    <div class="totals-wrapper">
      <div class="totals-box">
        <div class="total-row"><span>Subtotal</span><span>{{subtotal}}</span></div>
        <div class="total-row"><span>Taxes</span><span>{{tax}}</span></div>
        <div class="total-row"><span>Shipping Cost</span><span>{{shippingCost}}</span></div>
        <div class="total-row grand-total"><span>Total</span><span>{{orderTotal}}</span></div>
      </div>
    </div>

  </div>
</body>
</html>`;

const PREVIEW_VARIABLE_VALUES: Record<string, string> = {
  "{{companyName}}": "Billing Order in order",
  "{{customerName}}": "order amil",
  "{{customerPhone}}": "Order phone",
  "{{orderNumber}}": "#1049",
  "{{orderDate}}": "Jun 17, 2026",
  "{{dueDate}}": "Jun 17, 2026",
  "{{orderTotal}}": "$1,423.00",
  "{{subtotal}}": "$1,423.00",
  "{{tax}}": "$0.00",
  "{{shippingCost}}": "$0.00",
  "{{shopName}}": "Shopify Owner information",
  "{{ownerEmail}}": "owner@example.com",
  "{{shopUrl}}": "mystore.myshopify.com",
  "{{shopPhone}}": "1234556789",
  "{{shopAddress}}":
    "HANUMAN SHERI SAGRAMPURA, 2A-1361 62 PAIKI 2ND FLOOR BALAJI HOUSE, 395002, Surat, Gujarat, India",
  "{{contactEmail}}": "owner@example.com",
  "{{logoUrl}}": DEFAULT_LOGO,
  "{{orderNotes}}": "",
  "{{shippingAddress}}": "123 Business Ave, Suite 100, New York, NY 10001, USA",
  "{{lineItems}}": `
    <tr>
      <td>Item1</td>
      <td class="num">3.00</td>
      <td class="num">201</td>
      <td class="num">0.00%</td>
      <td class="num">603.00</td>
    </tr>
    <tr>
      <td>Item2</td>
      <td class="num">4.00</td>
      <td class="num">200</td>
      <td class="num">0.00%</td>
      <td class="num">800.00</td>
    </tr>
    <tr>
      <td>Item3</td>
      <td class="num">5.00</td>
      <td class="num">4</td>
      <td class="num">0.00%</td>
      <td class="num">20.00</td>
    </tr>
  `,
};

const INVOICE_VARIABLES = [
  { variable: "{{companyName}}", description: "Billing company name" },
  { variable: "{{customerName}}", description: "Customer's full name" },
  { variable: "{{customerPhone}}", description: "Customer's phone" },
  { variable: "{{orderNumber}}", description: "Shopify order number" },
  { variable: "{{orderDate}}", description: "Date of the order" },
  { variable: "{{dueDate}}", description: "Due date of the invoice" },
  { variable: "{{orderTotal}}", description: "Total amount of the order" },
  { variable: "{{subtotal}}", description: "Subtotal before tax" },
  { variable: "{{tax}}", description: "Tax amount" },
  { variable: "{{shippingCost}}", description: "Shipping cost" },
  { variable: "{{lineItems}}", description: "Table rows for order items" },
  { variable: "{{shopName}}", description: "Shopify store / owner name" },
  { variable: "{{contactEmail}}", description: "Store contact email" },
  { variable: "{{shopUrl}}", description: "Store website URL" },
  { variable: "{{shopPhone}}", description: "Store phone number" },
  { variable: "{{shopAddress}}", description: "Store address" },
  { variable: "{{logoUrl}}", description: "Store logo URL" },
  { variable: "{{orderNotes}}", description: "Notes added to the order" },
  { variable: "{{shippingAddress}}", description: "Shipping address" },
];

// ── CACHE for invoice template loader ──────────────────────────
declare global {
  var __invoiceTemplateCache:
    | Map<string, { data: unknown; timestamp: number }>
    | undefined;
}

const invoiceTemplateCache: Map<string, { data: unknown; timestamp: number }> =
  globalThis.__invoiceTemplateCache ?? (globalThis.__invoiceTemplateCache = new Map());

const INVOICE_TEMPLATE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // ── CACHE CHECK ──
  const cacheKey = `invoice-template-${session.shop}`;
  const cached = invoiceTemplateCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < INVOICE_TEMPLATE_CACHE_TTL) {
    console.log(`⚡ Invoice template cache HIT → ${cacheKey}`);
    return Response.json(cached.data);
  }

  console.log("🐢 Invoice template cache MISS → querying DB");

  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
    select: {
      shopName: true,
      logo: true,
      contactEmail: true,
      invoiceTemplate: true,
    },
  });

  if (!store) {
    throw new Response("Store not found", { status: 404 });
  }

  const result = {
    shopName: store.shopName || session.shop,
    logo: store.logo || "",
    contactEmail: store.contactEmail || "",
    invoiceTemplate: store.invoiceTemplate || DEFAULT_INVOICE_TEMPLATE,
  } satisfies LoaderData;

  invoiceTemplateCache.set(cacheKey, { data: result, timestamp: Date.now() });

  return Response.json(result);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });

  if (!store) {
    return Response.json(
      { success: false, errors: ["Store not found"] } satisfies ActionData,
      { status: 404 },
    );
  }

  const formData = await request.formData();
  const html = String(formData.get("html") || "").trim();

  if (!html) {
    return Response.json(
      {
        success: false,
        errors: ["Template content is required"],
      } satisfies ActionData,
      { status: 400 },
    );
  }

  await prisma.store.update({
    where: { id: store.id },
    data: { invoiceTemplate: html },
  });

  return Response.json({
    success: true,
    message: "Invoice template saved successfully",
    invoiceTemplate: html,
  } satisfies ActionData);
};

export default function InvoiceTemplateEditor() {
  const {
    shopName,
    logo,
    contactEmail,
    invoiceTemplate: initialTemplate,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const shopify = useAppBridge();

  const [htmlContent, setHtmlContent] = useState(initialTemplate);
  const [showPreview, setShowPreview] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.innerText = htmlContent;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show(fetcher.data.message || "Saved");
    } else if (fetcher.data?.errors) {
      shopify.toast.show(fetcher.data.errors[0], { isError: true });
    }
  }, [fetcher.data, shopify]);

  // Close preview on Escape key
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowPreview(false);
    };
    if (showPreview) {
      document.addEventListener("keydown", handleEsc);
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.removeEventListener("keydown", handleEsc);
      document.body.style.overflow = "";
    };
  }, [showPreview]);

  const handleInput = () => {
    if (editorRef.current) {
      setHtmlContent(editorRef.current.innerText);
    }
  };

  const insertVariable = (variable: string) => {
    if (!editorRef.current) return;
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) {
      editorRef.current.focus();
      return;
    }
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const textNode = document.createTextNode(variable);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.setEndAfter(textNode);
    selection.removeAllRanges();
    selection.addRange(range);
    setHtmlContent(editorRef.current.innerText);
    editorRef.current.focus();
  };

  const handleSave = () => {
    fetcher.submit({ html: htmlContent }, { method: "post" });
  };

  const resolvedLogo = logo || DEFAULT_LOGO;

  const currentPreviewVariables: Record<string, string> = {
    ...PREVIEW_VARIABLE_VALUES,
    "{{shopName}}": shopName,
    "{{contactEmail}}": contactEmail,
    "{{ownerEmail}}": contactEmail,
    "{{logoUrl}}": resolvedLogo,
  };

  const previewHtml = Object.entries(currentPreviewVariables).reduce(
    (acc, [key, val]) => acc.replaceAll(key, val),
    htmlContent,
  );

  return (
    <div style={{ padding: "20px", background: "#f6f6f7", minHeight: "100vh" }}>
      <div style={{ maxWidth: "1100px", margin: "0 auto" }}>

        {/* ── Page Header ── */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "20px",
          }}
        >
          <div>
             <Link
                      to="/app/settings"
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
                      <svg
                        viewBox="0 0 20 20"
                        style={{ width: "16px", height: "16px" }}
                        fill="currentColor"
                      >
                        <path
                          fillRule="evenodd"
                          d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z"
                          clipRule="evenodd"
                        />
                      </svg>
                      Back to Settings
              </Link>
            <h1 style={{ fontSize: "24px", fontWeight: "bold", margin: "10px 0" }}>
              Invoice Template Editor
            </h1>
          </div>
          <div style={{ display: "flex", gap: "10px" }}>
            <button
              onClick={() => setShowPreview(true)}
              style={{
                padding: "8px 16px",
                borderRadius: "6px",
                border: "1px solid #c9cccf",
                background: "#fff",
                cursor: "pointer",
                fontSize: "14px",
                fontWeight: "600",
                display: "flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              {/* Eye icon */}
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M10 4C5.5 4 2 10 2 10s3.5 6 8 6 8-6 8-6-3.5-6-8-6z" stroke="#303030" strokeWidth="1.5" strokeLinejoin="round"/>
                <circle cx="10" cy="10" r="2.5" stroke="#303030" strokeWidth="1.5"/>
              </svg>
              Show Preview
            </button>
            <button
              onClick={handleSave}
              disabled={fetcher.state !== "idle"}
              style={{
                padding: "8px 16px",
                borderRadius: "6px",
                border: "none",
                background: "#008060",
                color: "#fff",
                cursor: fetcher.state !== "idle" ? "not-allowed" : "pointer",
                fontWeight: "600",
                fontSize: "14px",
                opacity: fetcher.state !== "idle" ? 0.7 : 1,
              }}
            >
              {fetcher.state !== "idle" ? "Saving..." : "Save Template"}
            </button>
          </div>
        </div>

        {/* ── Editor Panel (always visible) ── */}
        <div
          style={{
            background: "#fff",
            borderRadius: "8px",
            border: "1px solid #dfe3e8",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Variable chips */}
          <div
            style={{
              padding: "10px 12px",
              borderBottom: "1px solid #dfe3e8",
              background: "#f9f9f9",
              display: "flex",
              gap: "6px",
              flexWrap: "wrap",
            }}
          >
            {INVOICE_VARIABLES.map((v) => (
              <button
                key={v.variable}
                onClick={() => insertVariable(v.variable)}
                title={v.description}
                style={{
                  padding: "3px 8px",
                  fontSize: "12px",
                  borderRadius: "4px",
                  border: "1px solid #c9cccf",
                  background: "#fff",
                  cursor: "pointer",
                  color: "#303030",
                }}
              >
                {v.variable}
              </button>
            ))}
          </div>

          {/* Contenteditable editor */}
          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            onInput={handleInput}
            style={{
              padding: "20px",
              minHeight: "600px",
              fontFamily: "monospace",
              fontSize: "13px",
              outline: "none",
              whiteSpace: "pre-wrap",
              overflowY: "auto",
              flex: 1,
              color: "#1a1a1a",
            }}
          />
        </div>
      </div>

      {/* ── Full-Screen Preview Modal ── */}
      {showPreview && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 99999,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "24px",
          }}
          onClick={() => setShowPreview(false)}
        >
          {/* Modal card */}
          <div
            style={{
              width: "100%",
              maxWidth: "1100px",
              height: "90vh",
              background: "#fff",
              borderRadius: "12px",
              boxShadow: "0 24px 64px rgba(0,0,0,0.25)",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal top bar */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "14px 20px",
                borderBottom: "1px solid #dfe3e8",
                background: "#f9f9f9",
                flexShrink: 0,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                {/* Eye icon */}
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M10 4C5.5 4 2 10 2 10s3.5 6 8 6 8-6 8-6-3.5-6-8-6z" stroke="#303030" strokeWidth="1.5" strokeLinejoin="round"/>
                  <circle cx="10" cy="10" r="2.5" stroke="#303030" strokeWidth="1.5"/>
                </svg>
                <span style={{ fontWeight: "600", fontSize: "15px", color: "#202223" }}>
                  Invoice Preview
                </span>
                <span
                  style={{
                    fontSize: "12px",
                    color: "#6d7175",
                    background: "#f1f2f4",
                    padding: "2px 8px",
                    borderRadius: "20px",
                    border: "1px solid #e3e3e3",
                  }}
                >
                  Preview only — save template to apply changes
                </span>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                {/* Save from modal */}
                <button
                  onClick={handleSave}
                  disabled={fetcher.state !== "idle"}
                  style={{
                    padding: "8px 16px",
                    borderRadius: "6px",
                    border: "none",
                    background: "#008060",
                    color: "#fff",
                    cursor: fetcher.state !== "idle" ? "not-allowed" : "pointer",
                    fontWeight: "600",
                    fontSize: "14px",
                    opacity: fetcher.state !== "idle" ? 0.7 : 1,
                  }}
                >
                  {fetcher.state !== "idle" ? "Saving..." : "Save Template"}
                </button>

                {/* Close button */}
                <button
                  onClick={() => setShowPreview(false)}
                  title="Close preview (Esc)"
                  style={{
                    width: "34px",
                    height: "34px",
                    borderRadius: "6px",
                    border: "1px solid #c9cccf",
                    background: "#fff",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "18px",
                    color: "#303030",
                    lineHeight: 1,
                  }}
                >
                  ✕
                </button>
              </div>
            </div>

            {/* iframe fills remaining height */}
            <iframe
              title="Invoice Preview"
              srcDoc={previewHtml}
              style={{
                width: "100%",
                flex: 1,
                border: "none",
                background: "#f0f0f0",
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}