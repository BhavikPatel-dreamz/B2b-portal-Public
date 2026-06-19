import crypto from "node:crypto";
import prisma from "app/db.server";
import { sendQuoteEmail } from "app/utils/email";
import {
  buildSalesDraftLineItems,
  buildSalesDraftShippingLine,
  buildSalesDraftTaxLine,
  calculateSalesOrderTotals,
  getCartCurrency,
  normalizeDiscountType,
  type SalesCartItem,
  type SalesDraftLineItemInput,
  type SalesDraftShippingLineInput,
} from "app/utils/sales-order-pricing.server";

export type QuoteCartItem = SalesCartItem & {
  productId?: string;
  productTitle?: string;
  variantTitle?: string;
  sku?: string;
  image?: string;
};

type ShopifyCompanyContactEdge = {
  node: {
    id?: string;
    customer?: { id?: string | null } | null;
    roleAssignments?: {
      edges?: Array<{
        node?: { companyLocation?: { id?: string | null } | null } | null;
      }>;
    } | null;
  };
};

type DraftOrderInput = {
  lineItems: SalesDraftLineItemInput[];
  note: string;
  customAttributes: Array<{ key: string; value: string }>;
  presentmentCurrencyCode: string;
  purchasingEntity: {
    purchasingCompany: {
      companyId: string;
      companyLocationId: string;
      companyContactId: string;
    };
  };
  appliedDiscount?: {
    value: number;
    valueType: "PERCENTAGE" | "FIXED_AMOUNT";
    title: string;
  };
  shippingLine?: SalesDraftShippingLineInput;
  taxExempt?: boolean;
};

export function getQuoteUrl(request: Request, quote: { id: string; secureToken: string }) {
  const url = new URL(request.url);
  return `${url.origin}/quote/${quote.id}/${quote.secureToken}`;
}

export function serializeQuote(quote: any) {
  return {
    ...quote,
    subtotal: quote.subtotal?.toString?.() ?? "0",
    discountAmount: quote.discountAmount?.toString?.() ?? "0",
    discountTotal: quote.discountTotal?.toString?.() ?? "0",
    shippingAmount: quote.shippingAmount?.toString?.() ?? "0",
    taxRate: quote.taxRate?.toString?.() ?? "0",
    taxAmount: quote.taxAmount?.toString?.() ?? "0",
    totalAmount: quote.totalAmount?.toString?.() ?? "0",
    expiresAt: quote.expiresAt?.toISOString?.() ?? quote.expiresAt,
    sentAt: quote.sentAt?.toISOString?.() ?? quote.sentAt,
    viewedAt: quote.viewedAt?.toISOString?.() ?? quote.viewedAt,
    approvedAt: quote.approvedAt?.toISOString?.() ?? quote.approvedAt,
    rejectedAt: quote.rejectedAt?.toISOString?.() ?? quote.rejectedAt,
    cancelledAt: quote.cancelledAt?.toISOString?.() ?? quote.cancelledAt,
    convertedAt: quote.convertedAt?.toISOString?.() ?? quote.convertedAt,
    createdAt: quote.createdAt?.toISOString?.() ?? quote.createdAt,
    updatedAt: quote.updatedAt?.toISOString?.() ?? quote.updatedAt,
    items: quote.items?.map((item: any) => ({
      ...item,
      unitPrice: item.unitPrice?.toString?.() ?? "0",
      discount: item.discount?.toString?.() ?? "0",
      totalPrice: item.totalPrice?.toString?.() ?? "0",
      createdAt: item.createdAt?.toISOString?.() ?? item.createdAt,
      updatedAt: item.updatedAt?.toISOString?.() ?? item.updatedAt,
    })),
    activities: quote.activities?.map((activity: any) => ({
      ...activity,
      createdAt: activity.createdAt?.toISOString?.() ?? activity.createdAt,
    })),
  };
}

export async function logQuoteActivity({
  quoteId,
  userId,
  companyId,
  customerEmail,
  action,
  message,
  metadata,
}: {
  quoteId: string;
  userId?: string | null;
  companyId: string;
  customerEmail?: string | null;
  action: string;
  message?: string | null;
  metadata?: Record<string, unknown>;
}) {
  await prisma.quoteActivity.create({
    data: {
      quoteId,
      userId,
      companyId,
      customerEmail,
      action,
      message,
      metadata: metadata || undefined,
    },
  });
}

