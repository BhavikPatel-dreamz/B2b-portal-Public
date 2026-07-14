import crypto from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import prisma from "app/db.server";
import { authenticate } from "app/shopify.server";
import { getCachedProxyStore } from "app/utils/proxy.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const url = new URL(request.url);

  // Try Shopify proxy auth (adds shop, timestamp, signature query params)
  let shop: string | null = url.searchParams.get("shop");
  let store: any = null;

  try {
    await authenticate.public.appProxy(request);
    shop = shop || url.searchParams.get("shop");
    if (shop) {
      store = await getCachedProxyStore(shop);
    }
  } catch {
    // Proxy auth failed — extract shop from cookies or referer
  }

  // Fallback: extract shop from _shopify_y cookie or referer
  if (!store) {
    const cookieHeader = request.headers.get("cookie") || "";
    const shopifyMatch = cookieHeader.match(/_shopify_y=([^;]+)/);
    if (shopifyMatch) {
      // Extract shop from origin/referer
      const referer = request.headers.get("referer") || request.headers.get("origin") || "";
      const shopMatch = referer.match(/https?:\/\/([^./]+)\.myshopify\.com/);
      if (shopMatch) {
        shop = `${shopMatch[1]}.myshopify.com`;
      }
    }

    // Last fallback: check referer header for shop domain
    if (!shop) {
      const referer = request.headers.get("referer") || request.headers.get("origin") || "";
      const shopMatch = referer.match(/https?:\/\/([^./]+)\.myshopify\.com/);
      if (shopMatch) {
        shop = `${shopMatch[1]}.myshopify.com`;
      }
    }

    if (shop) {
      store = await getCachedProxyStore(shop);
    }
  }

  if (!store) {
    return Response.json(
      { error: "Could not identify the store. Please try again." },
      { status: 400 },
    );
  }

  const body = await request.json();
  const {
    items,
    title,
    notes,
    companyId: bodyCompanyId,
    customerId: bodyCustomerId,
    customerName,
    customerEmail,
  } = body as {
    items: Array<{
      productId?: string;
      productTitle: string;
      variantId: string;
      variantTitle?: string;
      sku?: string;
      image?: string;
      quantity: number;
      price: string | number;
      currencyCode?: string;
    }>;
    title?: string;
    notes?: string;
    companyId?: string;
    customerId?: string;
    customerName?: string;
    customerEmail?: string;
  };

  if (!items || !items.length) {
    return Response.json(
      { error: "At least one item is required." },
      { status: 400 },
    );
  }

  const companyId = bodyCompanyId;
  if (!companyId) {
    return Response.json(
      { error: "Company ID is required." },
      { status: 400 },
    );
  }

  // Resolve customer ID from body or proxy
  const rawCustomerId = bodyCustomerId || url.searchParams.get("logged_in_customer_id") || "";
  const numericId = rawCustomerId.replace("gid://shopify/Customer/", "");
  const gidFormat = numericId ? `gid://shopify/Customer/${numericId}` : "";

  // Try to find a local User record (search both formats)
  let customer = null;
  if (numericId) {
    customer = await prisma.user.findFirst({
      where: {
        shopId: store.id,
        OR: [
          { shopifyCustomerId: numericId },
          { shopifyCustomerId: gidFormat },
          { id: numericId },
        ],
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        shopifyCustomerId: true,
      },
    });
  }

  const resolvedEmail = customerEmail || customer?.email || "";
  const resolvedName = customerName || "";
  const nameParts = resolvedName.split(" ").filter(Boolean);
  const resolvedFirstName = customer?.firstName || nameParts[0] || null;
  const resolvedLastName =
    customer?.lastName || nameParts.slice(1).join(" ") || null;

  if (!resolvedEmail) {
    return Response.json(
      { error: "Customer email is required." },
      { status: 400 },
    );
  }

  // salesAgentId is a required FK to User — find a valid ID
  let salesAgentId = customer?.id || null;
  if (!salesAgentId && numericId) {
    const foundUser = await prisma.user.findFirst({
      where: {
        shopId: store.id,
        OR: [
          { shopifyCustomerId: numericId },
          { shopifyCustomerId: gidFormat },
        ],
      },
      select: { id: true },
    });
    salesAgentId = foundUser?.id || null;
  }
  if (!salesAgentId) {
    const adminUser = await prisma.user.findFirst({
      where: { shopId: store.id, role: "STORE_ADMIN" },
      select: { id: true },
    });
    salesAgentId = adminUser?.id || null;
  }
  if (!salesAgentId) {
    const anyUser = await prisma.user.findFirst({
      where: { shopId: store.id },
      select: { id: true },
    });
    salesAgentId = anyUser?.id || null;
  }
  if (!salesAgentId) {
    return Response.json(
      { error: "No staff user found to assign this quote to." },
      { status: 500 },
    );
  }

  const now = new Date();
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, "");
  const count = await prisma.quote.count({
    where: {
      shopId: store.id,
      createdAt: {
        gte: new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`),
      },
    },
  });
  const quoteNumber = `Q-${datePart}-${String(count + 1).padStart(4, "0")}`;

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);
  expiresAt.setHours(23, 59, 59, 999);

  const currencyCode =
    items.find((i) => i.currencyCode)?.currencyCode?.toUpperCase() || "USD";

  const subtotal = items.reduce(
    (acc, item) => acc + Number(item.price) * item.quantity,
    0,
  );

  const quote = await prisma.quote.create({
    data: {
      quoteNumber,
      shopId: store.id,
      companyId,
      salesAgentId,
      title:
        title ||
        `Quote request from ${resolvedFirstName || resolvedEmail}`,
      status: "draft",
      secureToken: crypto.randomBytes(24).toString("hex"),
      customerUserId: customer?.id || null,
      customerShopifyId: numericId || null,
      customerEmail: resolvedEmail,
      customerFirstName: resolvedFirstName,
      customerLastName: resolvedLastName,
      currencyCode,
      subtotal,
      totalAmount: subtotal,
      internalNotes: notes || null,
      expiresAt,
      items: {
        create: items.map((item) => ({
          productId: item.productId || null,
          productTitle: item.productTitle || "Product",
          variantId: item.variantId,
          variantTitle: item.variantTitle || null,
          sku: item.sku || null,
          image: item.image || null,
          quantity: item.quantity,
          unitPrice: Number(item.price) || 0,
          totalPrice: (Number(item.price) || 0) * item.quantity,
          currencyCode: item.currencyCode || currencyCode,
        })),
      },
    },
    include: { items: true },
  });

  await prisma.quoteActivity.create({
    data: {
      quoteId: quote.id,
      companyId,
      customerEmail: resolvedEmail,
      action: "Quote Requested",
      message: `Customer requested a quote with ${items.length} item(s).`,
    },
  });

  return Response.json({
    success: true,
    quoteId: quote.id,
    quoteNumber: quote.quoteNumber,
    message: "Quote request submitted. Your team will review it shortly.",
  });
};
