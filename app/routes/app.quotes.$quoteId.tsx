import nodeCrypto from "node:crypto";
import type { ActionFunctionArgs, LoaderFunctionArgs, HeadersFunction } from "react-router";
import { redirect } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "app/db.server";
import { authenticate } from "app/shopify.server";
import { logQuoteActivity, serializeQuote } from "app/services/quote.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const quoteId = params.quoteId;
  if (!quoteId) return redirect("/app/quotes");

  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true, shopDomain: true, accessToken: true },
  });
  if (!store) return redirect("/app/quotes");

  const quote = await prisma.quote.findFirst({
    where: { id: quoteId, shopId: store.id },
    include: {
      company: { select: { id: true, name: true, shopifyCompanyId: true } },
      salesAgent: { select: { id: true, firstName: true, lastName: true, email: true } },
      items: { orderBy: { createdAt: "asc" } },
      activities: { orderBy: { createdAt: "desc" }, take: 50 },
    },
  });
  if (!quote) return redirect("/app/quotes");

  if (["draft", "sent", "viewed"].includes(quote.status) && quote.expiresAt < new Date()) {
    await prisma.quote.update({ where: { id: quote.id }, data: { status: "expired" } });
    quote.status = "expired";
  }

  return Response.json({
    quote: serializeQuote(quote),
    shopDomain: store.shopDomain,
  });
};