async function generateQuoteNumber(shopId: string) {
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, "");
  const count = await prisma.quote.count({
    where: {
      shopId,
      createdAt: {
        gte: new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`),
      },
    },
  });
  const suffix = String(count + 1).padStart(4, "0");
  return `Q-${datePart}-${suffix}`;
}

function generateSecureToken() {
  return crypto.randomBytes(24).toString("hex");
}

export function defaultQuoteExpiry() {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);
  expiresAt.setHours(23, 59, 59, 999);
  return expiresAt;
}

export async function resolveQuoteCustomer(company: any, customerId: string) {
  let selectedCustomer = await prisma.user.findFirst({
    where: {
      shopId: company.shopId,
      OR: [{ id: customerId }, { shopifyCustomerId: customerId }],
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      shopifyCustomerId: true,
    },
  });

  if (!selectedCustomer && company.shop?.accessToken) {
    const customerQuery = `
      query GetCustomer($id: ID!) {
        customer(id: $id) {
          id
          firstName
          lastName
          email
        }
      }
    `;
    const customerRes = await fetch(
      `https://${company.shop.shopDomain}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": company.shop.accessToken,
        },
        body: JSON.stringify({
          query: customerQuery,
          variables: { id: `gid://shopify/Customer/${customerId}` },
        }),
      },
    );
    const customerData = await customerRes.json();
    const shopifyCustomer = customerData.data?.customer;
    if (shopifyCustomer) {
      selectedCustomer = {
        id: customerId,
        firstName: shopifyCustomer.firstName,
        lastName: shopifyCustomer.lastName,
        email: shopifyCustomer.email,
        shopifyCustomerId: customerId,
      };
    }
  }

  if (!selectedCustomer?.email) {
    throw new Error("Selected customer could not be resolved.");
  }

  return selectedCustomer;
}

export async function createQuoteFromCart({
  companyId,
  salesAgentId,
  customerId,
  cartData,
  title,
  internalNotes,
  customerNotes,
  discountAmount,
  discountType,
  shippingCost,
  taxRate,
  expiresAt,
  submit,
}: {
  companyId: string;
  salesAgentId: string;
  customerId: string;
  cartData: QuoteCartItem[];
  title?: string | null;
  internalNotes?: string | null;
  customerNotes?: string | null;
  discountAmount: number;
  discountType: string | null;
  shippingCost: number;
  taxRate: number;
  expiresAt?: Date | null;
  submit?: boolean;
}) {
  if (!cartData.length) {
    throw new Error("Cart is empty.");
  }

  const company = await prisma.companyAccount.findUnique({
    where: { id: companyId },
    include: { shop: true },
  });
  if (!company) {
    throw new Error("Company not found.");
  }

  const salesAgent = await prisma.user.findUnique({
    where: { id: salesAgentId },
    select: { id: true, email: true },
  });
  if (!salesAgent) {
    throw new Error("Sales agent not found.");
  }

  const customer = await resolveQuoteCustomer(company, customerId);
  const normalizedDiscountType = normalizeDiscountType(discountType);
  const currencyCode = getCartCurrency(cartData);
  const totals = calculateSalesOrderTotals(
    cartData,
    discountAmount,
    normalizedDiscountType,
    shippingCost,
    taxRate,
  );
  const quoteNumber = await generateQuoteNumber(company.shopId);
  const quoteTitle =
    title?.trim() ||
    `${company.name} quote for ${customer.firstName || customer.email}`;
  const status = submit ? "sent" : "draft";
  const sentAt = submit ? new Date() : null;

  const quote = await prisma.quote.create({
    data: {
      quoteNumber,
      shopId: company.shopId,
      companyId: company.id,
      salesAgentId,
      title: quoteTitle,
      status,
      secureToken: generateSecureToken(),
      customerUserId: customer.id?.startsWith("gid://") ? null : customer.id,
      customerShopifyId: customer.shopifyCustomerId || customerId,
      customerEmail: customer.email,
      customerFirstName: customer.firstName,
      customerLastName: customer.lastName,
      currencyCode,
      subtotal: totals.subtotal,
      discountAmount,
      discountType: normalizedDiscountType,
      discountTotal: totals.discountTotal,
      shippingAmount: shippingCost,
      taxRate,
      taxAmount: totals.estimatedTax,
      totalAmount: totals.total,
      customerNotes,
      internalNotes,
      expiresAt: expiresAt || defaultQuoteExpiry(),
      sentAt,
      items: {
        create: cartData.map((item) => ({
          productId: item.productId,
          productTitle: item.productTitle || "Product",
          variantId: item.variantId,
          variantTitle: item.variantTitle,
          sku: item.sku,
          image: item.image,
          quantity: item.quantity,
          unitPrice: Number(item.price) || 0,
          totalPrice: (Number(item.price) || 0) * item.quantity,
          currencyCode,
        })),
      },
    },
    include: { items: true },
  });

  await logQuoteActivity({
    quoteId: quote.id,
    userId: salesAgentId,
    companyId: company.id,
    customerEmail: customer.email,
    action: submit ? "Quote Sent" : "Quote Created",
    message: submit ? "Quote submitted and shared." : "Draft quote created.",
  });

  return quote;
}

