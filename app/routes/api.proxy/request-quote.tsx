import crypto from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import prisma from "app/db.server";
import { authenticateApiProxyRequest } from "app/utils/proxy.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const { customerId, shop, store, companyId } =
    await authenticateApiProxyRequest(request);

  const body = await request.json();
  const { items, title, notes } = body as {
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
  };

  if (!items || !items.length) {
    return Response.json(
      { error: "At least one item is required." },
      { status: 400 },
    );
  }

  const customer = await prisma.user.findFirst({
    where: {
      shopId: store.id,
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

  if (!customer?.email) {
    return Response.json(
      { error: "Customer account not found." },
      { status: 404 },
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
      salesAgentId: customer.id,
      title: title || `Quote request from ${customer.firstName || customer.email}`,
      status: "draft",
      secureToken: crypto.randomBytes(24).toString("hex"),
      customerUserId: customer.id?.startsWith("gid://") ? null : customer.id,
      customerShopifyId: customer.shopifyCustomerId || customerId,
      customerEmail: customer.email,
      customerFirstName: customer.firstName,
      customerLastName: customer.lastName,
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
      customerEmail: customer.email,
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
