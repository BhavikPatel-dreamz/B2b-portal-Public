import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../../shopify.server";
import {
  getCompanyOrderById,
  getCustomerCompanyInfo,
} from "../../utils/b2b-customer.server";
import { getProxyParams } from "../../utils/proxy.server";
import prisma from "../../db.server";

// ─── Helpers ────────────────────────────────────────────────────────────────

const DEFAULT_LOGO =
  "https://cdn.shopify.com/s/files/applications/c6da0a0589e2c3c978aadf2afec07db7_200x200.png?v=1776950914";

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
  return new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
};

const renderAddress = (address?: Record<string, unknown> | null): string => {
  if (!address) return "-";
  const lines = [
    [address.firstName, address.lastName].filter(Boolean).join(" ").trim(),
    address.company,
    address.address1,
    address.address2,
    [address.city, address.province].filter(Boolean).join(", ").trim(),
    [address.country, address.zip].filter(Boolean).join(" ").trim(),
  ]
    .map((line) => String(line ?? "").trim())
    .filter(Boolean);
  return lines.length > 0 ? lines.join("<br />") : "-";
};

// renderAddress string version (for registration location which is already a string)
const formatRegistrationAddress = (session: {
  address?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  zipCode?: string | null;
  postalCode?: string | null;
} | null): string => {
  if (!session) return "-";
  const parts = [
    session.address,
    session.city,
    session.state,
    session.zipCode || session.postalCode,
    session.country,
  ]
    .map((p) => (p || "").trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join("<br />") : "-";
};

// ─── Default template ────────────────────────────────────────────────────────

const DEFAULT_INVOICE_TEMPLATE = `<!DOCTYPE html>
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
    .totals-box { width: 320px; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
    .total-row { display: flex; justify-content: space-between; padding: 10px 16px; font-size: 14px; color: #333; border-bottom: 1px solid #e5e7eb; }
    .total-row:last-child { border-bottom: none; }
    .total-row.grand-total { background: #1a73e8; color: #fff; font-weight: 800; font-size: 15px; }
    .total-row.grand-total span { color: #fff; }

    @media print {
      body { padding: 0; background: #fff; }
      .actions { display: none; }
      .invoice-container { border: none; box-shadow: none; border-radius: 0; padding: 32px; }
    }
  </style>
</head>
<body>
  <div class="actions">
    <button class="btn primary" onclick="window.print()">Print / Save PDF</button>
  </div>
  <div class="invoice-container">

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
        <p>{{billingAddress}}</p>
      </div>
    </div>

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

// ─── Loader ──────────────────────────────────────────────────────────────────

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

  const store = await prisma.store.findUnique({
    where: { shopDomain: shop },
    select: {
      id: true,
      shopName: true,
      logo: true,
      contactEmail: true,
      invoiceTemplate: true,
      accessToken: true,
    },
  });

  if (!store?.accessToken) {
    return new Response("Store not found or unauthorized", { status: 404 });
  }

  // ── 1. Fetch shop details (phone, address, URL) ───────────────────────────
  let shopPhone = "";
  let shopAddress = "";
  let shopUrl = shop;

  try {
    const shopQuery = `
      query {
        shop {
          phone
          url
          billingAddress {
            address1
            address2
            city
            province
            country
            zip
          }
        }
      }
    `;
    const shopRes = await fetch(
      `https://${shop}/admin/api/2024-04/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": store.accessToken,
        },
        body: JSON.stringify({ query: shopQuery }),
      },
    );
    if (shopRes.ok) {
      const shopData = (await shopRes.json()) as {
        data?: {
          shop?: {
            phone?: string;
            url?: string;
            billingAddress?: {
              address1?: string;
              address2?: string;
              city?: string;
              province?: string;
              country?: string;
              zip?: string;
            };
          };
        };
      };
      const shopInfo = shopData?.data?.shop;
      if (shopInfo) {
        shopPhone = shopInfo.phone || "";
        shopUrl = shopInfo.url || shop;
        const addr = shopInfo.billingAddress;
        if (addr) {
          shopAddress = [
            addr.address1,
            addr.address2,
            addr.city,
            addr.province,
            addr.zip,
            addr.country,
          ]
            .map((p) => (p || "").trim())
            .filter(Boolean)
            .join(", ");
        }
      }
    }
  } catch (err) {
    console.warn("Failed to fetch shop details for invoice:", err);
  }

  // ── 2. Company / customer access check ───────────────────────────────────
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
          (locationId: string | null | undefined): locationId is string =>
            Boolean(locationId),
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

  // ── 3. Fetch registrationSession location for Bill To ─────────────────────
  // Match by shopifyCustomerId (gid) or numeric customerId
  const customerGid = `gid://shopify/Customer/${customerId}`;

 const registrationSession = await prisma.registrationSubmission.findFirst({
  where: {
    shopId: store.id,
    OR: [
      { shopifyCustomerId: customerGid },
      { shopifyCustomerId: String(customerId) },
    ],
  },
  select: {
    location: true,
    companyName: true,
    firstName: true,
    lastName: true,
    contactTitle: true,
    customFields: true,
  },
});
console.log("registration location raw:", registrationSession)

  const registrationAddress = formatRegistrationAddress(registrationSession);

  // ── 4. Fetch order ────────────────────────────────────────────────────────
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

  // ── 5. Build line rows ────────────────────────────────────────────────────
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
      const lineTotalBeforeTax = quantity * unitAmount;
      const lineTaxAmount = Number(
        line?.taxLines?.reduce(
          (sum: number, t: any) =>
            sum + Number(t?.priceSet?.shopMoney?.amount ?? 0),
          0,
        ) ?? 0,
      );
      const taxRate =
        lineTotalBeforeTax > 0
          ? ((lineTaxAmount / lineTotalBeforeTax) * 100).toFixed(2) + "%"
          : "0.00%";
      const lineTotal = lineTotalBeforeTax + lineTaxAmount;

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
          <td class="num">${escapeHtml(formatMoney(unitAmount, currency))}</td>
          <td class="num">${quantity}</td>
          <td class="num">${escapeHtml(taxRate)}</td>
          <td class="num">${escapeHtml(formatMoney(lineTotal, currency))}</td>
        </tr>
      `;
    })
    .join("");

  // ── 6. Variable map ───────────────────────────────────────────────────────
  const template = store.invoiceTemplate || DEFAULT_INVOICE_TEMPLATE;

  const variables: Record<string, string> = {
    "{{companyName}}": escapeHtml(
      registrationSession?.companyName ||
      order?.purchasingEntity?.company?.name ||
      company.companyName ||
      "-",
    ),
    "{{customerName}}": escapeHtml(
      [order?.customer?.firstName, order?.customer?.lastName]
        .filter(Boolean)
        .join(" ") || "-",
    ),
    "{{customerEmail}}": escapeHtml(order?.customer?.email || "-"),
    "{{customerPhone}}": escapeHtml(
      registrationSession?.phone || order?.customer?.phone || "-",
    ),
    "{{orderNumber}}": escapeHtml(
      order.name || order.id?.split("/").pop() || "-",
    ),
    "{{orderDate}}": escapeHtml(formatDate(order.createdAt)),
    "{{dueDate}}": escapeHtml(formatDate(order.createdAt)),
    "{{orderTotal}}": escapeHtml(
      formatMoney(order?.totalPriceSet?.shopMoney?.amount, currency),
    ),
    "{{subtotal}}": escapeHtml(
      formatMoney(order?.subtotalPriceSet?.shopMoney?.amount, currency),
    ),
    "{{tax}}": escapeHtml(
      formatMoney(order?.totalTaxSet?.shopMoney?.amount, currency),
    ),
    "{{shippingCost}}": escapeHtml(
      formatMoney(order?.totalShippingPriceSet?.shopMoney?.amount, currency),
    ),
    "{{lineItems}}":
      lineRows || `<tr><td colspan="5">No line items found.</td></tr>`,
    "{{shopName}}": escapeHtml(store.shopName || shop),
    "{{contactEmail}}": escapeHtml(store.contactEmail || ""),
    "{{ownerEmail}}": escapeHtml(store.contactEmail || ""),
    "{{shopUrl}}": escapeHtml(shopUrl),
    "{{shopPhone}}": escapeHtml(shopPhone),
    "{{shopAddress}}": escapeHtml(shopAddress),
    "{{logoUrl}}": escapeHtml(store.logo || DEFAULT_LOGO),
    "{{orderNotes}}": escapeHtml(order.note || "-"),
    // billingAddress = registrationSession location (fallback to order shippingAddress)
    "{{billingAddress}}":
      registrationAddress !== "-"
        ? registrationAddress
        : renderAddress(order.shippingAddress),
    // keep {{shippingAddress}} working too if used in custom templates
    "{{shippingAddress}}": renderAddress(order.shippingAddress),
  };

  let html = template;
  Object.entries(variables).forEach(([key, value]) => {
    html = html.replaceAll(key, value);
  });

  if (shouldPrint) {
    html = html.replace(
      "</body>",
      `<script>window.addEventListener("load", function () { setTimeout(function () { window.print(); }, 500); });</script></body>`,
    );
  }

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
};