export async function sendQuoteToCustomer({
  quoteId,
  request,
  userId,
}: {
  quoteId: string;
  request: Request;
  userId?: string | null;
}) {
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    include: { company: true, shop: true },
  });
  if (!quote) {
    throw new Error("Quote not found.");
  }

  const quoteUrl = getQuoteUrl(request, quote);
  const customerName = [quote.customerFirstName, quote.customerLastName]
    .filter(Boolean)
    .join(" ");
  const emailResult = await sendQuoteEmail({
    storeId: quote.shopId,
    to: quote.customerEmail,
    customerName,
    quoteNumber: quote.quoteNumber,
    quoteTitle: quote.title,
    companyName: quote.company.name,
    totalAmount: Number(quote.totalAmount).toFixed(2),
    currencyCode: quote.currencyCode,
    expiresAt: quote.expiresAt,
    quoteUrl,
  });

  await prisma.quote.update({
    where: { id: quote.id },
    data: {
      status: quote.status === "draft" ? "sent" : quote.status,
      sentAt: quote.sentAt || new Date(),
    },
  });
  await logQuoteActivity({
    quoteId: quote.id,
    userId,
    companyId: quote.companyId,
    customerEmail: quote.customerEmail,
    action: "Quote Sent",
    message: "Quote email sent to customer.",
    metadata: { emailResult },
  });

  return { quoteUrl, emailResult };
}

async function resolveShopifyB2BContext(quote: any) {
  const company = quote.company;
  if (!company.shopifyCompanyId || !company.shop?.accessToken) {
    throw new Error("Company or shop credentials not found.");
  }

  const baseMetaQuery = `
    query GetBaseMeta($companyId: ID!) {
      company(id: $companyId) {
        locations(first: 10) {
          nodes { id }
        }
        contacts(first: 50) {
          edges {
            node {
              id
              customer { id }
              roleAssignments(first: 5) {
                edges {
                  node {
                    companyLocation { id }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const baseMetaRes = await fetch(
    `https://${company.shop.shopDomain}/admin/api/2025-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": company.shop.accessToken,
      },
      body: JSON.stringify({
        query: baseMetaQuery,
        variables: { companyId: company.shopifyCompanyId },
      }),
    },
  );
  const baseMetaData = await baseMetaRes.json();
  const contacts = (baseMetaData.data?.company?.contacts?.edges ||
    []) as ShopifyCompanyContactEdge[];
  const customerId = quote.customerShopifyId;
  const matchCustGid = `gid://shopify/Customer/${customerId}`;
  const matchedContact = contacts.find(
    (edge) => edge.node.customer?.id === matchCustGid,
  );
  const companyLocationId =
    matchedContact?.node.roleAssignments?.edges?.[0]?.node?.companyLocation
      ?.id || baseMetaData.data?.company?.locations?.nodes?.[0]?.id || "";
  const companyContactId = matchedContact?.node?.id || "";

  if (!companyLocationId || !companyContactId) {
    throw new Error(
      "B2B context missing. The selected customer is not assigned as a Shopify company contact.",
    );
  }

  return { companyLocationId, companyContactId };
}

