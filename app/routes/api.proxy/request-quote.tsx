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
      productTitle?: string;
      title?: string;
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

  // Resolve local CompanyAccount from Shopify company GID
  const rawCompanyId = bodyCompanyId || "";
  const shopifyCompanyId = rawCompanyId.startsWith("gid://shopify/")
    ? rawCompanyId
    : `gid://shopify/Company/${rawCompanyId}`;

  const localCompany = await prisma.companyAccount.findFirst({
    where: {
      shopId: store.id,
      OR: [
        { id: rawCompanyId },
        { shopifyCompanyId: rawCompanyId },
        { shopifyCompanyId },
      ],
    },
    select: { id: true, name: true },
  });

  if (!localCompany) {
    return Response.json(
      { error: "Company not found. Please sync companies first." },
      { status: 404 },
    );
  }

  const companyId = localCompany.id;

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
  const seq = String(count + 1).padStart(4, "0");
  const rand = crypto.randomBytes(2).toString("hex");
  let quoteNumber = `Q-${datePart}-${seq}-${rand}`;
  const exists = await prisma.quote.findUnique({ where: { quoteNumber } });
  if (exists) {
    quoteNumber = `Q-${datePart}-${seq}-${crypto.randomBytes(3).toString("hex")}`;
  }

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
          productTitle: item.productTitle || item.title || "Product",
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

  // ── Create Shopify Draft Order ──────────────────────────────
      let shopifyDraftOrderId: string | null = null;
      let shopifyDraftOrderName: string | null = null;
      let invoiceData: any = null;
  try {
    const fullCompany = await prisma.companyAccount.findUnique({
      where: { id: localCompany.id },
      include: { shop: true },
    });
    if (fullCompany?.shopifyCompanyId && fullCompany.shop?.accessToken) {
      // Resolve B2B context (company location + contact)
      const baseMetaQuery = `
        query GetBaseMeta($companyId: ID!) {
          company(id: $companyId) {
            locations(first: 10) { nodes { id } }
            contacts(first: 50) {
              edges {
                node {
                  id
                  customer { id }
                  roleAssignments(first: 5) {
                    edges { node { companyLocation { id } } }
                  }
                }
              }
            }
          }
        }
      `;
      const baseMetaRes = await fetch(
        `https://${fullCompany.shop.shopDomain}/admin/api/2025-01/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": fullCompany.shop.accessToken,
          },
          body: JSON.stringify({
            query: baseMetaQuery,
            variables: { companyId: fullCompany.shopifyCompanyId },
          }),
        },
      );
      const baseMetaData = await baseMetaRes.json();
      const contacts = (baseMetaData.data?.company?.contacts?.edges || []) as any[];
      const matchCustGid = `gid://shopify/Customer/${numericId || ""}`;
      const matchedContact = contacts.find(
        (e: any) => e.node.customer?.id === matchCustGid,
      );
      const companyLocationId =
        matchedContact?.node.roleAssignments?.edges?.[0]?.node?.companyLocation?.id ||
        baseMetaData.data?.company?.locations?.nodes?.[0]?.id ||
        "";
      const companyContactId = matchedContact?.node?.id || "";

      if (companyLocationId && companyContactId) {
        const draftLineItems = items.map((item) => ({
          variantId: item.variantId,
          quantity: item.quantity,
          priceOverride: {
            amount: (Number(item.price) || 0).toFixed(2),
            currencyCode: (item.currencyCode || currencyCode).toUpperCase(),
          },
        }));

        const draftInput: any = {
          lineItems: draftLineItems,
          note: notes || `Quote ${quoteNumber}`,
          customAttributes: [
            { key: "_source", value: "B2B Portal Quote" },
            { key: "Quote Number", value: quoteNumber },
          ],
          presentmentCurrencyCode: currencyCode,
          taxExempt: true,
          purchasingEntity: {
            purchasingCompany: {
              companyId: fullCompany.shopifyCompanyId,
              companyLocationId,
              companyContactId,
            },
          },
        };

        const draftRes = await fetch(
          `https://${fullCompany.shop.shopDomain}/admin/api/2025-01/graphql.json`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": fullCompany.shop.accessToken,
            },
            body: JSON.stringify({
              query: `mutation CreateDraft($input: DraftOrderInput!) {
                draftOrderCreate(input: $input) {
                  draftOrder { id name invoiceUrl totalPriceSet { shopMoney { amount currencyCode } } }
                  userErrors { field message }
                }
              }`,
              variables: { input: draftInput },
            }),
          },
        );
        const draftData = await draftRes.json();
        const draftErrors = draftData.data?.draftOrderCreate?.userErrors || [];
        if (!draftData.errors?.length && !draftErrors.length) {
          shopifyDraftOrderId =
            draftData.data?.draftOrderCreate?.draftOrder?.id || null;
          shopifyDraftOrderName =
            draftData.data?.draftOrderCreate?.draftOrder?.name || null;

          // Build invoice data from quote items (preserves original prices)
          if (shopifyDraftOrderId) {
            invoiceData = {
              name: shopifyDraftOrderName || `Q-${datePart}-${String(count + 1).padStart(4, "0")}`,
              createdAt: new Date().toISOString(),
              currencyCode,
              customer: {
                firstName: resolvedFirstName || null,
                lastName: resolvedLastName || null,
                email: resolvedEmail,
              },
              lineItems: quote.items.map((item: any) => ({
                title: item.productTitle,
                variantTitle: item.variantTitle,
                sku: item.sku,
                quantity: item.quantity,
                originalUnitPrice: Number(item.unitPrice).toFixed(2),
                discount: "0",
                discountedTotal: (Number(item.unitPrice) * item.quantity).toFixed(2),
              })),
              subtotal: subtotal.toFixed(2),
              totalDiscounts: "0",
              totalTax: "0",
              totalShipping: "0",
              totalPrice: subtotal.toFixed(2),
            };
          }
        }
      }
    }
  } catch {
    // Draft order creation is best-effort — quote still created locally
  }

  if (shopifyDraftOrderId) {
    await prisma.quote.update({
      where: { id: quote.id },
      data: { shopifyDraftOrderId, shopifyDraftOrderName, invoiceData },
    });
    await prisma.quoteActivity.create({
      data: {
        quoteId: quote.id,
        companyId,
        customerEmail: resolvedEmail,
        action: "Shopify Draft Created",
        message: `Shopify Draft Order ${shopifyDraftOrderId} created.`,
        metadata: { draftOrderId: shopifyDraftOrderId },
      },
    });
  }

  return Response.json({
    success: true,
    quoteId: quote.id,
    quoteNumber: quote.quoteNumber,
    shopifyDraftOrderId,
    shopifyDraftOrderName,
    message: "Quote request submitted. Your team will review it shortly.",
  });
};