async function recalculateQuoteTotals(quoteId: string) {
  const items = await prisma.quoteItem.findMany({ where: { quoteId } });
  const subtotal = items.reduce((acc, item) => {
    const lineTotal = Number(item.unitPrice) * item.quantity;
    const lineDiscount = Number(item.discount) || 0;
    return acc + Math.max(0, lineTotal - lineDiscount);
  }, 0);

  const quote = await prisma.quote.findUnique({ where: { id: quoteId } });
  if (!quote) return;

  const discountType = quote.discountType === "PERCENTAGE" ? "PERCENTAGE" : "FIXED_AMOUNT";
  const discountAmount = Number(quote.discountAmount) || 0;
  const discountTotal =
    discountType === "PERCENTAGE"
      ? Math.min(subtotal, subtotal * (discountAmount / 100))
      : Math.min(subtotal, discountAmount);

  const taxableAmount = Math.max(0, subtotal - discountTotal);
  const taxRate = Number(quote.taxRate) || 0;
  const taxAmount = taxableAmount * (taxRate / 100);
  const shippingAmount = Number(quote.shippingAmount) || 0;
  const totalAmount = taxableAmount + taxAmount + shippingAmount;

  await prisma.quote.update({
    where: { id: quoteId },
    data: {
      subtotal,
      discountTotal,
      taxAmount,
      totalAmount,
    },
  });
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const quoteId = params.quoteId;
  if (!quoteId) return Response.json({ error: "Missing quote ID" }, { status: 400 });

  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true, shopDomain: true, accessToken: true },
  });
  if (!store) return Response.json({ error: "Store not found" }, { status: 404 });

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  const quote = await prisma.quote.findFirst({
    where: { id: quoteId, shopId: store.id },
    include: { items: true, company: { include: { shop: true } } },
  });
  if (!quote) return Response.json({ error: "Quote not found" }, { status: 404 });

  try {
    // ── UPDATE LINE ITEM ──────────────────────────────────────
    if (intent === "update_line_item") {
      if (quote.status !== "draft") {
        return Response.json({ error: "Only draft quotes can be edited." }, { status: 400 });
      }
      const itemId = String(formData.get("itemId") || "");
      const unitPrice = parseFloat(String(formData.get("unitPrice") || "0"));
      const discount = parseFloat(String(formData.get("itemDiscount") || "0"));
      const quantity = parseInt(String(formData.get("quantity") || "1"), 10);

      if (!itemId) return Response.json({ error: "Missing item ID" }, { status: 400 });
      if (isNaN(unitPrice) || unitPrice < 0) return Response.json({ error: "Invalid price" }, { status: 400 });
      if (isNaN(quantity) || quantity < 1) return Response.json({ error: "Invalid quantity" }, { status: 400 });

      const item = await prisma.quoteItem.findFirst({ where: { id: itemId, quoteId } });
      if (!item) return Response.json({ error: "Item not found" }, { status: 404 });

      const totalPrice = Math.max(0, unitPrice * quantity - (discount || 0));
      await prisma.quoteItem.update({
        where: { id: itemId },
        data: { unitPrice, discount: discount || 0, quantity, totalPrice },
      });

      await recalculateQuoteTotals(quoteId);

      await logQuoteActivity({
        quoteId,
        companyId: quote.companyId,
        customerEmail: quote.customerEmail,
        action: "Line Item Updated",
        message: `Updated "${item.productTitle}" — qty: ${quantity}, price: ${unitPrice}, discount: ${discount || 0}`,
      });

      return Response.json({ success: true, message: "Line item updated." });
    }

    // ── APPLY ORDER DISCOUNT ──────────────────────────────────
    if (intent === "apply_order_discount") {
      if (!["draft", "sent"].includes(quote.status)) {
        return Response.json({ error: "Only draft or sent quotes can have discounts edited." }, { status: 400 });
      }
      const discountAmount = parseFloat(String(formData.get("discountAmount") || "0"));
      const discountType = String(formData.get("discountType") || "FIXED_AMOUNT");

      if (isNaN(discountAmount) || discountAmount < 0) {
        return Response.json({ error: "Invalid discount amount" }, { status: 400 });
      }

      await prisma.quote.update({
        where: { id: quoteId },
        data: {
          discountAmount,
          discountType: discountType === "PERCENTAGE" ? "PERCENTAGE" : "FIXED_AMOUNT",
        },
      });

      await recalculateQuoteTotals(quoteId);

      await logQuoteActivity({
        quoteId,
        companyId: quote.companyId,
        customerEmail: quote.customerEmail,
        action: "Order Discount Applied",
        message: `${discountType === "PERCENTAGE" ? `${discountAmount}%` : `$${discountAmount}`} discount applied.`,
      });

      return Response.json({ success: true, message: "Order discount applied." });
    }

    // ── REMOVE ORDER DISCOUNT ─────────────────────────────────
    if (intent === "remove_order_discount") {
      if (!["draft", "sent"].includes(quote.status)) {
        return Response.json({ error: "Only draft or sent quotes can have discounts edited." }, { status: 400 });
      }
      await prisma.quote.update({
        where: { id: quoteId },
        data: { discountAmount: 0, discountTotal: 0, discountType: "FIXED_AMOUNT" },
      });
      await recalculateQuoteTotals(quoteId);

      await logQuoteActivity({
        quoteId,
        companyId: quote.companyId,
        customerEmail: quote.customerEmail,
        action: "Order Discount Removed",
      });

      return Response.json({ success: true, message: "Order discount removed." });
    }

    // ── SEND INVOICE (create Shopify Draft Order + send) ──────
    if (intent === "send_invoice") {
      const company = quote.company;
      if (!company.shopifyCompanyId || !company.shop?.accessToken) {
        return Response.json({ error: "Company Shopify credentials not found." }, { status: 400 });
      }

      // ── Recalculate totals so discount/subtotal/total are up to date ──
      await recalculateQuoteTotals(quoteId);
      const freshQuote = await prisma.quote.findFirst({
        where: { id: quoteId, shopId: store.id },
        include: { items: true, company: { include: { shop: true } } },
      });
      if (!freshQuote) return Response.json({ error: "Quote not found after recalculation" }, { status: 404 });

      // Sync recalculated totals onto the local quote object so the rest of the handler uses fresh values
      quote.subtotal = freshQuote.subtotal;
      quote.discountTotal = freshQuote.discountTotal;
      quote.taxAmount = freshQuote.taxAmount;
      quote.totalAmount = freshQuote.totalAmount;

      let draftInvoiceUrl: string | null = null;

      // ── Resolve B2B context ──
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
      const contacts = (baseMetaData.data?.company?.contacts?.edges || []) as any[];
      const matchCustGid = `gid://shopify/Customer/${quote.customerShopifyId}`;
      const matchedContact = contacts.find((e: any) => e.node.customer?.id === matchCustGid);
      const companyLocationId =
        matchedContact?.node.roleAssignments?.edges?.[0]?.node?.companyLocation?.id ||
        baseMetaData.data?.company?.locations?.nodes?.[0]?.id ||
        "";
      const companyContactId = matchedContact?.node?.id || "";

      if (!companyLocationId || !companyContactId) {
        return Response.json({ error: "B2B context missing. Customer is not a company contact." }, { status: 400 });
      }

      // ── Build line items with current prices/discounts ──
      const lineItems = quote.items.map((item) => {
        const basePrice = Number(item.unitPrice) || 0;
        const itemDiscount = Math.max(0, Number(item.discount) || 0);
        const discountedPrice = Math.max(0, basePrice * item.quantity - itemDiscount) / item.quantity;
        return {
          variantId: item.variantId,
          quantity: item.quantity,
          priceOverride: {
            amount: discountedPrice.toFixed(2),
            currencyCode: item.currencyCode,
          },
        };
      });

      // Tax line
      if (Number(quote.taxAmount) > 0) {
        lineItems.push({
          variantId: undefined as any,
          quantity: 1,
          priceOverride: undefined as any,
          title: `Estimated Tax (${Number(quote.taxRate).toFixed(2)}%)`,
          originalUnitPriceWithCurrency: {
            amount: Number(quote.taxAmount).toFixed(2),
            currencyCode: quote.currencyCode,
          },
          taxable: false,
          requiresShipping: false,
        } as any);
      }

      // Shipping line
      if (Number(quote.shippingAmount) > 0) {
        (lineItems as any[]).push({
          title: "Shipping",
          quantity: 1,
          originalUnitPriceWithCurrency: {
            amount: Number(quote.shippingAmount).toFixed(2),
            currencyCode: quote.currencyCode,
          },
          taxable: false,
          requiresShipping: false,
        });
      }

      const appliedDiscount =
        Number(quote.discountTotal) > 0
          ? {
              value: Number(quote.discountTotal),
              valueType: "FIXED_AMOUNT" as const,
              title: quote.discountType === "PERCENTAGE"
                ? `Quote Discount (${quote.discountAmount}%)`
                : "Quote Discount",
            }
          : undefined;

      const draftInput: any = {
        lineItems,
        note: quote.customerNotes || `Quote ${quote.quoteNumber}`,
        customAttributes: [
          { key: "_source", value: "B2B Portal Quote" },
          { key: "Quote Number", value: quote.quoteNumber },
        ],
        presentmentCurrencyCode: quote.currencyCode,
        taxExempt: true,
        purchasingEntity: {
          purchasingCompany: {
            companyId: company.shopifyCompanyId,
            companyLocationId,
            companyContactId,
          },
        },
      };
      if (appliedDiscount) draftInput.appliedDiscount = appliedDiscount;

      let draftOrderId: string;
      let draftOrderName: string | null = null;
      const shopApiBase = `https://${company.shop.shopDomain}/admin/api/2025-01/graphql.json`;
      const shopApiHeaders = {
        "Content-Type": "application/json" as const,
        "X-Shopify-Access-Token": company.shop.accessToken,
      };

      if (quote.shopifyDraftOrderId) {
        // ── Update existing draft order ──
        const updateRes = await fetch(shopApiBase, {
          method: "POST",
          headers: shopApiHeaders,
          body: JSON.stringify({
            query: `mutation DraftOrderUpdate($id: ID!, $input: DraftOrderInput!) {
              draftOrderUpdate(id: $id, input: $input) {
                draftOrder { id name invoiceUrl totalPriceSet { shopMoney { amount currencyCode } } }
                userErrors { field message }
              }
            }`,
            variables: { id: quote.shopifyDraftOrderId, input: draftInput },
          }),
        });
        const updateData = await updateRes.json();
        const updateErrors = updateData.data?.draftOrderUpdate?.userErrors || [];
        if (updateData.errors?.length || updateErrors.length) {
          return Response.json(
            { error: updateData.errors?.[0]?.message || updateErrors[0]?.message || "Draft order update failed" },
            { status: 400 },
          );
        }
        const updatedDraft = updateData.data?.draftOrderUpdate?.draftOrder;
        if (!updatedDraft?.id) {
          return Response.json({ error: "Failed to update draft order" }, { status: 400 });
        }
        draftOrderId = updatedDraft.id;
        draftOrderName = updatedDraft.name || null;
        draftInvoiceUrl = updatedDraft.invoiceUrl || null;
      } else {
        // ── Create new draft order ──
        const createRes = await fetch(shopApiBase, {
          method: "POST",
          headers: shopApiHeaders,
          body: JSON.stringify({
            query: `mutation DraftOrderCreate($input: DraftOrderInput!) {
              draftOrderCreate(input: $input) {
                draftOrder { id name invoiceUrl totalPriceSet { shopMoney { amount currencyCode } } }
                userErrors { field message }
              }
            }`,
            variables: { input: draftInput },
          }),
        });
        const createData = await createRes.json();
        const createErrors = createData.data?.draftOrderCreate?.userErrors || [];
        if (createData.errors?.length || createErrors.length) {
          return Response.json(
            { error: createData.errors?.[0]?.message || createErrors[0]?.message || "Draft order creation failed" },
            { status: 400 },
          );
        }
        const newDraft = createData.data?.draftOrderCreate?.draftOrder;
        if (!newDraft?.id) {
          return Response.json({ error: "Failed to create draft order" }, { status: 400 });
        }
        draftOrderId = newDraft.id;
        draftOrderName = newDraft.name || null;
        draftInvoiceUrl = newDraft.invoiceUrl || null;
      }

      // Build invoice data from quote (preserves original prices + discounts)
      const savedInvoiceData = {
        name: draftOrderName || quote.quoteNumber,
        createdAt: new Date().toISOString(),
        currencyCode: quote.currencyCode,
        customer: {
          firstName: quote.customerFirstName,
          lastName: quote.customerLastName,
          email: quote.customerEmail,
        },
        lineItems: quote.items.map((item: any) => ({
          title: item.productTitle,
          variantTitle: item.variantTitle,
          sku: item.sku,
          quantity: item.quantity,
          originalUnitPrice: Number(item.unitPrice).toFixed(2),
          discount: Number(item.discount || 0).toFixed(2),
          discountedTotal: (Number(item.unitPrice) * item.quantity - Number(item.discount || 0)).toFixed(2),
        })),
        subtotal: quote.subtotal.toString(),
        totalDiscounts: quote.discountTotal.toString(),
        totalTax: quote.taxAmount.toString(),
        totalShipping: quote.shippingAmount.toString(),
        totalPrice: quote.totalAmount.toString(),
        invoiceSentAt: null as string | null,
      };

      // Save draft order ID, name, and invoice data on the quote
      await prisma.quote.update({
        where: { id: quoteId },
        data: {
          shopifyDraftOrderId: draftOrderId,
          shopifyDraftOrderName: draftOrderName,
          invoiceData: savedInvoiceData,
        },
      });

      // ── Send invoice via Shopify ──
      const sendInvoiceRes = await fetch(
        `https://${company.shop.shopDomain}/admin/api/2025-01/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": company.shop.accessToken,
          },
          body: JSON.stringify({
            query: `mutation DraftOrderInvoiceSend($id: ID!) {
              draftOrderInvoiceSend(id: $id) { draftOrder { id invoiceUrl } userErrors { message } }
            }`,
            variables: { id: draftOrderId! },
          }),
        },
      );
      const invoiceData = await sendInvoiceRes.json();
      const invoiceErrors = invoiceData.data?.draftOrderInvoiceSend?.userErrors || [];
      const invoiceUrl = invoiceData.data?.draftOrderInvoiceSend?.draftOrder?.invoiceUrl || draftInvoiceUrl;

      const invoiceSentAt = new Date().toISOString();
      await prisma.quote.update({
        where: { id: quoteId },
        data: {
          status: "sent",
          sentAt: new Date(),
          invoiceData: { ...savedInvoiceData, invoiceSentAt },
        },
      });

      await logQuoteActivity({
        quoteId,
        companyId: quote.companyId,
        customerEmail: quote.customerEmail,
        action: "Invoice Sent",
        message: invoiceErrors.length
          ? `Draft order (${draftOrderId}) but invoice email failed: ${invoiceErrors[0].message}`
          : `Invoice sent. Invoice URL: ${invoiceUrl || "N/A"}`,
        metadata: { draftOrderId, invoiceUrl },
      });

      return Response.json({
        success: true,
        message: invoiceErrors.length
          ? `Draft order exists but invoice email failed: ${invoiceErrors[0].message}`
          : "Invoice sent to customer.",
        invoiceUrl,
      });
    }

    // ── CREATE ORDER (MANUAL PAYMENT) ────────────────────────
    if (intent === "create_order_manual") {
      if (["converted", "cancelled"].includes(quote.status)) {
        return Response.json({ error: "Quote cannot be converted." }, { status: 400 });
      }

      const orderTotal = Number(quote.totalAmount);
      const order = await prisma.b2BOrder.create({
        data: {
          companyId: quote.companyId,
          createdByUserId: quote.salesAgentId,
          shopId: quote.shopId,
          shopifyOrderId: `manual-${nodeCrypto.randomBytes(8).toString("hex")}`,
          orderTotal,
          creditUsed: 0,
          paymentStatus: "pending",
          orderStatus: "completed",
          remainingBalance: orderTotal,
          userCreditUsed: 0,
          notes: `Manual order from quote ${quote.quoteNumber}. ${quote.internalNotes || ""}`,
          source: "Manual Order from Quote",
          orderNumber: quote.quoteNumber,
          customerId: quote.customerUserId || quote.customerShopifyId,
          customerName: [quote.customerFirstName, quote.customerLastName].filter(Boolean).join(" "),
          customerEmail: quote.customerEmail,
          currencyCode: quote.currencyCode,
          subtotal: quote.subtotal,
          discountTotal: quote.discountTotal,
          taxAmount: quote.taxAmount,
          shippingAmount: quote.shippingAmount,
          items: {
            create: quote.items.map((item) => ({
              productId: item.productId,
              productTitle: item.productTitle,
              variantId: item.variantId,
              variantTitle: item.variantTitle,
              sku: item.sku,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              discount: item.discount,
              lineTotal: item.totalPrice,
            })),
          },
          activities: {
            create: {
              userId: quote.salesAgentId,
              action: "Order Created",
              message: `Manual order created from quote ${quote.quoteNumber}.`,
            },
          },
        },
      });

      await prisma.quote.update({
        where: { id: quoteId },
        data: { status: "converted", convertedAt: new Date(), convertedOrderId: order.id },
      });

      await logQuoteActivity({
        quoteId,
        companyId: quote.companyId,
        customerEmail: quote.customerEmail,
        action: "Quote Converted (Manual)",
        message: `Manual order created. Order ID: ${order.id}.`,
        metadata: { orderId: order.id },
      });

      return Response.json({ success: true, message: `Order created: ${order.id}`, orderId: order.id });
    }

    // ── UPDATE QUOTE METADATA ─────────────────────────────────
    if (intent === "update_quote") {
      if (quote.status !== "draft") {
        return Response.json({ error: "Only draft quotes can be edited." }, { status: 400 });
      }
      const title = String(formData.get("title") || "").trim();
      const customerNotes = String(formData.get("customerNotes") || "");
      const internalNotes = String(formData.get("internalNotes") || "");
      const expires = String(formData.get("expiresAt") || "");

      await prisma.quote.update({
        where: { id: quoteId },
        data: {
          title: title || quote.title,
          customerNotes,
          internalNotes,
          expiresAt: expires ? new Date(`${expires}T23:59:59.999`) : quote.expiresAt,
        },
      });

      await logQuoteActivity({
        quoteId,
        companyId: quote.companyId,
        customerEmail: quote.customerEmail,
        action: "Quote Updated",
      });

      return Response.json({ success: true, message: "Quote updated." });
    }

    // ── CANCEL ────────────────────────────────────────────────
    if (intent === "cancel_quote") {
      await prisma.quote.update({
        where: { id: quoteId },
        data: { status: "cancelled", cancelledAt: new Date() },
      });
      await logQuoteActivity({
        quoteId,
        companyId: quote.companyId,
        customerEmail: quote.customerEmail,
        action: "Quote Cancelled",
      });
      return Response.json({ success: true, message: "Quote cancelled." });
    }

    // ── DELETE ────────────────────────────────────────────────
    if (intent === "delete_quote") {
      await prisma.quote.delete({ where: { id: quoteId } });
      return Response.json({ success: true, message: "Quote deleted." });
    }

    // ── PREVIEW INVOICE ──────────────────────────────────────
    if (intent === "preview_invoice") {
      if (!quote.shopifyDraftOrderId) {
        return Response.json(
          { error: `No draft order linked to this quote (${quote.shopifyDraftOrderName || quote.quoteNumber}). Send the invoice first.` },
          { status: 400 },
        );
      }

      const label = quote.shopifyDraftOrderName || quote.quoteNumber;

      // Fallback: query Shopify (legacy quotes without stored data)
      const company = quote.company;
      if (!company.shop?.accessToken) {
        return Response.json({ error: "Shop credentials not found." }, { status: 400 });
      }

      const gqlHeaders = {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": company.shop.accessToken,
      };
      const shopUrl = `https://${company.shop.shopDomain}/admin/api/2025-01/graphql.json`;

      let draft: any = null;
      let rawId = quote.shopifyDraftOrderId || "";
      let draftOrderId = rawId;
      if (!draftOrderId.startsWith("gid://")) {
        const num = draftOrderId.replace(/[^0-9]/g, "");
        if (num) draftOrderId = `gid://shopify/DraftOrder/${num}`;
      }

      try {
        const res = await fetch(shopUrl, {
          method: "POST",
          headers: gqlHeaders,
          body: JSON.stringify({
            query: `query GetDraftOrder($id: ID!) {
              draftOrder(id: $id) {
                id name createdAt currencyCode
                customer { firstName lastName email }
                lineItems(first: 50) {
                  nodes { title variantTitle sku quantity
                    originalUnitPrice { amount currencyCode }
                    discountedTotal { amount currencyCode }
                  }
                }
                subtotalPrice { amount currencyCode }
                totalDiscounts { amount currencyCode }
                totalTax { amount currencyCode }
                totalShippingMoney { amount currencyCode }
                totalPrice { amount currencyCode }
                invoiceSentAt
              }
            }`,
            variables: { id: draftOrderId },
          }),
        });
        const data = await res.json();
        draft = data.data?.draftOrder;
      } catch { /* continue to next step */ }

      if (!draft) {
        try {
          let orderId = draftOrderId;
          if (orderId.includes("DraftOrder")) {
            orderId = orderId.replace("DraftOrder", "Order");
          }
          const res = await fetch(shopUrl, {
            method: "POST",
            headers: gqlHeaders,
            body: JSON.stringify({
              query: `query GetOrder($id: ID!) {
                order(id: $id) {
                  id name createdAt currencyCode
                  customer { firstName lastName email }
                  lineItems(first: 50) {
                    nodes { title variantTitle sku quantity
                      originalUnitPrice
                      discountedTotal
                    }
                  }
                  subtotalPrice
                  totalDiscounts
                  totalTax
                  totalPrice
                }
              }`,
              variables: { id: orderId },
            }),
          });
          const data = await res.json();
          draft = data.data?.order;
        } catch { /* continue to next step */ }
      }

      if (!draft && label && label.startsWith("#")) {
        try {
          const res = await fetch(shopUrl, {
            method: "POST",
            headers: gqlHeaders,
            body: JSON.stringify({
              query: `query SearchOrder($query: String!) {
                orders(first: 1, query: $query) {
                  nodes {
                    id name createdAt currencyCode
                    customer { firstName lastName email }
                    lineItems(first: 50) {
                      nodes { title variantTitle sku quantity
                        originalUnitPrice
                        discountedTotal
                      }
                    }
                    subtotalPrice
                    totalDiscounts
                    totalTax
                    totalPrice
                  }
                }
              }`,
              variables: { query: `name:${label}` },
            }),
          });
          const data = await res.json();
          draft = data.data?.orders?.nodes?.[0] || null;
        } catch { /* continue to next step */ }
      }

      // Fallback: search by quote number in order note
      if (!draft && quote.quoteNumber) {
        try {
          const res = await fetch(shopUrl, {
            method: "POST",
            headers: gqlHeaders,
            body: JSON.stringify({
              query: `query SearchOrderByNote($query: String!) {
                orders(first: 1, query: $query) {
                  nodes {
                    id name createdAt currencyCode
                    customer { firstName lastName email }
                    lineItems(first: 50) {
                      nodes { title variantTitle sku quantity
                        originalUnitPrice
                        discountedTotal
                      }
                    }
                    subtotalPrice
                    totalDiscounts
                    totalTax
                    totalPrice
                  }
                }
              }`,
              variables: { query: `note:${quote.quoteNumber}` },
            }),
          });
          const data = await res.json();
          draft = data.data?.orders?.nodes?.[0] || null;
        } catch { /* continue to next step */ }
      }

      if (!draft) {
        return Response.json(
          { error: `Could not load invoice for "${label}". Please check the order on Shopify admin.` },
          { status: 400 },
        );
      }

      // Build invoice data from quote (preserves original prices + discounts)
      return Response.json({
        success: true,
        invoiceData: {
          name: label,
          createdAt: quote.createdAt.toISOString(),
          currencyCode: quote.currencyCode,
          customer: {
            firstName: quote.customerFirstName,
            lastName: quote.customerLastName,
            email: quote.customerEmail,
          },
          lineItems: quote.items.map((item: any) => ({
            title: item.productTitle,
            variantTitle: item.variantTitle,
            sku: item.sku,
            quantity: item.quantity,
            originalUnitPrice: Number(item.unitPrice).toFixed(2),
            discount: Number(item.discount || 0).toFixed(2),
            discountedTotal: (Number(item.unitPrice) * item.quantity - Number(item.discount || 0)).toFixed(2),
          })),
          subtotal: quote.subtotal.toString(),
          totalDiscounts: quote.discountTotal.toString(),
          totalTax: quote.taxAmount.toString(),
          totalShipping: quote.shippingAmount.toString(),
          totalPrice: quote.totalAmount.toString(),
          invoiceSentAt: null,
        },
      });
    }

    // ── DUPLICATE ─────────────────────────────────────────────
    if (intent === "duplicate_quote") {
      const duplicate = await prisma.quote.create({
        data: {
          quoteNumber: `${quote.quoteNumber}-COPY-${Date.now().toString().slice(-4)}`,
          shopId: quote.shopId,
          companyId: quote.companyId,
          salesAgentId: quote.salesAgentId,
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
        companyId: quote.companyId,
        customerEmail: quote.customerEmail,
        action: "Quote Duplicated",
        message: `Duplicated from ${quote.quoteNumber}.`,
      });

      return Response.json({ success: true, message: "Quote duplicated.", quoteId: duplicate.id });
    }
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Action failed" },
      { status: 400 },
    );
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

export { default } from "./app.quotes.$quoteId.page";