export async function convertQuoteToOrder({
  quoteId,
  salesAgentId,
}: {
  quoteId: string;
  salesAgentId: string;
}) {
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    include: {
      items: true,
      company: { include: { shop: true } },
    },
  });
  if (!quote) {
    throw new Error("Quote not found.");
  }
  if (quote.status === "converted") {
    throw new Error("Quote has already been converted.");
  }
  if (!["approved", "sent", "viewed"].includes(quote.status)) {
    throw new Error("Only sent, viewed, or approved quotes can be converted.");
  }

  const { companyLocationId, companyContactId } =
    await resolveShopifyB2BContext(quote);
  const cartData = quote.items.map((item) => ({
    variantId: item.variantId,
    quantity: item.quantity,
    price: item.unitPrice.toString(),
    currencyCode: item.currencyCode,
  }));
  const lineItems = buildSalesDraftLineItems(cartData, quote.currencyCode);
  const taxLine = buildSalesDraftTaxLine(
    quote.taxAmount.toString(),
    quote.taxRate.toString(),
    quote.currencyCode,
  );
  if (taxLine) {
    lineItems.push(taxLine);
  }
  const shippingLine = buildSalesDraftShippingLine(
    quote.shippingAmount.toString(),
    quote.currencyCode,
  );
  const appliedDiscount =
    Number(quote.discountTotal) > 0
      ? {
          value: Number(quote.discountTotal),
          valueType: "FIXED_AMOUNT" as const,
          title:
            quote.discountType === "PERCENTAGE"
              ? `Quote Discount (${quote.discountAmount}%)`
              : "Quote Discount",
        }
      : undefined;
  const customAttributes = [
    { key: "_source", value: "Sales Portal Quote" },
    { key: "Quote Number", value: quote.quoteNumber },
  ];
  if (quote.internalNotes) {
    customAttributes.push({ key: "Internal Notes", value: quote.internalNotes });
  }

  const draftInput: DraftOrderInput = {
    lineItems,
    note: quote.customerNotes || "",
    customAttributes,
    presentmentCurrencyCode: quote.currencyCode,
    taxExempt: true,
    purchasingEntity: {
      purchasingCompany: {
        companyId: quote.company.shopifyCompanyId,
        companyLocationId,
        companyContactId,
      },
    },
  };
  if (appliedDiscount) {
    draftInput.appliedDiscount = appliedDiscount;
  }
  if (shippingLine) {
    draftInput.shippingLine = shippingLine;
  }

  const draftOrderMutation = `
    mutation CreateB2BDraft($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder { id invoiceUrl totalPriceSet { shopMoney { amount currencyCode } } }
        userErrors { field message }
      }
    }
  `;
  const draftRes = await fetch(
    `https://${quote.company.shop.shopDomain}/admin/api/2025-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": quote.company.shop.accessToken,
      },
      body: JSON.stringify({
        query: draftOrderMutation,
        variables: { input: draftInput },
      }),
    },
  );
  const draftData = await draftRes.json();
  const draftErrors = draftData.data?.draftOrderCreate?.userErrors || [];
  if (draftData.errors?.length || draftErrors.length) {
    throw new Error(draftData.errors?.[0]?.message || draftErrors[0].message);
  }
  const draftId = draftData.data?.draftOrderCreate?.draftOrder?.id;
  if (!draftId) {
    throw new Error("Failed to create Shopify draft order.");
  }

  const completeMutation = `
    mutation CompleteDraftOrder($id: ID!, $paymentPending: Boolean) {
      draftOrderComplete(id: $id, paymentPending: $paymentPending) {
        draftOrder {
          order {
            id
            name
            totalPriceSet { shopMoney { amount currencyCode } }
          }
        }
        userErrors { message }
      }
    }
  `;
  const completeRes = await fetch(
    `https://${quote.company.shop.shopDomain}/admin/api/2025-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": quote.company.shop.accessToken,
      },
      body: JSON.stringify({
        query: completeMutation,
        variables: { id: draftId, paymentPending: true },
      }),
    },
  );
  const completeData = await completeRes.json();
  const completeErrors =
    completeData.data?.draftOrderComplete?.userErrors || [];
  if (completeData.errors?.length || completeErrors.length) {
    throw new Error(
      completeData.errors?.[0]?.message || completeErrors[0].message,
    );
  }
  const createdOrder = completeData.data?.draftOrderComplete?.draftOrder?.order;
  if (!createdOrder?.id) {
    throw new Error("Failed to complete Shopify order.");
  }

  const orderTotal =
    Number(createdOrder.totalPriceSet?.shopMoney?.amount) ||
    Number(quote.totalAmount);
  const order = await prisma.b2BOrder.create({
    data: {
      companyId: quote.companyId,
      createdByUserId: salesAgentId,
      shopId: quote.shopId,
      shopifyOrderId: createdOrder.id,
      orderTotal,
      creditUsed: 0,
      paymentStatus: "pending",
      orderStatus: "completed",
      remainingBalance: orderTotal,
      userCreditUsed: 0,
      notes: quote.internalNotes,
      source: "Sales Portal Quote",
    },
  });

  await prisma.quote.update({
    where: { id: quote.id },
    data: {
      status: "converted",
      convertedAt: new Date(),
      convertedOrderId: order.id,
    },
  });
  await logQuoteActivity({
    quoteId: quote.id,
    userId: salesAgentId,
    companyId: quote.companyId,
    customerEmail: quote.customerEmail,
    action: "Quote Converted To Order",
    message: `Converted to Shopify order ${createdOrder.name || createdOrder.id}.`,
    metadata: { orderId: order.id, shopifyOrderId: createdOrder.id },
  });

  return { order, shopifyOrder: createdOrder };
}
