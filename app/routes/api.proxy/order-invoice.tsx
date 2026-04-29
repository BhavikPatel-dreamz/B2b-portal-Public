import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../../shopify.server";
import { getStoreByDomain } from "../../services/store.server";
import {
  getCompanyOrderById,
  getCustomerCompanyInfo,
} from "../../utils/b2b-customer.server";
import { getProxyParams } from "../../utils/proxy.server";

const escapeHtml = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const formatMoney = (amount?: string | number | null, currency = "USD") =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(Number(amount ?? 0));

const formatDate = (value?: string | null) => {
  if (!value) return "-";
  return new Date(value).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const renderAddress = (address?: Record<string, unknown> | null) => {
  if (!address) return "<div>-</div>";

  const lines = [
    [address.firstName, address.lastName].filter(Boolean).join(" ").trim(),
    address.company,
    address.address1,
    address.address2,
    [address.city, address.province].filter(Boolean).join(", ").trim(),
    [address.country, address.zip].filter(Boolean).join(" ").trim(),
    address.phone,
  ]
    .map((line) => String(line ?? "").trim())
    .filter(Boolean)
    .map((line) => `<div>${escapeHtml(line)}</div>`);

  return lines.length > 0 ? lines.join("") : "<div>-</div>";
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const orderId = url.searchParams.get("orderId")?.trim();
  const shouldPrint = url.searchParams.get("print") === "1";
  const { shop, loggedInCustomerId: customerId } = getProxyParams(request);

  if (!shop || !customerId || !orderId) {
    return new Response("Missing required order access parameters", {
      status: 400,
    });
  }

  const store = await getStoreByDomain(shop);
  if (!store?.accessToken) {
    return new Response("Store not found or unauthorized", { status: 404 });
  }

  const companyInfo = await getCustomerCompanyInfo(
    customerId,
    shop,
    store.accessToken,
  );

  if (!companyInfo.hasCompany || !companyInfo.companies?.length) {
    return new Response("Customer not associated with company", {
      status: 403,
    });
  }

  const company = companyInfo.companies[0];
  const isMainContact =
    company.mainContact?.id === `gid://shopify/Customer/${customerId}`;
  const isCompanyAdmin = company.roles.some((role: string) => {
    const lower = role.toLowerCase();
    return (
      lower === "admin" ||
      lower === "company admin" ||
      (lower.includes("admin") && !lower.includes("location"))
    );
  });

  const userAssignedLocationIds: string[] = [
    ...new Set<string>(
      company.roleAssignments
        .map(
          (assignment: { locationId?: string | null }) =>
            assignment.locationId ?? null,
        )
        .filter(
          (
            locationId: string | null | undefined,
          ): locationId is string => Boolean(locationId),
        ),
    ),
  ];

  let allowedLocationIds: string[] | undefined;
  if (isMainContact || isCompanyAdmin) {
    allowedLocationIds =
      userAssignedLocationIds.length > 0 ? userAssignedLocationIds : undefined;
  } else if (userAssignedLocationIds.length > 0) {
    allowedLocationIds = userAssignedLocationIds;
  } else {
    return new Response("No location assignments found", { status: 403 });
  }

  const orderResult = await getCompanyOrderById(shop, store.accessToken, {
    companyId: company.companyId,
    orderId,
    allowedLocationIds,
  });

  if (orderResult.error === "Unauthorized access to order") {
    return new Response(orderResult.error, { status: 403 });
  }

  if (orderResult.error || !orderResult.order) {
    return new Response(orderResult.error || "Order not found", { status: 404 });
  }

  const order = orderResult.order as any;
  const currency =
    order?.totalPriceSet?.shopMoney?.currencyCode ||
    order?.subtotalPriceSet?.shopMoney?.currencyCode ||
    "USD";
  const lineItems = order?.lineItems?.edges || [];
  const lineRows = lineItems
    .map((edge: any) => {
      const line = edge?.node;
      const quantity = Number(line?.quantity ?? 0);
      const unitAmount = Number(
        line?.originalUnitPriceSet?.shopMoney?.amount ?? 0,
      );
      const lineTotal = quantity * unitAmount;
      const description = [
        line?.name,
        line?.variant?.title && line.variant.title !== "Default Title"
          ? line.variant.title
          : "",
        line?.variant?.sku ? `SKU: ${line.variant.sku}` : "",
      ]
        .filter(Boolean)
        .join(" | ");

      return `
        <tr>
          <td>${escapeHtml(description)}</td>
          <td class="num">${quantity}</td>
          <td class="num">${escapeHtml(formatMoney(unitAmount, currency))}</td>
          <td class="num">${escapeHtml(formatMoney(lineTotal, currency))}</td>
        </tr>
      `;
    })
    .join("");

  const html = `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${escapeHtml(order.name || "Invoice")}</title>
      <style>
        :root {
          color-scheme: light;
          --ink: #172033;
          --muted: #667085;
          --line: #d7dce5;
          --panel: #f8fafc;
          --accent: #0f766e;
        }
        * { box-sizing: border-box; }
        body {
          margin: 0;
          font-family: Arial, sans-serif;
          color: var(--ink);
          background: #eef2f7;
        }
        .page {
          max-width: 960px;
          margin: 32px auto;
          background: #fff;
          border: 1px solid var(--line);
          border-radius: 18px;
          overflow: hidden;
          box-shadow: 0 20px 60px rgba(15, 23, 42, 0.08);
        }
        .header {
          padding: 28px 32px 20px;
          display: flex;
          justify-content: space-between;
          gap: 24px;
          border-bottom: 1px solid var(--line);
          background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
        }
        .eyebrow {
          display: inline-block;
          font-size: 12px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--accent);
          font-weight: 700;
          margin-bottom: 8px;
        }
        h1 {
          margin: 0;
          font-size: 32px;
          line-height: 1.1;
        }
        .meta {
          display: grid;
          grid-template-columns: auto auto;
          gap: 6px 16px;
          font-size: 14px;
          color: var(--muted);
          line-height: 1.4;
        }
        .meta div {
          display: contents;
        }
        .meta strong {
          color: var(--ink);
          text-align: right;
          font-weight: 600;
        }
        .section-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 16px;
          padding: 24px 32px;
        }
        .card {
          border: 1px solid var(--line);
          background: var(--panel);
          border-radius: 14px;
          padding: 16px;
        }
        .card h2 {
          margin: 0 0 10px;
          font-size: 14px;
        }
        .card div {
          font-size: 14px;
          line-height: 1.6;
        }
        .table-wrap {
          padding: 0 32px 28px;
        }
        table {
          width: 100%;
          border-collapse: collapse;
        }
        th, td {
          padding: 12px 10px;
          border-bottom: 1px solid var(--line);
          text-align: left;
          vertical-align: top;
          font-size: 14px;
        }
        th {
          color: var(--muted);
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .num {
          text-align: right;
          white-space: nowrap;
        }
        .summary {
          margin-left: auto;
          width: min(320px, 100%);
          padding-top: 18px;
        }
        .summary-row {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          padding: 8px 0;
          font-size: 14px;
        }
        .summary-row.total {
          border-top: 1px solid var(--line);
          margin-top: 8px;
          padding-top: 14px;
          font-size: 18px;
          font-weight: 700;
        }
        .actions {
          display: flex;
          justify-content: flex-end;
          gap: 12px;
          padding: 0 32px 28px;
        }
        .btn {
          appearance: none;
          border: 1px solid var(--line);
          background: white;
          color: var(--ink);
          border-radius: 10px;
          padding: 10px 16px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
        }
        .btn.primary {
          background: var(--ink);
          color: white;
          border-color: var(--ink);
        }
        .footer-note {
          padding: 0 32px 32px;
          color: var(--muted);
          font-size: 12px;
        }
        @media (max-width: 760px) {
          .header, .section-grid, .table-wrap, .actions, .footer-note {
            padding-left: 18px;
            padding-right: 18px;
          }
          .header {
            flex-direction: column;
          }
          .meta {
            justify-content: start;
            gap: 4px 12px;
          }
          .section-grid {
            grid-template-columns: 1fr;
          }
        }
        @media print {
          body {
            background: white;
          }
          .page {
            margin: 0;
            border: none;
            border-radius: 0;
            box-shadow: none;
          }
          .actions {
            display: none;
          }
        }
      </style>
    </head>
    <body>
      <div class="page">
        <div class="header">
          <div>
            <div class="eyebrow">Invoice</div>
            <h1>${escapeHtml(order.name || "Order Invoice")}</h1>
          </div>
          <div class="meta">
            <div><strong>Invoice Date:</strong> ${escapeHtml(formatDate(order.createdAt))}</div>
            <div><strong>Order ID:</strong> ${escapeHtml(order.id)}</div>
            <div><strong>Location:</strong> ${escapeHtml(order.locationName || "-")}</div>
            <div><strong>Financial Status:</strong> ${escapeHtml(order.displayFinancialStatus || "-")}</div>
            <div><strong>Fulfillment Status:</strong> ${escapeHtml(order.displayFulfillmentStatus || "-")}</div>
          </div>
        </div>

        <div class="section-grid">
          <div class="card">
            <h2>Company</h2>
            <div>${escapeHtml(order?.purchasingEntity?.company?.name || company.companyName || "-")}</div>
          </div>
          <div class="card">
            <h2>Shipping Address</h2>
            ${renderAddress(order.shippingAddress)}
          </div>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Description</th>
                <th class="num">Qty</th>
                <th class="num">Unit Price</th>
                <th class="num">Total</th>
              </tr>
            </thead>
            <tbody>
              ${lineRows || `<tr><td colspan="4">No line items found.</td></tr>`}
            </tbody>
          </table>

          <div class="summary">
            <div class="summary-row">
              <span>Subtotal</span>
              <strong>${escapeHtml(
                formatMoney(order?.subtotalPriceSet?.shopMoney?.amount, currency),
              )}</strong>
            </div>
            <div class="summary-row">
              <span>Tax</span>
              <strong>${escapeHtml(
                formatMoney(order?.totalTaxSet?.shopMoney?.amount, currency),
              )}</strong>
            </div>
            <div class="summary-row total">
              <span>Total</span>
              <span>${escapeHtml(
                formatMoney(order?.totalPriceSet?.shopMoney?.amount, currency),
              )}</span>
            </div>
          </div>
        </div>

        <div class="actions">
          ${
            order?.statusPageUrl
              ? `<a class="btn" href="${escapeHtml(order.statusPageUrl)}" target="_blank" rel="noopener noreferrer">Order Status</a>`
              : ""
          }
          <button class="btn primary" onclick="window.print()">Print / Save PDF</button>
        </div>

        <div class="footer-note">
          This invoice was generated from your Shopify B2B order details.
        </div>
      </div>
      ${
        shouldPrint
          ? `<script>window.addEventListener("load", function () { setTimeout(function () { window.print(); }, 250); });</script>`
          : ""
      }
    </body>
  </html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
};
