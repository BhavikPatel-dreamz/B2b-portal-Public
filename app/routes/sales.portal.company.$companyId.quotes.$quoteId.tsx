// import nodeCrypto from "node:crypto";
// import type React from "react";
// import { useEffect, useRef, useState } from "react";
// import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
// import {
//   Form,
//   Link,
//   redirect,
//   useActionData,
//   useLoaderData,
//   useNavigation,
// } from "react-router";
// import prisma from "app/db.server";
// import {
//   buildClearSessionCookie,
//   hasCompanyAccess,
//   requireSalesSession,
// } from "app/utils/sales-session.server";
// import {
//   convertQuoteToOrder,
//   getQuoteUrl,
//   logQuoteActivity,
//   sendQuoteToCustomer,
//   serializeQuote,
// } from "app/services/quote.server";
// import {
//   SalesPortalHeader,
//   SalesPortalLayout,
// } from "app/components/SalesPortalLayout";
// import {
//   getDeliveryDetailsForRecord,
//   type DeliveryDetails,
// } from "app/services/delivery-details.server";

// async function resolveQuoteCompanyId(quoteId: string) {
//   const quote = await prisma.quote.findUnique({
//     where: { id: quoteId },
//     select: { companyId: true },
//   });

//   return quote?.companyId || null;
// }

// type ActionResponse = {
//   success?: boolean;
//   message?: string;
//   error?: string;
//   invoiceData?: any;
// };

// type AddProductForm = {
//   productTitle: string;
//   sku: string;
//   variantTitle: string;
//   variantId: string;
//   image: string;
//   unitPrice: string;
//   discount: string;
//   quantity: number;
// };

// type NewProductRow = AddProductForm & { rowKey: string };

// const editableStatuses = ["draft", "sent", "viewed", "approved"];

// export const loader = async ({ request, params }: LoaderFunctionArgs) => {
//   const { user } = await requireSalesSession(request);
//   const companyId = params.companyId;
//   const quoteId = params.quoteId;
//   if (!quoteId) {
//     return redirect("/sales/portal");
//   }

//   const resolvedCompanyId = companyId || (await resolveQuoteCompanyId(quoteId));
//   if (!resolvedCompanyId || !hasCompanyAccess(user, resolvedCompanyId)) {
//     return redirect("/sales/portal");
//   }

//   const quote = await prisma.quote.findFirst({
//     where: { id: quoteId, companyId: resolvedCompanyId },
//     include: {
//       company: {
//         include: {
//           shop: {
//             select: {
//               shopName: true,
//               shopDomain: true,
//             },
//           },
//         },
//       },
//       salesAgent: { select: { firstName: true, lastName: true, email: true } },
//       items: { orderBy: { createdAt: "asc" } },
//       activities: { orderBy: { createdAt: "desc" } },
//     },
//   });
//   if (!quote) {
//     return redirect(
//       resolvedCompanyId
//         ? `/sales/portal/company/${resolvedCompanyId}/quotes`
//         : "/sales/portal",
//     );
//   }

//   if (
//     ["draft", "sent", "viewed"].includes(quote.status) &&
//     quote.expiresAt < new Date()
//   ) {
//     await prisma.quote.update({
//       where: { id: quote.id },
//       data: { status: "expired" },
//     });
//     quote.status = "expired";
//   }

//   const url = new URL(request.url);
//   const shopCredentials = await prisma.store.findUnique({
//     where: { id: quote.shopId },
//     select: { shopDomain: true, accessToken: true },
//   });
//   const deliveryDetails = await getDeliveryDetailsForRecord({
//     ...quote,
//     company: {
//       ...quote.company,
//       shop: {
//         ...quote.company.shop,
//         shopDomain: shopCredentials?.shopDomain || quote.company.shop.shopDomain,
//         accessToken: shopCredentials?.accessToken || null,
//       },
//     },
//   });
//   return Response.json({
//     quote: serializeQuote(quote),
//     user: {
//       firstName: user.firstName,
//       lastName: user.lastName,
//       email: user.email,
//     },
//     allCompanies: user.salesCompanies.map((item) => ({
//       id: item.company.id,
//       name: item.company.name,
//     })),
//     quoteCount: await prisma.quote.count({ where: { companyId: resolvedCompanyId } }),
//     orderCount: await prisma.b2BOrder.count({
//       where: {
//         companyId: resolvedCompanyId,
//         orderStatus: { notIn: ["converted", "archived"] },
//       },
//     }),
//     quoteUrl: getQuoteUrl(request, quote),
//     created: url.searchParams.get("created") === "1",
//     duplicatedFrom: url.searchParams.get("duplicatedFrom") || "",
//     passedQuoteUrl: url.searchParams.get("quoteUrl") || "",
//     deliveryDetails,
//   });
// };

// async function recalculateQuoteTotals(quoteId: string) {
//   const items = await prisma.quoteItem.findMany({ where: { quoteId } });
//   const subtotal = items.reduce((total, item) => {
//     const lineTotal = Number(item.unitPrice) * item.quantity;
//     const lineDiscount = Number(item.discount) || 0;
//     return total + Math.max(0, lineTotal - lineDiscount);
//   }, 0);

//   const quote = await prisma.quote.findUnique({ where: { id: quoteId } });
//   if (!quote) return;

//   const discountType = quote.discountType === "PERCENTAGE" ? "PERCENTAGE" : "FIXED_AMOUNT";
//   const discountAmount = Number(quote.discountAmount) || 0;
//   const discountTotal =
//     discountType === "PERCENTAGE"
//       ? Math.min(subtotal, subtotal * (discountAmount / 100))
//       : Math.min(subtotal, discountAmount);

//   const taxableAmount = Math.max(0, subtotal - discountTotal);
//   const taxRate = Number(quote.taxRate) || 0;
//   const taxAmount = taxableAmount * (taxRate / 100);
//   const shippingAmount = Number(quote.shippingAmount) || 0;
//   const totalAmount = taxableAmount + taxAmount + shippingAmount;

//   await prisma.quote.update({
//     where: { id: quoteId },
//     data: {
//       subtotal,
//       discountTotal,
//       taxAmount,
//       totalAmount,
//     },
//   });
// }

// export const action = async ({ request, params }: ActionFunctionArgs) => {
//   const { user } = await requireSalesSession(request);
//   const companyId = params.companyId;
//   const quoteId = params.quoteId;
//   if (!quoteId) {
//     return Response.json({ error: "Quote not found" }, { status: 404 });
//   }

//   const resolvedCompanyId = companyId || (await resolveQuoteCompanyId(quoteId));
//   if (!resolvedCompanyId || !hasCompanyAccess(user, resolvedCompanyId)) {
//     return Response.json({ error: "Access denied" }, { status: 403 });
//   }

//   const formData = await request.formData();
//   const intentValues = formData.getAll("intent").map(String).filter(Boolean);
//   const intent = intentValues.length ? intentValues[intentValues.length - 1] : "";
//   if (intent === "logout") {
//     return redirect("/sales/login", {
//       headers: { "Set-Cookie": buildClearSessionCookie() },
//     });
//   }
//   const quote = await prisma.quote.findFirst({
//     where: { id: quoteId, companyId: resolvedCompanyId },
//     include: { items: true },
//   });
//   if (!quote) {
//     return Response.json({ error: "Quote not found" }, { status: 404 });
//   }

//   // handle server-backed delete of a persisted quote item
//   if (intent === "delete_item") {
//     const itemId = String(formData.get("itemId") || "");
//     if (!itemId) return Response.json({ error: "Item id missing" }, { status: 400 });
//     const item = await prisma.quoteItem.findUnique({ where: { id: itemId }, select: { id: true, quoteId: true, productTitle: true } });
//     if (!item || item.quoteId !== quote.id) return Response.json({ error: "Item not found" }, { status: 404 });
//     await prisma.quoteItem.delete({ where: { id: itemId } });
//     await recalculateQuoteTotals(quote.id);
//     await logQuoteActivity({ quoteId: quote.id, userId: user.id, companyId: resolvedCompanyId, customerEmail: quote.customerEmail, action: "Quote Item Removed", message: `Removed item ${item.productTitle || item.id}` });
//     return Response.json({ success: true, message: "Item removed." });
//   }

//   try {
//     if (intent === "update_quote") {
//       if (quote.status !== "draft") {
//         return Response.json(
//           { error: "Only draft quotes can be edited." },
//           { status: 400 },
//         );
//       }

//       const title = String(formData.get("title") || "").trim();
//       const customerFirstName = String(formData.get("customerFirstName") || "").trim();
//       const customerLastName = String(formData.get("customerLastName") || "").trim();
//       const customerEmail = String(formData.get("customerEmail") || "").trim();
//       const deliveryLocationName = String(formData.get("deliveryLocationName") || "").trim();
//       const deliveryAddress = String(formData.get("deliveryAddress") || "").trim();
//       const deliveryPhone = String(formData.get("deliveryPhone") || "").trim();
//       const customerNotes = String(formData.get("customerNotes") || "");
//       const internalNotes = String(formData.get("internalNotes") || "");
//       const expires = String(formData.get("expiresAt") || "");
//       const normalizedCustomerEmail = customerEmail || quote.customerEmail;
//       if (!normalizedCustomerEmail) {
//         throw new Error("Customer email is required.");
//       }

//       const itemUpdates = quote.items
//         .map((item) => {
//           const quantityValue = Number(formData.get(`quantity_${item.id}`));
//           const unitPriceValue = Number(formData.get(`unitPrice_${item.id}`));
//           const discountValue = Number(formData.get(`discount_${item.id}`));

//           if (!Number.isFinite(quantityValue) || quantityValue < 1) {
//             throw new Error(`Invalid quantity for ${item.productTitle}`);
//           }
//           if (!Number.isFinite(unitPriceValue) || unitPriceValue < 0) {
//             throw new Error(`Invalid unit price for ${item.productTitle}`);
//           }
//           if (!Number.isFinite(discountValue) || discountValue < 0) {
//             throw new Error(`Invalid discount for ${item.productTitle}`);
//           }

//           const totalPrice = Math.max(0, unitPriceValue * quantityValue - discountValue);
//           return {
//             id: item.id,
//             quantity: Math.round(quantityValue),
//             unitPrice: unitPriceValue,
//             discount: discountValue,
//             totalPrice,
//           };
//         })
//         .filter(Boolean);

//       const newRowKeys = formData.getAll("newProductRow").map(String).filter(Boolean);
//       const newItems = newRowKeys
//         .map((rowKey) => {
//           const productTitle = String(formData.get(`newProductTitle_${rowKey}`) || "").trim();
//           const variantTitle = String(formData.get(`newVariantTitle_${rowKey}`) || "").trim();
//           const sku = String(formData.get(`newSku_${rowKey}`) || "").trim();
//           const variantId = String(formData.get(`newVariantId_${rowKey}`) || "").trim();
//           const image = String(formData.get(`newImage_${rowKey}`) || "").trim();
//           const quantity = Number(formData.get(`newQuantity_${rowKey}`));
//           const unitPrice = Number(formData.get(`newUnitPrice_${rowKey}`));
//           const discount = Number(formData.get(`newDiscount_${rowKey}`));

//           const isAnyValueFilled = Boolean(productTitle || variantTitle || sku || image || quantity || unitPrice || discount);
//           if (!isAnyValueFilled) return null;

//           const validQuantity = Number.isFinite(quantity) && quantity > 0 ? Math.round(quantity) : 1;
//           const validUnitPrice = Number.isFinite(unitPrice) && unitPrice >= 0 ? unitPrice : 0;
//           const validDiscount = Number.isFinite(discount) && discount >= 0 ? discount : 0;

//           return {
//             productTitle: productTitle || "Product",
//             variantTitle,
//             sku,
//             image: image || null,
//             variantId: variantId || "",
//             quantity: validQuantity,
//             unitPrice: validUnitPrice,
//             discount: validDiscount,
//             totalPrice: Math.max(0, validUnitPrice * validQuantity - validDiscount),
//           };
//         })
//         .filter(Boolean) as Array<{
//           productTitle: string;
//           variantTitle: string;
//           sku: string;
//           image: string | null;
//           variantId: string;
//           quantity: number;
//           unitPrice: number;
//           discount: number;
//           totalPrice: number;
//         }>;

//       if (!itemUpdates.length && !newItems.length) {
//         return Response.json({ error: "No quote changes were submitted." }, { status: 400 });
//       }

//       const quoteCurrency = quote.currencyCode || quote.items?.[0]?.currencyCode || "USD";
//       const existingInvoiceData =
//         quote.invoiceData && typeof quote.invoiceData === "object"
//           ? (quote.invoiceData as Record<string, any>)
//           : {};
//       const nextInvoiceData = {
//         ...existingInvoiceData,
//         quoteEditMeta: {
//           ...(existingInvoiceData.quoteEditMeta && typeof existingInvoiceData.quoteEditMeta === "object"
//             ? existingInvoiceData.quoteEditMeta
//             : {}),
//           customerDetails: {
//             firstName: customerFirstName || quote.customerFirstName || null,
//             lastName: customerLastName || quote.customerLastName || null,
//             email: normalizedCustomerEmail,
//           },
//           deliveryDetails: {
//             locationName: deliveryLocationName || null,
//             address: deliveryAddress || null,
//             phone: deliveryPhone || null,
//           },
//         },
//       };

//       await prisma.$transaction(async (tx) => {
//         for (const item of itemUpdates) {
//           await tx.quoteItem.update({
//             where: { id: item.id },
//             data: {
//               quantity: item.quantity,
//               unitPrice: item.unitPrice,
//               discount: item.discount,
//               totalPrice: item.totalPrice,
//             },
//           });
//         }

//         for (const newItem of newItems) {
//           await tx.quoteItem.create({
//             data: {
//               quoteId: quote.id,
//               productTitle: newItem.productTitle,
//               variantTitle: newItem.variantTitle,
//               sku: newItem.sku,
//               image: newItem.image,
//               quantity: newItem.quantity,
//               unitPrice: newItem.unitPrice,
//               discount: newItem.discount,
//               totalPrice: newItem.totalPrice,
//               currencyCode: quoteCurrency,
//               variantId: newItem.variantId,
//             },
//           });
//         }

//         await tx.quote.update({
//           where: { id: quote.id },
//           data: {
//             title: title || quote.title,
//             customerFirstName: customerFirstName || quote.customerFirstName || null,
//             customerLastName: customerLastName || quote.customerLastName || null,
//             customerEmail: normalizedCustomerEmail,
//             customerNotes,
//             internalNotes,
//             expiresAt: expires
//               ? new Date(`${expires}T23:59:59.999`)
//               : quote.expiresAt,
//             invoiceData: nextInvoiceData,
//           },
//         });
//       });

//       await recalculateQuoteTotals(quote.id);

//       await logQuoteActivity({
//         quoteId: quote.id,
//         userId: user.id,
//         companyId: resolvedCompanyId,
//         customerEmail: normalizedCustomerEmail,
//         action: "Quote Updated",
//         message: "Quote customer details, delivery details, items, notes, and expiry were updated.",
//       });
//       return Response.json({ success: true, message: "Quote updated." });
//     }

//     if (intent === "cancel_quote") {
//       await prisma.quote.update({
//         where: { id: quote.id },
//         data: { status: "cancelled", cancelledAt: new Date() },
//       });
//       await logQuoteActivity({
//         quoteId: quote.id,
//         userId: user.id,
//         companyId: resolvedCompanyId,
//         customerEmail: quote.customerEmail,
//         action: "Quote Cancelled",
//       });
//       return Response.json({ success: true, message: "Quote cancelled." });
//     }

//     if (intent === "preview_invoice") {
//       if (!quote.shopifyDraftOrderId) {
//         return Response.json(
//           { error: `No draft order linked to this quote (${quote.shopifyDraftOrderName || quote.quoteNumber}). Send the invoice first.` },
//           { status: 400 },
//         );
//       }

//       const label = quote.shopifyDraftOrderName || quote.quoteNumber;

//       // Fallback: query Shopify (legacy quotes without stored data)
//       const shop = await prisma.store.findFirst({
//         where: { companyAccounts: { some: { id: companyId } } },
//         select: { shopDomain: true, accessToken: true },
//       });
//       if (!shop?.accessToken) {
//         return Response.json({ error: "Shop not found." }, { status: 400 });
//       }

//       const gqlHeaders = {
//         "Content-Type": "application/json",
//         "X-Shopify-Access-Token": shop.accessToken,
//       };
//       const shopUrl = `https://${shop.shopDomain}/admin/api/2025-01/graphql.json`;

//       let draft: any = null;
//       let rawId = quote.shopifyDraftOrderId || "";
//       let draftOrderId = rawId;
//       if (!draftOrderId.startsWith("gid://")) {
//         const num = draftOrderId.replace(/[^0-9]/g, "");
//         if (num) draftOrderId = `gid://shopify/DraftOrder/${num}`;
//       }

//       try {
//         const res = await fetch(shopUrl, {
//           method: "POST",
//           headers: gqlHeaders,
//           body: JSON.stringify({
//             query: `query GetDraftOrder($id: ID!) {
//               draftOrder(id: $id) {
//                 id name createdAt currencyCode
//                 customer { firstName lastName email }
//                 lineItems(first: 50) {
//                   nodes { title variantTitle sku quantity
//                     originalUnitPrice { amount currencyCode }
//                     discountedTotal { amount currencyCode }
//                   }
//                 }
//                 subtotalPrice { amount currencyCode }
//                 totalDiscounts { amount currencyCode }
//                 totalTax { amount currencyCode }
//                 totalShippingMoney { amount currencyCode }
//                 totalPrice { amount currencyCode }
//                 invoiceSentAt
//               }
//             }`,
//             variables: { id: draftOrderId },
//           }),
//         });
//         const data = await res.json();
//         draft = data.data?.draftOrder;
//       } catch { /* continue */ }

//       if (!draft) {
//         try {
//           let orderId = draftOrderId;
//           if (orderId.includes("DraftOrder")) {
//             orderId = orderId.replace("DraftOrder", "Order");
//           }
//           const res = await fetch(shopUrl, {
//             method: "POST",
//             headers: gqlHeaders,
//             body: JSON.stringify({
//               query: `query GetOrder($id: ID!) {
//                 order(id: $id) {
//                   id name createdAt currencyCode
//                   customer { firstName lastName email }
//                   lineItems(first: 50) {
//                     nodes { title variantTitle sku quantity
//                       originalUnitPrice
//                       discountedTotal
//                     }
//                   }
//                   subtotalPrice
//                   totalDiscounts
//                   totalTax
//                   totalPrice
//                 }
//               }`,
//               variables: { id: orderId },
//             }),
//           });
//           const data = await res.json();
//           draft = data.data?.order;
//         } catch { /* continue */ }
//       }

//       if (!draft && label && label.startsWith("#")) {
//         try {
//           const res = await fetch(shopUrl, {
//             method: "POST",
//             headers: gqlHeaders,
//             body: JSON.stringify({
//               query: `query SearchOrder($query: String!) {
//                 orders(first: 1, query: $query) {
//                   nodes {
//                     id name createdAt currencyCode
//                     customer { firstName lastName email }
//                     lineItems(first: 50) {
//                       nodes { title variantTitle sku quantity
//                         originalUnitPrice
//                         discountedTotal
//                       }
//                     }
//                     subtotalPrice
//                     totalDiscounts
//                     totalTax
//                     totalPrice
//                   }
//                 }
//               }`,
//               variables: { query: `name:${label}` },
//             }),
//           });
//           const data = await res.json();
//           draft = data.data?.orders?.nodes?.[0] || null;
//         } catch { /* continue */ }
//       }

//       // Fallback: search by quote number in order note
//       if (!draft && quote.quoteNumber) {
//         try {
//           const res = await fetch(shopUrl, {
//             method: "POST",
//             headers: gqlHeaders,
//             body: JSON.stringify({
//               query: `query SearchOrderByNote($query: String!) {
//                 orders(first: 1, query: $query) {
//                   nodes {
//                     id name createdAt currencyCode
//                     customer { firstName lastName email }
//                     lineItems(first: 50) {
//                       nodes { title variantTitle sku quantity
//                         originalUnitPrice
//                         discountedTotal
//                       }
//                     }
//                     subtotalPrice
//                     totalDiscounts
//                     totalTax
//                     totalPrice
//                   }
//                 }
//               }`,
//               variables: { query: `note:${quote.quoteNumber}` },
//             }),
//           });
//           const data = await res.json();
//           draft = data.data?.orders?.nodes?.[0] || null;
//         } catch { /* continue */ }
//       }

//       if (!draft) {
//         return Response.json(
//           { error: `Could not load invoice for "${label}". Please check the order on Shopify admin.` },
//           { status: 400 },
//         );
//       }

//       // Build invoice data from quote (preserves original prices + discounts)
//       return Response.json({
//         success: true,
//         invoiceData: {
//           name: label,
//           createdAt: quote.createdAt.toISOString(),
//           currencyCode: quote.currencyCode,
//           customer: {
//             firstName: quote.customerFirstName,
//             lastName: quote.customerLastName,
//             email: quote.customerEmail,
//           },
//           lineItems: quote.items.map((item: any) => ({
//             title: item.productTitle,
//             variantTitle: item.variantTitle,
//             sku: item.sku,
//             quantity: item.quantity,
//             originalUnitPrice: Number(item.unitPrice).toFixed(2),
//             discount: Number(item.discount || 0).toFixed(2),
//             discountedTotal: (Number(item.unitPrice) * item.quantity - Number(item.discount || 0)).toFixed(2),
//           })),
//           subtotal: quote.subtotal.toString(),
//           totalDiscounts: quote.discountTotal.toString(),
//           totalTax: quote.taxAmount.toString(),
//           totalShipping: quote.shippingAmount.toString(),
//           totalPrice: quote.totalAmount.toString(),
//           invoiceSentAt: null,
//         },
//       });
//     }

//     if (intent === "duplicate_quote") {
//       const duplicate = await prisma.quote.create({
//         data: {
//           quoteNumber: `${quote.quoteNumber}-COPY-${Date.now().toString().slice(-4)}`,
//           shopId: quote.shopId,
//           companyId: quote.companyId,
//           salesAgentId: user.id,
//           title: `${quote.title} Copy`,
//           status: "draft",
//           secureToken: nodeCrypto.randomBytes(24).toString("hex"),
//           customerUserId: quote.customerUserId,
//           customerShopifyId: quote.customerShopifyId,
//           customerEmail: quote.customerEmail,
//           customerFirstName: quote.customerFirstName,
//           customerLastName: quote.customerLastName,
//           currencyCode: quote.currencyCode,
//           subtotal: quote.subtotal,
//           discountAmount: quote.discountAmount,
//           discountType: quote.discountType,
//           discountTotal: quote.discountTotal,
//           shippingAmount: quote.shippingAmount,
//           taxRate: quote.taxRate,
//           taxAmount: quote.taxAmount,
//           totalAmount: quote.totalAmount,
//           customerNotes: quote.customerNotes,
//           internalNotes: quote.internalNotes,
//           expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
//           items: {
//             create: quote.items.map((item) => ({
//               productId: item.productId,
//               productTitle: item.productTitle,
//               variantId: item.variantId,
//               variantTitle: item.variantTitle,
//               sku: item.sku,
//               image: item.image,
//               quantity: item.quantity,
//               unitPrice: item.unitPrice,
//               discount: item.discount,
//               totalPrice: item.totalPrice,
//               currencyCode: item.currencyCode,
//             })),
//           },
//         },
//       });
//       await logQuoteActivity({
//         quoteId: duplicate.id,
//         userId: user.id,
//         companyId: resolvedCompanyId,
//         customerEmail: duplicate.customerEmail,
//         action: "Quote Created",
//         message: `Duplicated from ${quote.quoteNumber}.`,
//       });
//       return redirect(
//         `/sales/portal/company/${resolvedCompanyId}/quotes/${duplicate.id}?duplicatedFrom=${encodeURIComponent(quote.quoteNumber)}`,
//       );
//     }

//     if (intent === "convert_quote") {
//       const result = await convertQuoteToOrder({
//         quoteId: quote.id,
//         salesAgentId: user.id,
//       });
//       return Response.json({
//         success: true,
//         message: `Quote converted to order ${result.shopifyOrder.name || result.shopifyOrder.id}.`,
//       });
//     }
//   } catch (error) {
//     return Response.json(
//       { error: error instanceof Error ? error.message : "Quote action failed" },
//       { status: 400 },
//     );
//   }

//   return Response.json({ error: "Unknown action" }, { status: 400 });
// };

// function AddProductModal({
//   form,
//   setForm,
//   onCancel,
//   onConfirm,
// }: {
//   form: any;
//   setForm: (updater: (f: any) => any) => void;
//   onCancel: () => void;
//   onConfirm: () => void;
// }) {
//   const update = (field: string, value: any) =>
//     setForm((f: any) => ({ ...f, [field]: value }));

//   return (
//     <div
//       style={{
//         position: "fixed",
//         inset: 0,
//         zIndex: 10500,
//         display: "flex",
//         alignItems: "center",
//         justifyContent: "center",
//         background: "rgba(0,0,0,0.5)",
//       }}
//       onClick={onCancel}
//     >
//       <div
//         style={{
//           width: "min(560px, calc(100vw - 32px))",
//           maxHeight: "88vh",
//           overflowY: "auto",
//           background: "#fff",
//           borderRadius: 12,
//           padding: 0,
//         }}
//         onClick={(e) => e.stopPropagation()}
//       >
//         <div
//           style={{
//             display: "flex",
//             justifyContent: "space-between",
//             alignItems: "center",
//             padding: "16px 20px",
//             borderBottom: "1px solid #e3e7ec",
//           }}
//         >
//           <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Add Product</h3>
//           <button
//             type="button"
//             onClick={onCancel}
//             style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "#5c5f62", lineHeight: 1 }}
//           >
//             &times;
//           </button>
//         </div>

//         <div style={{ padding: 20 }}>
//           {/* Preview card matching storefront style */}
//           <div style={styles.productCard}>
//             <div style={{ ...styles.productThumb, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
//               {form.image ? (
//                 <img src={form.image} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
//               ) : (
//                 <span style={{ color: "#9ca3af", fontSize: 10 }}>No image</span>
//               )}
//             </div>
//             <div style={{ flex: 1, minWidth: 0 }}>
//               <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>
//                 {form.productTitle || "New product name"}
//               </div>
//               <span style={styles.productTag}>SKU: {form.sku || "N/A"}</span>
//             </div>
//             <div style={{ textAlign: "right" }}>
//               <div style={styles.productPriceLabel}>Customer price</div>
//               <div style={styles.productPriceValue}>
//                 US${Number(form.unitPrice || 0).toFixed(2)}
//               </div>
//             </div>
//           </div>

//           {/* Editable fields */}
//           <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 16 }}>
//             <label style={{ ...styles.label, gridColumn: "1 / -1" }}>
//               Product Name
//               <input
//                 value={form.productTitle}
//                 onChange={(e) => update("productTitle", e.target.value)}
//                 style={styles.input}
//                 placeholder="Product name"
//               />
//             </label>
//             <label style={styles.label}>
//               SKU
//               <input
//                 value={form.sku}
//                 onChange={(e) => update("sku", e.target.value)}
//                 style={styles.input}
//                 placeholder="SKU"
//               />
//             </label>
//             <label style={styles.label}>
//               Variant
//               <input
//                 value={form.variantTitle}
//                 onChange={(e) => update("variantTitle", e.target.value)}
//                 style={styles.input}
//                 placeholder="Default variant"
//               />
//             </label>
//             <label style={styles.label}>
//               Variant ID
//               <input
//                 value={form.variantId}
//                 onChange={(e) => update("variantId", e.target.value)}
//                 style={styles.input}
//                 placeholder="Variant ID"
//               />
//             </label>
//             <label style={{ ...styles.label, gridColumn: "1 / -1" }}>
//               Image URL
//               <input
//                 value={form.image}
//                 onChange={(e) => update("image", e.target.value)}
//                 style={styles.input}
//                 placeholder="https://..."
//               />
//             </label>
//             <label style={styles.label}>
//               Unit Price
//               <input
//                 type="number"
//                 min="0"
//                 step="0.01"
//                 value={form.unitPrice}
//                 onChange={(e) => update("unitPrice", e.target.value)}
//                 style={styles.input}
//               />
//             </label>
//             <label style={styles.label}>
//               Discount
//               <input
//                 type="number"
//                 min="0"
//                 step="0.01"
//                 value={form.discount}
//                 onChange={(e) => update("discount", e.target.value)}
//                 style={styles.input}
//               />
//             </label>
//             <label style={styles.label}>
//               Quantity
//               <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
//                 <button
//                   type="button"
//                   onClick={() => update("quantity", Math.max(1, Number(form.quantity) - 1))}
//                   style={styles.stepperBtn}
//                 >
//                   −
//                 </button>
//                 <input
//                   type="number"
//                   min="1"
//                   value={form.quantity}
//                   onChange={(e) => update("quantity", Math.max(1, Number(e.target.value) || 1))}
//                   style={styles.stepperInput}
//                 />
//                 <button
//                   type="button"
//                   onClick={() => update("quantity", Number(form.quantity) + 1)}
//                   style={styles.stepperBtn}
//                 >
//                   +
//                 </button>
//               </div>
//             </label>
//           </div>
//         </div>

//         <div
//           style={{
//             display: "flex",
//             justifyContent: "flex-end",
//             gap: 10,
//             padding: "14px 20px",
//             borderTop: "1px solid #e3e7ec",
//           }}
//         >
//           <button type="button" onClick={onCancel} style={styles.secondaryBtn}>
//             Cancel
//           </button>
//           <button
//             type="button"
//             onClick={onConfirm}
//             disabled={!form.productTitle.trim()}
//             style={{
//               ...styles.productActionBtn,
//               opacity: !form.productTitle.trim() ? 0.5 : 1,
//               cursor: !form.productTitle.trim() ? "not-allowed" : "pointer",
//             }}
//           >
//             Add to Quote
//           </button>
//         </div>
//       </div>
//     </div>
//   );
// }



// export default function QuoteDetailPage() {
//   const {
//     quote,
//     quoteUrl,
//     created,
//     duplicatedFrom,
//     passedQuoteUrl,
//     user,
//     allCompanies,
//     quoteCount,
//     orderCount,
//     deliveryDetails,
//   } = useLoaderData<any>();
//   const actionData = useActionData<ActionResponse>();
//   const navigation = useNavigation();
//   const isSubmitting = navigation.state !== "idle";
//   const pendingIntent = String(navigation.formData?.get("intent") || "");
//   const submissionLock = useRef(false);
//   const shareUrl = passedQuoteUrl || quoteUrl;
//   const initialSuccessMessage = created
//     ? `Quote created successfully. Secure link: ${shareUrl}`
//     : duplicatedFrom
//       ? `${quote.quoteNumber} was duplicated successfully from ${duplicatedFrom}.`
//       : "";
//   const [notification, setNotification] = useState<{
//     type: "success" | "error";
//     message: string;
//   } | null>(initialSuccessMessage ? { type: "success", message: initialSuccessMessage } : null);
//   const [showInvoiceModal, setShowInvoiceModal] = useState(false);
//   const [showAllActivities, setShowAllActivities] = useState(false);
//   const [invoiceData, setInvoiceData] = useState<any>(null);
//   const [newProductRows, setNewProductRows] = useState<NewProductRow[]>([]);
//   const [showAddProductModal, setShowAddProductModal] = useState(false);
//   const [addProductForm, setAddProductForm] = useState({
//     productTitle: "",
//     sku: "",
//     variantTitle: "Default variant",
//     variantId: "",
//     image: "",
//     unitPrice: "0",
//     discount: "0",
//     quantity: 1,
//   });

//   const openAddProductModal = () => {
//     setAddProductForm({
//       productTitle: "",
//       sku: "",
//       variantTitle: "Default variant",
//       variantId: "",
//       image: "",
//       unitPrice: "0",
//       discount: "0",
//       quantity: 1,
//     });
//     setShowAddProductModal(true);
//   };

//   const confirmAddProduct = () => {
//     if (!addProductForm.productTitle.trim()) return;
//     const rowKey = String(Date.now());
//     setNewProductRows((rows) => [...rows, { ...addProductForm, rowKey }]);
//     setShowAddProductModal(false);
//   };

//   const removePendingProduct = (rowKey: string) => {
//     setNewProductRows((rows) => rows.filter((r) => r.rowKey !== rowKey));
//   };

//   useEffect(() => {
//     if (navigation.state === "idle") submissionLock.current = false;
//   }, [navigation.state]);

//   useEffect(() => {
//     if (actionData?.invoiceData) {
//       setInvoiceData(actionData.invoiceData);
//       setShowInvoiceModal(true);
//     } else if (actionData?.error) {
//       setNotification({ type: "error", message: actionData.error });
//     } else if (actionData?.success) {
//       setNotification({
//         type: "success",
//         message: actionData.message || "Quote updated successfully.",
//       });
//     }
//   }, [actionData]);

//   useEffect(() => {
//     if (initialSuccessMessage) {
//       setNotification({ type: "success", message: initialSuccessMessage });
//     }
//   }, [initialSuccessMessage]);

//   const guardSubmission = (event: React.FormEvent<HTMLFormElement>) => {
//     if (submissionLock.current || isSubmitting) {
//       event.preventDefault();
//       return false;
//     }
//     submissionLock.current = true;
//     setNotification(null);
//     return true;
//   };

//   const addRowWithLoader = async () => {
//     setNewProductRows((rows) => [...rows, { ...addProductForm, rowKey: String(rows.length) }]);
//   };

//   const fmtMoney = (amount: string, currency = quote.currencyCode) =>
//     new Intl.NumberFormat(undefined, {
//       style: "currency",
//       currency,
//       minimumFractionDigits: 2,
//     }).format(Number(amount) || 0);
//   const fmtDate = (iso: string) =>
//     new Intl.DateTimeFormat("en-IN", {
//       day: "2-digit",
//       month: "short",
//       year: "numeric",
//       hour: "2-digit",
//       minute: "2-digit",
//     }).format(new Date(iso));
//   const dateInput = quote.expiresAt.slice(0, 10);
//   const sendIntent = quote.status === "draft" ? "send_quote" : "resend_quote";
//   const savedCustomerDetails = {
//     firstName: quote.invoiceData?.quoteEditMeta?.customerDetails?.firstName || quote.customerFirstName || "",
//     lastName: quote.invoiceData?.quoteEditMeta?.customerDetails?.lastName || quote.customerLastName || "",
//     email: quote.invoiceData?.quoteEditMeta?.customerDetails?.email || quote.customerEmail || "",
//   };
//   const savedDeliveryDetails = {
//     locationName: quote.invoiceData?.quoteEditMeta?.deliveryDetails?.locationName || "",
//     address: quote.invoiceData?.quoteEditMeta?.deliveryDetails?.address || "",
//     phone: quote.invoiceData?.quoteEditMeta?.deliveryDetails?.phone || "",
//   };

// return (
//     <SalesPortalLayout
//       company={{
//         id: quote.companyId,
//         name: quote.company.name,
//         storeName: quote.company.shop.shopName || quote.company.shop.shopDomain,
//       }}
//       user={user}
//       activePage="quotes"
//       orderCount={orderCount}
//       quoteCount={quoteCount}
//     >
//       <SalesPortalHeader
//         title={quote.quoteNumber}
//         subtitle={quote.title}
//         companyId={quote.companyId}
//         companies={allCompanies}
//         startAction={
//           <Link
//             to={`/sales/portal/company/${quote.companyId}/quotes`}
//             aria-disabled={isSubmitting}
//             style={{
//               display: "inline-flex",
//               alignItems: "center",
//               gap: 8,
//               minHeight: 36,
//               padding: "6px 10px",
//               borderRadius: 8,
//               border: "1px solid #dfe3ea",
//               background: "#fff",
//               color: "#2c6ecb",
//               textDecoration: "none",
//               fontWeight: 600,
//               fontSize: 13,
//               opacity: isSubmitting ? 0.55 : 1,
//               pointerEvents: isSubmitting ? "none" : "auto",
//             }}
//           >
//             Back to Quotes
//           </Link>
//         }
//         actions={
//           <>
//             <Form method="post" onSubmit={guardSubmission}>
//               <input type="hidden" name="intent" value={sendIntent} />
//               <button
//                 disabled={isSubmitting}
//                 aria-busy={pendingIntent === sendIntent}
//                 style={disabledButtonStyle(styles.primaryBtn, isSubmitting)}
//               >
//                 {pendingIntent === sendIntent && <Spinner />}
//                 {pendingIntent === sendIntent
//                   ? quote.status === "draft" ? "Sending Quote..." : "Resending Quote..."
//                   : quote.status === "draft" ? "Send Quote" : "Resend Quote"}
//               </button>
//             </Form>
//             {quote.shopifyDraftOrderId && (
//               <Form method="post" onSubmit={guardSubmission}>
//                 <input type="hidden" name="intent" value="preview_invoice" />
//                 <button
//                   disabled={isSubmitting}
//                   aria-busy={pendingIntent === "preview_invoice"}
//                   style={disabledButtonStyle(styles.secondaryBtn, isSubmitting)}
//                 >
//                   {pendingIntent === "preview_invoice" && <Spinner dark />}
//                   {pendingIntent === "preview_invoice" ? "Loading..." : "Preview Invoice"}
//                 </button>
//               </Form>
//             )}
//             {quote.status === "approved" && (
//               <Form method="post" onSubmit={guardSubmission}>
//                 <input type="hidden" name="intent" value="convert_quote" />
//                 <button
//                   disabled={isSubmitting}
//                   aria-busy={pendingIntent === "convert_quote"}
//                   style={disabledButtonStyle(styles.primaryBtn, isSubmitting)}
//                 >
//                   {pendingIntent === "convert_quote" && <Spinner />}
//                   {pendingIntent === "convert_quote" ? "Converting..." : "Convert To Order"}
//                 </button>
//               </Form>
//             )}
//             {["draft", "sent", "viewed"].includes(quote.status) && (
//               <Form
//                 method="post"
//                 onSubmit={(event) => {
//                   if (!confirm("Cancel this quote?")) {
//                     event.preventDefault();
//                     return;
//                   }
//                   guardSubmission(event);
//                 }}
//               >
//                 <input type="hidden" name="intent" value="cancel_quote" />
//                 <button
//                   disabled={isSubmitting}
//                   aria-busy={pendingIntent === "cancel_quote"}
//                   style={disabledButtonStyle(styles.secondaryBtn, isSubmitting)}
//                 >
//                   {pendingIntent === "cancel_quote" && <Spinner dark />}
//                   {pendingIntent === "cancel_quote" ? "Cancelling..." : "Cancel"}
//                 </button>
//               </Form>
//             )}
//           </>
//         }
//       />

//       {notification && (
//         <div
//           role={notification.type === "error" ? "alert" : "status"}
//           aria-live={notification.type === "error" ? "assertive" : "polite"}
//           style={{
//             ...styles.toast,
//             ...(notification.type === "error" ? styles.error : styles.success),
//           }}
//         >
//           <div style={{ paddingRight: 28 }}>
//             <strong>{notification.type === "error" ? "Action failed" : "Success"}</strong>
//             <p style={{ margin: "4px 0 0" }}>{notification.message}</p>
//           </div>
//           <button
//             type="button"
//             aria-label="Dismiss notification"
//             onClick={() => setNotification(null)}
//             style={styles.toastCloseButton}
//           >
//             x
//           </button>
//         </div>
//       )}

//       {quote.status === "draft" ? (
//         <Form method="post" id="quote-edit-form" onSubmit={guardSubmission}>
//           <input type="hidden" name="intent" value="update_quote" />
//           <div className="sales-quote-detail-grid" style={styles.grid}>
//             <section style={styles.mainCol}>
//               {/* Customer Information */}
//               <div className="sales-quote-card" style={styles.card}>
//                 <div style={styles.cardHeader}>
//                   <h2 style={styles.cardTitle}>Customer Information</h2>
//                   <span style={styles.badge}>{quote.status}</span>
//                 </div>
//                 <div className="sales-quote-info-grid" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 16 }}>
//                   <label style={styles.label}>
//                     Company
//                     <input style={styles.input} value={quote.company.name} disabled />
//                   </label>
//                   <label style={styles.label}>
//                     Quote Title
//                     <input name="title" defaultValue={quote.title} style={styles.input} disabled={isSubmitting} />
//                   </label>
//                   <label style={styles.label}>
//                     First Name
//                     <input name="customerFirstName" defaultValue={savedCustomerDetails.firstName} style={styles.input} disabled={isSubmitting} />
//                   </label>
//                   <label style={styles.label}>
//                     Last Name
//                     <input name="customerLastName" defaultValue={savedCustomerDetails.lastName} style={styles.input} disabled={isSubmitting} />
//                   </label>
//                   <label style={styles.label}>
//                     Email
//                     <input name="customerEmail" type="email" defaultValue={savedCustomerDetails.email} style={styles.input} disabled={isSubmitting} />
//                   </label>
//                   <label style={styles.label}>
//                     Expiration
//                     <input type="date" name="expiresAt" defaultValue={dateInput} style={styles.input} disabled={isSubmitting} />
//                   </label>
//                 </div>
//               </div>

//               {/* Delivery Details */}
//               <div className="sales-quote-card" style={styles.card}>
//                 <h2 style={styles.cardTitle}>Delivery Details</h2>
//                 <div className="sales-quote-delivery-grid" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 16 }}>
//                   <label style={styles.label}>
//                     Location
//                     <input
//                       name="deliveryLocationName"
//                       placeholder="e.g. Warehouse / Store name"
//                       defaultValue={
//                         savedDeliveryDetails.locationName ||
//                         deliveryDetails.locationName ||
//                         ""
//                       }
//                       style={styles.input}
//                       disabled={isSubmitting}
//                     />
//                   </label>
//                   <label style={styles.label}>
//                     Delivery Phone
//                     <input
//                       name="deliveryPhone"
//                       defaultValue={savedDeliveryDetails.phone || deliveryDetails.phone || ""}
//                       style={styles.input}
//                       disabled={isSubmitting}
//                     />
//                   </label>
//                   <label style={{ ...styles.label, gridColumn: "1 / -1" }}>
//                     Delivery Address
//                     <textarea
//                       name="deliveryAddress"
//                       defaultValue={
//                         savedDeliveryDetails.address ||
//                         (deliveryDetails.addressLines || []).join("\n")
//                       }
//                       style={{ ...styles.textarea, minHeight: 72 }}
//                       disabled={isSubmitting}
//                     />
//                   </label>
//                 </div>
//                 <p style={{ ...styles.muted, marginTop: 10 }}>
//                   {deliveryDetails.locationName || savedDeliveryDetails.locationName
//                     ? "Editing existing location. Changing this and saving will update it."
//                     : "No location set yet — enter one here and save to add it."}
//                 </p>
//               </div>

//               {/* Notes */}
//               <div className="sales-quote-card" style={styles.card}>
//                 <h2 style={styles.cardTitle}>Notes</h2>
//                 <label style={styles.label}>
//                   Customer Notes
//                   <textarea
//                     name="customerNotes"
//                     defaultValue={quote.customerNotes || ""}
//                     style={styles.textarea}
//                     disabled={isSubmitting}
//                   />
//                 </label>
//                 <label style={styles.label}>
//                   Internal Notes
//                   <textarea
//                     name="internalNotes"
//                     defaultValue={quote.internalNotes || ""}
//                     style={styles.textarea}
//                     disabled={isSubmitting}
//                   />
//                 </label>
//               </div>

//               {/* Product Information */}
//               <div className="sales-quote-card" style={styles.card}>
//                 <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
//                   <h2 style={{ ...styles.cardTitle, margin: 0 }}>Product Information</h2>
//                   <button
//                     type="button"
//                     disabled={isSubmitting}
//                     onClick={openAddProductModal}
//                     style={{ ...styles.secondaryBtn, padding: "8px 12px", fontSize: 13 }}
//                   >
//                     + Add Product
//                   </button>
//                 </div>

//                 <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
//                   {/* Existing items */}
//                   {quote.items.map((item: any) => (
//                     <div key={item.id} style={styles.productCard}>
//                       <img
//                         src={item.image || ""}
//                         alt=""
//                         style={styles.productThumb}
//                         onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }}
//                       />
//                       <div style={{ flex: 1, minWidth: 0 }}>
//                         <input
//                           name={`productTitle_${item.id}`}
//                           defaultValue={item.productTitle}
//                           style={{ ...styles.input, fontWeight: 700, border: "none", padding: 0, height: "auto", fontSize: 15, marginBottom: 6 }}
//                           disabled={isSubmitting}
//                         />
//                         <div>
//                           <span style={styles.productTag}>SKU: {item.sku || "N/A"}</span>
//                         </div>

//                         <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 10 }}>
//                           <label style={{ ...styles.label, marginBottom: 0 }}>
//                             Variant
//                             <input
//                               name={`variantTitle_${item.id}`}
//                               defaultValue={item.variantTitle || "Default variant"}
//                               style={styles.input}
//                               disabled={isSubmitting}
//                             />
//                           </label>
//                           <label style={{ ...styles.label, marginBottom: 0 }}>
//                             Unit Price
//                             <input
//                               type="number"
//                               min="0"
//                               step="0.01"
//                               name={`unitPrice_${item.id}`}
//                               defaultValue={Number(item.unitPrice) || 0}
//                               style={styles.input}
//                               disabled={isSubmitting}
//                             />
//                           </label>
//                           <label style={{ ...styles.label, marginBottom: 0 }}>
//                             Discount
//                             <input
//                               type="number"
//                               min="0"
//                               step="0.01"
//                               name={`discount_${item.id}`}
//                               defaultValue={Number(item.discount) || 0}
//                               style={styles.input}
//                               disabled={isSubmitting}
//                             />
//                           </label>
//                         </div>
//                         <label style={{ ...styles.label, marginTop: 8, marginBottom: 0 }}>
//                           Image URL
//                           <input
//                             name={`image_${item.id}`}
//                             defaultValue={item.image || ""}
//                             style={{ ...styles.input, fontSize: 12 }}
//                             disabled={isSubmitting}
//                           />
//                         </label>
//                       </div>

//                       <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10, flexShrink: 0 }}>
//                         <div>
//                           <div style={styles.productPriceLabel}>Line total</div>
//                           <div style={styles.productPriceValue}>
//                             {fmtMoney(item.totalPrice, item.currencyCode)}
//                           </div>
//                         </div>
//                         <QuantityStepper name={`quantity_${item.id}`} defaultValue={item.quantity} disabled={isSubmitting} />
//                         <button
//                           type="submit"
//                           name="intent"
//                           value="delete_item"
//                           formNoValidate
//                           onClick={(e) => {
//                             if (!confirm("Remove this item from the quote?")) e.preventDefault();
//                           }}
//                           disabled={isSubmitting}
//                           style={{ ...styles.productActionBtn, background: "#fff", color: "#b91b1b", border: "1px solid #fecaca" }}
//                         >
//                           Remove
//                         </button>
//                         <input type="hidden" name="itemId" value={item.id} />
//                       </div>
//                     </div>
//                   ))}

//                   {/* Newly added (pending save) product cards - image style */}
//                   {newProductRows.map((row) => (
//                     <div key={row.rowKey} style={{ ...styles.productCard, background: "#f9fafb" }}>
//                       <input type="hidden" name="newProductRow" value={row.rowKey} />
//                       <input type="hidden" name={`newProductTitle_${row.rowKey}`} value={row.productTitle} />
//                       <input type="hidden" name={`newSku_${row.rowKey}`} value={row.sku} />
//                       <input type="hidden" name={`newVariantTitle_${row.rowKey}`} value={row.variantTitle} />
//                       <input type="hidden" name={`newVariantId_${row.rowKey}`} value={row.variantId} />
//                       <input type="hidden" name={`newImage_${row.rowKey}`} value={row.image} />
//                       <input type="hidden" name={`newUnitPrice_${row.rowKey}`} value={row.unitPrice} />
//                       <input type="hidden" name={`newDiscount_${row.rowKey}`} value={row.discount} />
//                       <input type="hidden" name={`newQuantity_${row.rowKey}`} value={row.quantity} />

//                       <div style={{ ...styles.productThumb, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
//                         {row.image ? (
//                           <img src={row.image} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
//                         ) : (
//                           <span style={{ color: "#9ca3af", fontSize: 10 }}>No image</span>
//                         )}
//                       </div>

//                       <div style={{ flex: 1, minWidth: 0 }}>
//                         <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{row.productTitle}</div>
//                         <span style={styles.productTag}>SKU: {row.sku || "N/A"}</span>
//                         <span style={styles.productTag}>{row.variantTitle || "Default variant"}</span>
//                         <span style={{ ...styles.productTag, background: "#ede9fe", color: "#6d28d9" }}>Pending Save</span>
//                       </div>

//                       <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10, flexShrink: 0 }}>
//                         <div>
//                           <div style={styles.productPriceLabel}>Customer price</div>
//                           <div style={styles.productPriceValue}>
//                             US${Number(row.unitPrice || 0).toFixed(2)}
//                           </div>
//                         </div>
//                         <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
//                           <span style={{ fontSize: 12, color: "#6b7280" }}>Qty</span>
//                           <span style={{ fontWeight: 700 }}>{row.quantity}</span>
//                         </div>
//                         <button
//                           type="button"
//                           onClick={() => removePendingProduct(row.rowKey)}
//                           disabled={isSubmitting}
//                           style={{ ...styles.productActionBtn, background: "#fff", color: "#b91b1b", border: "1px solid #fecaca" }}
//                         >
//                           Remove
//                         </button>
//                       </div>
//                     </div>
//                   ))}
//                 </div>
//               </div>

//               {/* Activity History */}
//               <div className="sales-quote-card" style={styles.card}>
//                 <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
//                   <h2 style={styles.cardTitle}>Activity History</h2>
//                   {quote.activities.length > 0 && (
//                     <button
//                       type="button"
//                       onClick={() => setShowAllActivities((v) => !v)}
//                       style={{
//                         background: "none",
//                         border: "none",
//                         cursor: "pointer",
//                         padding: "2px 6px",
//                         fontSize: 16,
//                         color: "#2c6ecb",
//                         lineHeight: 1,
//                       }}
//                       title={showAllActivities ? "Collapse" : "Expand"}
//                     >
//                       {showAllActivities ? "\u25B2" : "\u25BC"}
//                     </button>
//                   )}
//                 </div>
//                 {showAllActivities && (
//                   quote.activities.length ? (
//                     <div className="hide-scrollbar" style={{ maxHeight: 440, overflowY: "auto", paddingRight: 4 }}>
//                       <div style={styles.timeline}>
//                         {quote.activities.map((activity: any) => (
//                           <div key={activity.id} style={styles.activity}>
//                             <strong>{activity.action}</strong>
//                             <span>{fmtDate(activity.createdAt)}</span>
//                             {activity.message && <p>{activity.message}</p>}
//                           </div>
//                         ))}
//                       </div>
//                     </div>
//                   ) : (
//                     <p style={styles.muted}>No activity yet.</p>
//                   )
//                 )}
//               </div>
//             </section>

//             <aside className="sales-quote-side-column" style={styles.sideCol}>
//               <div className="sales-quote-card" style={styles.card}>
//                 <h2 style={styles.cardTitle}>Quote Sharing</h2>
//                 <div style={styles.copyRow}>
//                   <input
//                     readOnly
//                     value={shareUrl}
//                     aria-label="Secure quote link"
//                     style={styles.input}
//                     onFocus={(e) => e.currentTarget.select()}
//                   />
//                   <button
//                     type="button"
//                     disabled={isSubmitting}
//                     style={disabledButtonStyle(styles.copyBtn, isSubmitting)}
//                     onClick={() => navigator.clipboard.writeText(shareUrl)}
//                   >
//                     Copy
//                   </button>
//                 </div>
//                 <p style={styles.muted}>Copy this secure quote link for the customer.</p>
//               </div>

//               <div className="sales-quote-card" style={styles.card}>
//                 <h2 style={styles.cardTitle}>Pricing Summary</h2>
//                 <Summary label="Subtotal" value={fmtMoney(quote.subtotal)} />
//                 <Summary label="Discount" value={`-${fmtMoney(quote.discountTotal)}`} />
//                 <Summary label={`Tax (${quote.taxRate}%)`} value={fmtMoney(quote.taxAmount)} />
//                 <Summary label="Shipping" value={fmtMoney(quote.shippingAmount)} />
//                 <div style={styles.totalRow}>
//                   <strong>Grand Total</strong>
//                   <strong>{fmtMoney(quote.totalAmount)}</strong>
//                 </div>
//                 <p style={{ ...styles.muted, marginTop: 10 }}>
//                   Recalculates automatically from line items after saving.
//                 </p>
//               </div>

//               <div className="sales-quote-card" style={styles.card}>
//                 <h2 style={styles.cardTitle}>Draft Actions</h2>
//                 <button
//                   type="submit"
//                   form="quote-edit-form"
//                   disabled={isSubmitting}
//                   aria-busy={pendingIntent === "update_quote"}
//                   style={{ ...disabledButtonStyle(styles.primaryBtn, isSubmitting), width: "100%" }}
//                 >
//                   {pendingIntent === "update_quote" && <Spinner />}
//                   {pendingIntent === "update_quote" ? "Saving Changes..." : "Save Changes"}
//                 </button>
//               </div>
//             </aside>
//           </div>
//         </Form>
//       ) : (
//         <div className="sales-quote-detail-grid" style={styles.grid}>
//           <section style={styles.mainCol}>
//             <div className="sales-quote-card" style={styles.card}>
//               <div style={styles.cardHeader}>
//                 <h2 style={styles.cardTitle}>Customer Information</h2>
//                 <span style={styles.badge}>{quote.status}</span>
//               </div>
//               <div className="sales-quote-info-grid" style={styles.infoGrid}>
//                 <Info label="Company" value={quote.company.name} />
//                 <Info
//                   label="Customer"
//                   value={
//                     `${quote.customerFirstName || ""} ${quote.customerLastName || ""}`.trim() ||
//                     quote.customerEmail
//                   }
//                 />
//                 <Info label="Email" value={quote.customerEmail} />
//                 <Info
//                   label="Sales Agent"
//                   value={quote.salesAgent?.firstName || quote.salesAgent?.email || "Sales Agent"}
//                 />
//                 <Info label="Created" value={fmtDate(quote.createdAt)} />
//                 <Info label="Expires" value={fmtDate(quote.expiresAt)} />
//               </div>
//             </div>

//             <DeliveryDetailsCard deliveryDetails={deliveryDetails} quote={quote} />

//             <div className="sales-quote-card" style={{ ...styles.card, padding: 0, overflow: "hidden" }}>
//               <div style={styles.cardHeading}>
//                 <h2 style={{ ...styles.cardTitle, margin: 0 }}>Product Summary</h2>
//               </div>
//               <div className="sales-quote-table-wrap">
//                 <table style={styles.table}>
//                   <thead>
//                     <tr>
//                       <th style={styles.th}>Product</th>
//                       <th style={styles.th}>Variant</th>
//                       <th style={styles.th}>Qty</th>
//                       <th style={styles.th}>Unit</th>
//                       <th style={styles.th}>Actions</th>
//                       <th style={{ ...styles.th, textAlign: "right" }}>Total</th>
//                     </tr>
//                   </thead>
//                   <tbody>
//                     {quote.items.map((item: any) => (
//                       <tr key={item.id}>
//                         <td style={styles.td}>
//                           {item.productTitle}
//                           <br />
//                           <small>{item.sku || "No SKU"}</small>
//                         </td>
//                         <td style={styles.td}>{item.variantTitle || "Default"}</td>
//                         <td style={styles.td}>{item.quantity}</td>
//                         <td style={styles.td}>{fmtMoney(item.unitPrice, item.currencyCode)}</td>
//                         <td style={styles.td}>
//                           {editableStatuses.includes(quote.status) && (
//                             <Form
//                               method="post"
//                               onSubmit={(e) => {
//                                 if (!confirm("Remove this item from the quote?")) e.preventDefault();
//                               }}
//                             >
//                               <input type="hidden" name="intent" value="delete_item" />
//                               <input type="hidden" name="itemId" value={item.id} />
//                               <button
//                                 type="submit"
//                                 disabled={isSubmitting}
//                                 style={{ ...styles.secondaryBtn, padding: "6px 10px", fontSize: 13 }}
//                               >
//                                 Remove
//                               </button>
//                             </Form>
//                           )}
//                         </td>
//                         <td style={{ ...styles.td, textAlign: "right" }}>
//                           {fmtMoney(item.totalPrice, item.currencyCode)}
//                         </td>
//                       </tr>
//                     ))}
//                   </tbody>
//                 </table>
//               </div>
//             </div>

//             <div className="sales-quote-card" style={styles.card}>
//               <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
//                 <h2 style={styles.cardTitle}>Activity History</h2>
//                 {quote.activities.length > 0 && (
//                   <button
//                     type="button"
//                     onClick={() => setShowAllActivities((v) => !v)}
//                     style={{
//                       background: "none",
//                       border: "none",
//                       cursor: "pointer",
//                       padding: "2px 6px",
//                       fontSize: 16,
//                       color: "#2c6ecb",
//                       lineHeight: 1,
//                     }}
//                     title={showAllActivities ? "Collapse" : "Expand"}
//                   >
//                     {showAllActivities ? "\u25B2" : "\u25BC"}
//                   </button>
//                 )}
//               </div>
//               {showAllActivities && (
//                 quote.activities.length ? (
//                   <div className="hide-scrollbar" style={{ maxHeight: 440, overflowY: "auto", paddingRight: 4 }}>
//                     <div style={styles.timeline}>
//                       {quote.activities.map((activity: any) => (
//                         <div key={activity.id} style={styles.activity}>
//                           <strong>{activity.action}</strong>
//                           <span>{fmtDate(activity.createdAt)}</span>
//                           {activity.message && <p>{activity.message}</p>}
//                         </div>
//                       ))}
//                     </div>
//                   </div>
//                 ) : (
//                   <p style={styles.muted}>No activity yet.</p>
//                 )
//               )}
//             </div>
//           </section>

//           <aside className="sales-quote-side-column" style={styles.sideCol}>
//             <div className="sales-quote-card" style={styles.card}>
//               <h2 style={styles.cardTitle}>Quote Sharing</h2>
//               <div style={styles.copyRow}>
//                 <input
//                   readOnly
//                   value={shareUrl}
//                   aria-label="Secure quote link"
//                   style={styles.input}
//                   onFocus={(e) => e.currentTarget.select()}
//                 />
//                 <button
//                   type="button"
//                   disabled={isSubmitting}
//                   style={disabledButtonStyle(styles.copyBtn, isSubmitting)}
//                   onClick={() => navigator.clipboard.writeText(shareUrl)}
//                 >
//                   Copy
//                 </button>
//               </div>
//               <p style={styles.muted}>Copy this secure quote link for the customer.</p>
//             </div>

//             <div className="sales-quote-card" style={styles.card}>
//               <h2 style={styles.cardTitle}>Grand Total</h2>
//               <Summary label="Subtotal" value={fmtMoney(quote.subtotal)} />
//               <Summary label="Discount" value={`-${fmtMoney(quote.discountTotal)}`} />
//               <Summary label={`Tax (${quote.taxRate}%)`} value={fmtMoney(quote.taxAmount)} />
//               <Summary label="Shipping" value={fmtMoney(quote.shippingAmount)} />
//               <div style={styles.totalRow}>
//                 <strong>Total</strong>
//                 <strong>{fmtMoney(quote.totalAmount)}</strong>
//               </div>
//             </div>
//           </aside>
//         </div>
//       )}

//       <style>{`
//         @keyframes quote-action-spin { to { transform: rotate(360deg); } }
//         .sales-quote-table-wrap { overflow-x: auto; }
//         @media (max-width: 1080px) {
//           .sales-quote-detail-grid { grid-template-columns: minmax(0, 1fr) !important; }
//           .sales-quote-side-column { position: static !important; }
//         }
//         @media (max-width: 700px) {
//           .sales-quote-card { padding: 16px !important; }
//           .sales-quote-info-grid, .sales-quote-delivery-grid { grid-template-columns: minmax(0, 1fr) !important; }
//         }
//       `}</style>

//       {/* Add Product Modal */}
//       {showAddProductModal && (
//         <AddProductModal
//           form={addProductForm}
//           setForm={setAddProductForm}
//           onCancel={() => setShowAddProductModal(false)}
//           onConfirm={confirmAddProduct}
//         />
//       )}

//       {/* Invoice Preview Modal */}
//       {showInvoiceModal && invoiceData && (
//         <div
//           style={{
//             position: "fixed",
//             inset: 0,
//             zIndex: 9999,
//             display: "flex",
//             alignItems: "center",
//             justifyContent: "center",
//             background: "rgba(0,0,0,0.5)",
//           }}
//           onClick={() => { setShowInvoiceModal(false); setInvoiceData(null); }}
//         >
//           <div
//             style={{
//               position: "relative",
//               width: "90vw",
//               maxWidth: 800,
//               maxHeight: "90vh",
//               background: "#fff",
//               borderRadius: 12,
//               overflow: "hidden",
//               display: "flex",
//               flexDirection: "column",
//             }}
//             onClick={(e) => e.stopPropagation()}
//           >
//             <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: "1px solid #e3e7ec" }}>
//               <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Invoice Preview — {quote.quoteNumber}</h3>
//               <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
//                 <button
//                   type="button"
//                   onClick={() => window.print()}
//                   style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid transparent", fontWeight: 600, fontSize: 12, cursor: "pointer", background: "#005bd3", color: "#fff" }}
//                 >
//                   Print / Save PDF
//                 </button>
//                 <button
//                   type="button"
//                   onClick={() => { setShowInvoiceModal(false); setInvoiceData(null); }}
//                   style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "#5c5f62", padding: "0 4px", lineHeight: 1 }}
//                 >
//                   &times;
//                 </button>
//               </div>
//             </div>
//             <div style={{ padding: "24px 32px", overflowY: "auto", flex: 1 }}>
//               <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 24 }}>
//                 <div>
//                   <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>INVOICE</h2>
//                   <p style={{ margin: "4px 0 0", color: "#5c5f62", fontSize: 13 }}>{quote.quoteNumber}</p>
//                 </div>
//                 <div style={{ textAlign: "right", fontSize: 13, color: "#5c5f62" }}>
//                   <p style={{ margin: 0 }}><strong>Date:</strong> {invoiceData.createdAt ? new Date(invoiceData.createdAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "–"}</p>
//                   {invoiceData.invoiceSentAt && (
//                     <p style={{ margin: "2px 0 0" }}><strong>Sent:</strong> {new Date(invoiceData.invoiceSentAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</p>
//                   )}
//                 </div>
//               </div>

//               {invoiceData.customer && (
//                 <div style={{ marginBottom: 24, fontSize: 13 }}>
//                   <strong>Bill To:</strong>
//                   <p style={{ margin: "4px 0 0" }}>
//                     {[invoiceData.customer.firstName, invoiceData.customer.lastName].filter(Boolean).join(" ")}
//                   </p>
//                   {invoiceData.customer.email && <p style={{ margin: "2px 0 0", color: "#5c5f62" }}>{invoiceData.customer.email}</p>}
//                 </div>
//               )}

//               <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginBottom: 24 }}>
//                 <thead>
//                   <tr>
//                     <th style={{ textAlign: "left", padding: "8px 10px", background: "#f4f6f8", borderBottom: "1px solid #e3e7ec", fontWeight: 600, color: "#5c5f62" }}>Product</th>
//                     <th style={{ textAlign: "left", padding: "8px 10px", background: "#f4f6f8", borderBottom: "1px solid #e3e7ec", fontWeight: 600, color: "#5c5f62" }}>SKU</th>
//                     <th style={{ textAlign: "center", padding: "8px 10px", background: "#f4f6f8", borderBottom: "1px solid #e3e7ec", fontWeight: 600, color: "#5c5f62" }}>Qty</th>
//                     <th style={{ textAlign: "right", padding: "8px 10px", background: "#f4f6f8", borderBottom: "1px solid #e3e7ec", fontWeight: 600, color: "#5c5f62" }}>Unit Price</th>
//                     <th style={{ textAlign: "right", padding: "8px 10px", background: "#f4f6f8", borderBottom: "1px solid #e3e7ec", fontWeight: 600, color: "#5c5f62" }}>Total</th>
//                   </tr>
//                 </thead>
//                 <tbody>
//                   {(invoiceData.lineItems || []).map((item: any, idx: number) => (
//                     <tr key={idx}>
//                       <td style={{ padding: "8px 10px", borderBottom: "1px solid #f0f0f0" }}>
//                         {item.title}
//                         {item.variantTitle && <span style={{ color: "#5c5f62" }}> — {item.variantTitle}</span>}
//                       </td>
//                       <td style={{ padding: "8px 10px", borderBottom: "1px solid #f0f0f0", color: "#5c5f62" }}>{item.sku || "–"}</td>
//                       <td style={{ padding: "8px 10px", borderBottom: "1px solid #f0f0f0", textAlign: "center" }}>{item.quantity}</td>
//                       <td style={{ padding: "8px 10px", borderBottom: "1px solid #f0f0f0", textAlign: "right" }}>
//                         {fmtMoney(item.originalUnitPrice, invoiceData.currencyCode)}
//                       </td>
//                       <td style={{ padding: "8px 10px", borderBottom: "1px solid #f0f0f0", textAlign: "right", fontWeight: 600 }}>
//                         {fmtMoney(item.discountedTotal, invoiceData.currencyCode)}
//                       </td>
//                     </tr>
//                   ))}
//                 </tbody>
//               </table>

//               <div style={{ display: "flex", justifyContent: "flex-end" }}>
//                 <div style={{ width: 280, fontSize: 13 }}>
//                   <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}><span>Subtotal</span><span>{fmtMoney(invoiceData.subtotal, invoiceData.currencyCode)}</span></div>
//                   {Number(invoiceData.totalDiscounts) > 0 && (
//                     <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}><span>Discount</span><span style={{ color: "#b91b1b" }}>-{fmtMoney(invoiceData.totalDiscounts, invoiceData.currencyCode)}</span></div>
//                   )}
//                   {Number(invoiceData.totalShipping) > 0 && (
//                     <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}><span>Shipping</span><span>{fmtMoney(invoiceData.totalShipping, invoiceData.currencyCode)}</span></div>
//                   )}
//                   {Number(invoiceData.totalTax) > 0 && (
//                     <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}><span>Tax</span><span>{fmtMoney(invoiceData.totalTax, invoiceData.currencyCode)}</span></div>
//                   )}
//                   <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, fontSize: 15, borderTop: "2px solid #e3e7ec", marginTop: 8, paddingTop: 8 }}>
//                     <span>Total</span>
//                     <span>{fmtMoney(invoiceData.totalPrice, invoiceData.currencyCode)}</span>
//                   </div>
//                 </div>
//               </div>
//             </div>
//           </div>
//         </div>
//       )}
//     </SalesPortalLayout>
//   );
// }

// function Info({ label, value }: { label: string; value: string }) {
//   return (
//     <div>
//       <span style={styles.metaLabel}>{label}</span>
//       <strong>{value}</strong>
//     </div>
//   );
// }

// function Summary({ label, value }: { label: string; value: string }) {
//   return (
//     <div style={styles.summaryRow}>
//       <span>{label}</span>
//       <strong>{value}</strong>
//     </div>
//   );
// }

// function QuantityStepper({
//   name,
//   defaultValue,
//   disabled,
// }: {
//   name: string;
//   defaultValue: number;
//   disabled?: boolean;
// }) {
//   return (
//     <input
//       type="number"
//       name={name}
//       min={1}
//       defaultValue={defaultValue}
//       disabled={disabled}
//       style={{
//         width: 80,
//         padding: "8px 10px",
//         borderRadius: 8,
//         border: "1px solid #d1d5db",
//         textAlign: "center",
//       }}
//     />
//   );
// }

// function DeliveryDetailsCard({
//   deliveryDetails,
//   quote,
// }: {
//   deliveryDetails: DeliveryDetails;
//   quote?: any;
// }) {
//   const manualDelivery = quote?.invoiceData?.quoteEditMeta?.deliveryDetails || {};
//   const locationName = manualDelivery.locationName || deliveryDetails.locationName || "Not captured";
//   const addressLines = manualDelivery.address
//     ? manualDelivery.address
//         .split(/\n+/)
//         .map((line: string) => line.trim())
//         .filter(Boolean)
//     : deliveryDetails.addressLines;
//   const phone = manualDelivery.phone || deliveryDetails.phone;

//   return (
//     <div className="sales-quote-card" style={styles.card}>
//       <h2 style={styles.cardTitle}>Delivery Details</h2>
//       <div className="sales-quote-delivery-grid" style={styles.deliveryGrid}>
//         <Info label="Location" value={locationName} />
//         <div>
//           <span style={styles.metaLabel}>
//             {deliveryDetails.source === "company_location"
//               ? "Location Address"
//               : "Delivery Address"}
//           </span>
//           {addressLines.length > 0 ? (
//             <address style={styles.addressText}>
//               {addressLines.map((line: string) => (
//                 <span key={line}>{line}</span>
//               ))}
//             </address>
//           ) : (
//             <p style={styles.muted}>
//               Delivery address was not captured for this quote.
//             </p>
//           )}
//         </div>
//         {phone && <Info label="Phone" value={phone} />}
//       </div>
//     </div>
//   );
// }

// function Spinner({ dark = false }: { dark?: boolean }) {
//   return (
//     <span
//       aria-hidden="true"
//       style={{
//         ...styles.buttonSpinner,
//         borderColor: dark ? "#d1d5db" : "rgba(255, 255, 255, 0.45)",
//         borderTopColor: dark ? "#374151" : "#ffffff",
//       }}
//     />
//   );
// }

// function disabledButtonStyle(
//   style: React.CSSProperties,
//   disabled: boolean,
// ): React.CSSProperties {
//   return {
//     ...style,
//     display: "inline-flex",
//     alignItems: "center",
//     justifyContent: "center",
//     gap: 8,
//     opacity: disabled ? 0.6 : 1,
//     cursor: disabled ? "not-allowed" : "pointer",
//   };
// }

// const styles: Record<string, React.CSSProperties> = {
//   backLink: {
//     color: "#2c6ecb",
//     textDecoration: "none",
//     fontWeight: 600,
//     fontSize: 13,
//   },
//   grid: {
//     display: "grid",
//     gridTemplateColumns: "minmax(0, 1fr) 360px",
//     gap: 24,
//     alignItems: "start",
//   },
//   mainCol: { display: "flex", flexDirection: "column", gap: 20 },
//   sideCol: {
//     display: "flex",
//     flexDirection: "column",
//     gap: 20,
//     position: "sticky",
//     top: 20,
//   },
//   card: {
//     background: "#fff",
//     border: "1px solid #e1e3e5",
//     borderRadius: 8,
//     padding: 20,
//   },
//   cardHeading: { padding: "18px 20px", borderBottom: "1px solid #e1e3e5" },
//   cardHeader: {
//     display: "flex",
//     justifyContent: "space-between",
//     alignItems: "center",
//     gap: 12,
//   },
//   cardTitle: { margin: "0 0 16px", fontSize: 18, color: "#111827" },
//   infoGrid: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 },
//   deliveryGrid: {
//     display: "grid",
//     gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
//     gap: 16,
//   },
//   addressText: {
//     display: "flex",
//     flexDirection: "column",
//     gap: 3,
//     margin: 0,
//     color: "#111827",
//     fontSize: 13,
//     fontStyle: "normal",
//     lineHeight: 1.45,
//   },
//   metaLabel: {
//     display: "block",
//     color: "#6b7280",
//     fontSize: 12,
//     marginBottom: 4,
//   },
//   badge: {
//     background: "#fff0f4",
//     color: "#b71950",
//     borderRadius: 8,
//     padding: "5px 10px",
//     fontSize: 12,
//     fontWeight: 700,
//     textTransform: "capitalize",
//   },
//   table: { width: "100%", minWidth: 620, borderCollapse: "collapse" },
//   th: {
//     textAlign: "left",
//     padding: "10px 8px",
//     borderBottom: "1px solid #e5e7eb",
//     color: "#6b7280",
//     fontSize: 12,
//   },
//   td: { padding: "12px 8px", borderBottom: "1px solid #f3f4f6", fontSize: 13 },
//   input: {
//     width: "100%",
//     boxSizing: "border-box",
//     height: 40,
//     border: "1px solid #c9cccf",
//     borderRadius: 8,
//     padding: "0 10px",
//     font: "inherit",
//     fontSize: 13,
//   },
//   textarea: {
//     width: "100%",
//     boxSizing: "border-box",
//     minHeight: 78,
//     border: "1px solid #c9cccf",
//     borderRadius: 8,
//     padding: 10,
//     font: "inherit",
//     resize: "vertical",
//   },
//   label: {
//     display: "flex",
//     flexDirection: "column",
//     gap: 6,
//     fontSize: 13,
//     color: "#374151",
//     fontWeight: 700,
//     marginBottom: 12,
//   },
//   muted: { color: "#6b7280", fontSize: 13 },
//   primaryBtn: {
//     background: "#111827",
//     color: "#fff",
//     border: "none",
//     borderRadius: 8,
//     padding: "10px 14px",
//     fontWeight: 600,
//     cursor: "pointer",
//   },
//   secondaryBtn: {
//     background: "#fff",
//     color: "#374151",
//     border: "1px solid #c9cccf",
//     borderRadius: 8,
//     padding: "10px 14px",
//     fontWeight: 600,
//     cursor: "pointer",
//   },
//   copyRow: { display: "flex", gap: 8 },
//   copyBtn: {
//     border: "1px solid #c9cccf",
//     borderRadius: 8,
//     background: "#fff",
//     color: "#2c6ecb",
//     padding: "0 13px",
//     fontWeight: 600,
//     cursor: "pointer",
//   },
//   summaryRow: {
//     display: "flex",
//     justifyContent: "space-between",
//     padding: "8px 0",
//     color: "#4b5563",
//   },
//   totalRow: {
//     display: "flex",
//     justifyContent: "space-between",
//     borderTop: "1px solid #e5e7eb",
//     paddingTop: 14,
//     marginTop: 8,
//     fontSize: 18,
//   },
//   timeline: { display: "flex", flexDirection: "column", gap: 12 },
//   activity: {
//     borderLeft: "3px solid #e91e63",
//     paddingLeft: 12,
//     color: "#202223",
//   },
//   success: {
//     background: "#ecfdf5",
//     color: "#065f46",
//     border: "1px solid #a7f3d0",
//   },
//   error: {
//     background: "#fef2f2",
//     color: "#991b1b",
//     border: "1px solid #fecaca",
//   },
//   toast: {
//     position: "fixed",
//     top: 20,
//     right: 20,
//     zIndex: 11000,
//     width: "min(400px, calc(100vw - 32px))",
//     boxSizing: "border-box",
//     borderRadius: 10,
//     padding: 14,
//     boxShadow: "0 12px 30px rgba(17, 24, 39, 0.16)",
//     fontSize: 13,
//   },
//   toastCloseButton: {
//     position: "absolute",
//     top: 8,
//     right: 10,
//     border: "none",
//     background: "transparent",
//     color: "inherit",
//     cursor: "pointer",
//     fontSize: 18,
//     lineHeight: 1,
//   },
//   buttonSpinner: {
//     width: 15,
//     height: 15,
//     border: "2px solid",
//     borderRadius: "50%",
//     animation: "quote-action-spin 0.8s linear infinite",
//     flexShrink: 0,
//   },
// };

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
import {
  getDeliveryDetailsForRecord,
  type DeliveryDetails,
} from "app/services/delivery-details.server";
import { getCompanyLocations } from "app/utils/b2b-customer.server";

async function resolveQuoteCompanyId(quoteId: string) {
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    select: { companyId: true },
  });

  return quote?.companyId || null;
}

type ActionResponse = {
  success?: boolean;
  message?: string;
  error?: string;
  invoiceData?: any;
};

type AddProductForm = {
  productId: string;
  productTitle: string;
  sku: string;
  variantTitle: string;
  variantId: string;
  image: string;
  unitPrice: string;
  discount: string;
  quantity: number;
};

type NewProductRow = AddProductForm & { rowKey: string };

const quoteStatuses = [
  "draft",
  "sent",
  "viewed",
  "approved",
  "rejected",
  "expired",
  "converted",
  "cancelled",
];

const editableStatuses = ["draft", "sent", "viewed", "approved"];

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { user } = await requireSalesSession(request);
  const companyId = params.companyId;
  const quoteId = params.quoteId;
  if (!quoteId) {
    return redirect("/sales/portal");
  }

  const resolvedCompanyId = companyId || (await resolveQuoteCompanyId(quoteId));
  if (!resolvedCompanyId || !hasCompanyAccess(user, resolvedCompanyId)) {
    return redirect("/sales/portal");
  }

  const quote = await prisma.quote.findFirst({
    where: { id: quoteId, companyId: resolvedCompanyId },
    include: {
      company: {
        include: {
          shop: {
            select: {
              shopName: true,
              shopDomain: true,
            },
          },
        },
      },
      salesAgent: { select: { firstName: true, lastName: true, email: true } },
      items: { orderBy: { createdAt: "asc" } },
      activities: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!quote) {
    return redirect(
      resolvedCompanyId
        ? `/sales/portal/company/${resolvedCompanyId}/quotes`
        : "/sales/portal",
    );
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
  const shopCredentials = await prisma.store.findUnique({
    where: { id: quote.shopId },
    select: { shopDomain: true, accessToken: true },
  });
  const deliveryDetails = await getDeliveryDetailsForRecord({
    ...quote,
    company: {
      ...quote.company,
      shop: {
        ...quote.company.shop,
        shopDomain: shopCredentials?.shopDomain || quote.company.shop.shopDomain,
        accessToken: shopCredentials?.accessToken || null,
      },
    },
  });

  let companyLocations: any[] = [];
  if (
    quote.company?.shopifyCompanyId &&
    shopCredentials?.shopDomain &&
    shopCredentials?.accessToken
  ) {
    const companyLocationsResult = await getCompanyLocations(
      quote.company.shopifyCompanyId,
      shopCredentials.shopDomain,
      shopCredentials.accessToken,
    );
    if (!companyLocationsResult.error) {
      companyLocations = companyLocationsResult.locations || [];
    }
  }

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
    quoteCount: await prisma.quote.count({ where: { companyId: resolvedCompanyId } }),
    orderCount: await prisma.b2BOrder.count({
      where: {
        companyId: resolvedCompanyId,
        orderStatus: { notIn: ["converted", "archived"] },
      },
    }),
    quoteUrl: getQuoteUrl(request, quote),
    created: url.searchParams.get("created") === "1",
    duplicatedFrom: url.searchParams.get("duplicatedFrom") || "",
    passedQuoteUrl: url.searchParams.get("quoteUrl") || "",
    deliveryDetails,
    companyLocations,
  });
};

async function recalculateQuoteTotals(quoteId: string) {
  const items = await prisma.quoteItem.findMany({ where: { quoteId } });
  const subtotal = items.reduce((total, item) => {
    const lineTotal = Number(item.unitPrice) * item.quantity;
    const lineDiscount = Number(item.discount) || 0;
    return total + Math.max(0, lineTotal - lineDiscount);
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
  const { user } = await requireSalesSession(request);
  const companyId = params.companyId;
  const quoteId = params.quoteId;
  if (!quoteId) {
    return Response.json({ error: "Quote not found" }, { status: 404 });
  }

  const resolvedCompanyId = companyId || (await resolveQuoteCompanyId(quoteId));
  if (!resolvedCompanyId || !hasCompanyAccess(user, resolvedCompanyId)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  const formData = await request.formData();
  const intentValues = formData.getAll("intent").map(String).filter(Boolean);
  const intent = intentValues.length ? intentValues[intentValues.length - 1] : "";
  if (intent === "logout") {
    return redirect("/sales/login", {
      headers: { "Set-Cookie": buildClearSessionCookie() },
    });
  }
  const quote = await prisma.quote.findFirst({
    where: { id: quoteId, companyId: resolvedCompanyId },
    include: { items: true },
  });
  if (!quote) {
    return Response.json({ error: "Quote not found" }, { status: 404 });
  }

  // handle server-backed delete of a persisted quote item
  if (intent === "delete_item") {
    const itemId = String(formData.get("itemId") || "");
    if (!itemId) return Response.json({ error: "Item id missing" }, { status: 400 });
    const item = await prisma.quoteItem.findUnique({ where: { id: itemId }, select: { id: true, quoteId: true, productTitle: true } });
    if (!item || item.quoteId !== quote.id) return Response.json({ error: "Item not found" }, { status: 404 });
    await prisma.quoteItem.delete({ where: { id: itemId } });
    await recalculateQuoteTotals(quote.id);
    await logQuoteActivity({ quoteId: quote.id, userId: user.id, companyId: resolvedCompanyId, customerEmail: quote.customerEmail, action: "Quote Item Removed", message: `Removed item ${item.productTitle || item.id}` });
    return Response.json({ success: true, message: "Item removed." });
  }

  try {
    if (intent === "update_quote") {
      if (!editableStatuses.includes(quote.status)) {
        return Response.json(
          { error: "This quote status cannot be edited." },
          { status: 400 },
        );
      }

      const title = String(formData.get("title") || "").trim();
      const customerFirstName = String(formData.get("customerFirstName") || "").trim();
      const customerLastName = String(formData.get("customerLastName") || "").trim();
      const customerEmail = String(formData.get("customerEmail") || "").trim();
      const deliveryLocationName = String(formData.get("deliveryLocationName") || "").trim();
      const deliveryAddress = String(formData.get("deliveryAddress") || "").trim();
      const deliveryPhone = String(formData.get("deliveryPhone") || "").trim();
      const customerNotes = String(formData.get("customerNotes") || "");
      const internalNotes = String(formData.get("internalNotes") || "");
      const expires = String(formData.get("expiresAt") || "");
      const requestedStatus = String(formData.get("status") || quote.status).trim();
      const normalizedStatus = quoteStatuses.includes(requestedStatus)
        ? requestedStatus
        : quote.status;
      const discountType = String(formData.get("discountType") || quote.discountType || "FIXED_AMOUNT");
      const discountAmount = Number(formData.get("discountAmount") ?? quote.discountAmount ?? 0);
      const taxRate = Number(formData.get("taxRate") ?? quote.taxRate ?? 0);
      const shippingAmount = Number(formData.get("shippingAmount") ?? quote.shippingAmount ?? 0);
      const normalizedCustomerEmail = customerEmail || quote.customerEmail;
      if (!normalizedCustomerEmail) {
        throw new Error("Customer email is required.");
      }
      if (!["FIXED_AMOUNT", "PERCENTAGE"].includes(discountType)) {
        throw new Error("Invalid discount type.");
      }
      if (!Number.isFinite(discountAmount) || discountAmount < 0) {
        throw new Error("Invalid discount value.");
      }
      if (!Number.isFinite(taxRate) || taxRate < 0) {
        throw new Error("Invalid tax rate.");
      }
      if (!Number.isFinite(shippingAmount) || shippingAmount < 0) {
        throw new Error("Invalid shipping amount.");
      }

      const itemUpdates = quote.items
        .map((item) => {
          const quantityValue = Number(formData.get(`quantity_${item.id}`));
          const unitPriceValue = Number(formData.get(`unitPrice_${item.id}`));
          const discountValue = Number(formData.get(`discount_${item.id}`));
          const productTitleValue = String(formData.get(`productTitle_${item.id}`) ?? item.productTitle).trim();
          const skuValue = String(formData.get(`sku_${item.id}`) ?? item.sku ?? "").trim();
          const variantTitleValue = String(formData.get(`variantTitle_${item.id}`) ?? item.variantTitle ?? "").trim();
          const imageValue = String(formData.get(`image_${item.id}`) ?? item.image ?? "").trim();

          if (!Number.isFinite(quantityValue) || quantityValue < 1) {
            throw new Error(`Invalid quantity for ${item.productTitle}`);
          }
          if (!Number.isFinite(unitPriceValue) || unitPriceValue < 0) {
            throw new Error(`Invalid unit price for ${item.productTitle}`);
          }
          if (!Number.isFinite(discountValue) || discountValue < 0) {
            throw new Error(`Invalid discount for ${item.productTitle}`);
          }

          const totalPrice = Math.max(0, unitPriceValue * quantityValue - discountValue);
          return {
            id: item.id,
            quantity: Math.round(quantityValue),
            unitPrice: unitPriceValue,
            discount: discountValue,
            totalPrice,
            productTitle: productTitleValue || item.productTitle,
            sku: skuValue,
            variantTitle: variantTitleValue,
            image: imageValue || null,
          };
        })
        .filter(Boolean);

      const newRowKeys = formData.getAll("newProductRow").map(String).filter(Boolean);
      const newItems = newRowKeys
        .map((rowKey) => {
          const productId = String(formData.get(`newProductId_${rowKey}`) || "").trim();
          const productTitle = String(formData.get(`newProductTitle_${rowKey}`) || "").trim();
          const variantTitle = String(formData.get(`newVariantTitle_${rowKey}`) || "").trim();
          const sku = String(formData.get(`newSku_${rowKey}`) || "").trim();
          const variantId = String(formData.get(`newVariantId_${rowKey}`) || "").trim();
          const image = String(formData.get(`newImage_${rowKey}`) || "").trim();
          const quantity = Number(formData.get(`newQuantity_${rowKey}`));
          const unitPrice = Number(formData.get(`newUnitPrice_${rowKey}`));
          const discount = Number(formData.get(`newDiscount_${rowKey}`));

          const isAnyValueFilled = Boolean(productTitle || variantTitle || sku || image || quantity || unitPrice || discount);
          if (!isAnyValueFilled) return null;

          const validQuantity = Number.isFinite(quantity) && quantity > 0 ? Math.round(quantity) : 1;
          const validUnitPrice = Number.isFinite(unitPrice) && unitPrice >= 0 ? unitPrice : 0;
          const validDiscount = Number.isFinite(discount) && discount >= 0 ? discount : 0;

          return {
            productId: productId || null,
            productTitle: productTitle || "Product",
            variantTitle,
            sku,
            image: image || null,
            variantId: variantId || "",
            quantity: validQuantity,
            unitPrice: validUnitPrice,
            discount: validDiscount,
            totalPrice: Math.max(0, validUnitPrice * validQuantity - validDiscount),
          };
        })
        .filter(Boolean) as Array<{
          productId: string | null;
          productTitle: string;
          variantTitle: string;
          sku: string;
          image: string | null;
          variantId: string;
          quantity: number;
          unitPrice: number;
          discount: number;
          totalPrice: number;
        }>;

      if (!itemUpdates.length && !newItems.length) {
        return Response.json({ error: "No quote changes were submitted." }, { status: 400 });
      }

      const quoteCurrency = quote.currencyCode || quote.items?.[0]?.currencyCode || "USD";
      const existingInvoiceData =
        quote.invoiceData && typeof quote.invoiceData === "object"
          ? (quote.invoiceData as Record<string, any>)
          : {};
      const nextInvoiceData = {
        ...existingInvoiceData,
        quoteEditMeta: {
          ...(existingInvoiceData.quoteEditMeta && typeof existingInvoiceData.quoteEditMeta === "object"
            ? existingInvoiceData.quoteEditMeta
            : {}),
          customerDetails: {
            firstName: customerFirstName || quote.customerFirstName || null,
            lastName: customerLastName || quote.customerLastName || null,
            email: normalizedCustomerEmail,
          },
          deliveryDetails: {
            locationName: deliveryLocationName || null,
            address: deliveryAddress || null,
            phone: deliveryPhone || null,
          },
        },
      };

      await prisma.$transaction(async (tx) => {
        for (const item of itemUpdates) {
          await tx.quoteItem.update({
            where: { id: item.id },
            data: {
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              discount: item.discount,
              totalPrice: item.totalPrice,
              productTitle: item.productTitle,
              sku: item.sku,
              variantTitle: item.variantTitle,
              image: item.image,
            },
          });
        }

        for (const newItem of newItems) {
          await tx.quoteItem.create({
            data: {
              quoteId: quote.id,
              productId: newItem.productId,
              productTitle: newItem.productTitle,
              variantTitle: newItem.variantTitle,
              sku: newItem.sku,
              image: newItem.image,
              quantity: newItem.quantity,
              unitPrice: newItem.unitPrice,
              discount: newItem.discount,
              totalPrice: newItem.totalPrice,
              currencyCode: quoteCurrency,
              variantId: newItem.variantId,
            },
          });
        }

        const statusUpdateData: Record<string, unknown> = {};
        if (normalizedStatus !== quote.status) {
          statusUpdateData.status = normalizedStatus;
          if (normalizedStatus === "sent") {
            statusUpdateData.sentAt = quote.sentAt || new Date();
          } else if (normalizedStatus === "viewed") {
            statusUpdateData.viewedAt = quote.viewedAt || new Date();
          } else if (normalizedStatus === "approved") {
            statusUpdateData.approvedAt = quote.approvedAt || new Date();
            statusUpdateData.rejectedAt = null;
          } else if (normalizedStatus === "rejected") {
            statusUpdateData.rejectedAt = quote.rejectedAt || new Date();
            statusUpdateData.approvedAt = null;
          } else if (normalizedStatus === "cancelled") {
            statusUpdateData.cancelledAt = quote.cancelledAt || new Date();
          } else if (normalizedStatus === "converted") {
            statusUpdateData.convertedAt = quote.convertedAt || new Date();
          }
        }

        await tx.quote.update({
          where: { id: quote.id },
          data: {
            title: title || quote.title,
            customerFirstName: customerFirstName || quote.customerFirstName || null,
            customerLastName: customerLastName || quote.customerLastName || null,
            customerEmail: normalizedCustomerEmail,
            customerNotes,
            internalNotes,
            discountType,
            discountAmount,
            taxRate,
            shippingAmount,
            expiresAt: expires
              ? new Date(`${expires}T23:59:59.999`)
              : quote.expiresAt,
            invoiceData: nextInvoiceData,
            ...statusUpdateData,
          },
        });
      });

      if (normalizedStatus === "sent" && quote.status !== "sent") {
        await sendQuoteToCustomer({ quoteId: quote.id, request, userId: user.id });
      }

      await recalculateQuoteTotals(quote.id);

      await logQuoteActivity({
        quoteId: quote.id,
        userId: user.id,
        companyId: resolvedCompanyId,
        customerEmail: normalizedCustomerEmail,
        action: "Quote Updated",
        message: "Quote customer details, delivery details, items, notes, and expiry were updated.",
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
        companyId: resolvedCompanyId,
        customerEmail: quote.customerEmail,
        action: "Quote Cancelled",
      });
      return Response.json({ success: true, message: "Quote cancelled." });
    }

    if (intent === "preview_invoice") {
      if (!quote.shopifyDraftOrderId) {
        return Response.json(
          { error: `No draft order linked to this quote (${quote.shopifyDraftOrderName || quote.quoteNumber}). Send the invoice first.` },
          { status: 400 },
        );
      }

      const label = quote.shopifyDraftOrderName || quote.quoteNumber;

      // Fallback: query Shopify (legacy quotes without stored data)
      const shop = await prisma.store.findFirst({
        where: { companyAccounts: { some: { id: companyId } } },
        select: { shopDomain: true, accessToken: true },
      });
      if (!shop?.accessToken) {
        return Response.json({ error: "Shop not found." }, { status: 400 });
      }

      const gqlHeaders = {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": shop.accessToken,
      };
      const shopUrl = `https://${shop.shopDomain}/admin/api/2025-01/graphql.json`;

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
      } catch { /* continue */ }

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
        } catch { /* continue */ }
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
        } catch { /* continue */ }
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
        } catch { /* continue */ }
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
        companyId: resolvedCompanyId,
        customerEmail: duplicate.customerEmail,
        action: "Quote Created",
        message: `Duplicated from ${quote.quoteNumber}.`,
      });
      return redirect(
        `/sales/portal/company/${resolvedCompanyId}/quotes/${duplicate.id}?duplicatedFrom=${encodeURIComponent(quote.quoteNumber)}`,
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

export function AddProductModal({
  form,
  setForm,
  onCancel,
  onConfirm,
  productQuery,
  setProductQuery,
  productResults,
  fetchProducts,
  isFetchingProducts,
  onSelectVariant,
}: {
  form: any;
  setForm: (updater: (f: any) => any) => void;
  onCancel: () => void;
  onConfirm: () => void;
  productQuery: string;
  setProductQuery: (value: string) => void;
  productResults: any[];
  fetchProducts: (query?: string) => Promise<void>;
  isFetchingProducts: boolean;
  onSelectVariant: (product: any, variant: any) => void;
}) {
  const update = (field: string, value: any) =>
    setForm((f: any) => ({ ...f, [field]: value }));

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10500,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.5)",
      }}
      onClick={onCancel}
    >
      <div
        style={{
          width: "min(900px, calc(100vw - 32px))",
          maxHeight: "88vh",
          overflowY: "auto",
          background: "#fff",
          borderRadius: 12,
          padding: 0,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "16px 20px",
            borderBottom: "1px solid #e3e7ec",
          }}
        >
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Add Product</h3>
          <button
            type="button"
            onClick={onCancel}
            style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "#5c5f62", lineHeight: 1 }}
          >
            &times;
          </button>
        </div>

        <div style={{ padding: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 16 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>All Products</h3>
              <p style={{ margin: "4px 0 0", color: "#6b7280", fontSize: 13 }}>
                Search Shopify products for this store and add a variant directly.
              </p>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input
                placeholder="Search products"
                value={productQuery}
                onChange={(e) => setProductQuery(e.target.value)}
                style={{ ...styles.input, width: 220 }}
              />
              <button
                type="button"
                onClick={() => fetchProducts(productQuery)}
                style={styles.secondaryBtn}
                disabled={isFetchingProducts}
              >
                {isFetchingProducts ? "Loading..." : "Search"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setProductQuery("all");
                  fetchProducts("all");
                }}
                style={styles.secondaryBtn}
                disabled={isFetchingProducts}
              >
                Show All
              </button>
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            {productResults.length === 0 ? (
              <p style={styles.muted}>
                {isFetchingProducts ? "Searching products..." : "No products found. Try a different search or click Show All."}
              </p>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {productResults.map((product: any) => (
                  <div
                    key={product.id}
                    style={{
                      border: "1px solid #e5e7eb",
                      borderRadius: 8,
                      padding: 12,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <div style={{ display: "flex", gap: 12, alignItems: "center", minWidth: 0 }}>
                      <div style={{ width: 64, height: 64, borderRadius: 12, overflow: "hidden", background: "#f3f4f6", flexShrink: 0 }}>
                        {product.image ? (
                          <img
                            src={product.image}
                            alt={product.title}
                            style={{ width: "100%", height: "100%", objectFit: "cover" }}
                          />
                        ) : (
                          <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#9ca3af", fontSize: 11 }}>
                            No image
                          </div>
                        )}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {product.title}
                        </div>
                        <div style={{ color: "#6b7280", fontSize: 12, marginTop: 4 }}>
                          {product.variants.length} variant{product.variants.length === 1 ? "" : "s"}
                        </div>
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                      {product.variants.slice(0, 3).map((variant: any) => (
                        <button
                          key={variant.id}
                          type="button"
                          onClick={() => onSelectVariant(product, variant)}
                          style={styles.secondaryBtn}
                          disabled={!variant.inStock}
                        >
                          {variant.inStock ? "Add" : "Out of stock"}
                          {variant.title ? `: ${variant.title}` : ""}
                        </button>
                      ))}
                      {product.variants.length > 3 && (
                        <span style={{ color: "#6b7280", fontSize: 12, alignSelf: "center" }}>
                          +{product.variants.length - 3} more
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Editable fields */}
          {/* <div className="sales-add-product-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label style={{ ...styles.label, gridColumn: "1 / -1" }}>
              Product Name
              <input
                value={form.productTitle}
                onChange={(e) => update("productTitle", e.target.value)}
                style={styles.input}
                placeholder="Product name"
              />
            </label>
            <label style={styles.label}>
              SKU
              <input
                value={form.sku}
                onChange={(e) => update("sku", e.target.value)}
                style={styles.input}
                placeholder="SKU"
              />
            </label>
            <label style={styles.label}>
              Variant
              <input
                value={form.variantTitle}
                onChange={(e) => update("variantTitle", e.target.value)}
                style={styles.input}
                placeholder="Default variant"
              />
            </label>
            <label style={{ ...styles.label, gridColumn: "1 / -1" }}>
              Image URL
              <input
                value={form.image}
                onChange={(e) => update("image", e.target.value)}
                style={styles.input}
                placeholder="https://..."
              />
            </label>
            <label style={styles.label}>
              Unit Price
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.unitPrice}
                onChange={(e) => update("unitPrice", e.target.value)}
                style={styles.input}
              />
            </label>
            <label style={styles.label}>
              Discount
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.discount}
                onChange={(e) => update("discount", e.target.value)}
                style={styles.input}
              />
            </label>
          </div> */}

          {/* Live preview card — matches the storefront product-picker look */}
          {/* <div style={{ ...styles.storefrontCard, marginTop: 18, flexWrap: "wrap" }}>
            <div style={{ ...styles.storefrontThumb, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
              {form.image ? (
                <img src={form.image} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                <span style={{ color: "#9ca3af", fontSize: 10 }}>No image</span>
              )}
            </div>

            <div style={{ flex: "1 1 180px", minWidth: 140 }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>
                {form.productTitle || "New product name"}
              </div>
              <div style={styles.pillRow}>
                <span style={styles.pill}>SKU: {form.sku || "N/A"}</span>
                <span style={styles.pill}>{form.variantTitle || "Default variant"}</span>
              </div>
            </div>

            <div style={{ textAlign: "right" }}>
              <div style={styles.storefrontPriceLabel}>Customer price</div>
              <div style={styles.storefrontPriceValue}>
                US${Number(form.unitPrice || 0).toFixed(2)}
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button
                type="button"
                onClick={() => update("quantity", Math.max(1, Number(form.quantity) - 1))}
                style={styles.stepperBtn}
              >
                −
              </button>
              <input
                type="number"
                min="1"
                value={form.quantity}
                onChange={(e) => update("quantity", Math.max(1, Number(e.target.value) || 1))}
                style={styles.stepperInput}
              />
              <button
                type="button"
                onClick={() => update("quantity", Number(form.quantity) + 1)}
                style={styles.stepperBtn}
              >
                +
              </button>
            </div>

            <button
              type="button"
              onClick={onConfirm}
              disabled={!form.productTitle.trim()}
              style={{
                ...styles.addToQuoteBtn,
                opacity: !form.productTitle.trim() ? 0.5 : 1,
                cursor: !form.productTitle.trim() ? "not-allowed" : "pointer",
              }}
            >
              Add
            </button>
          </div> */}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
            padding: "14px 20px",
            borderTop: "1px solid #e3e7ec",
          }}
        >
          <button type="button" onClick={onCancel} style={styles.secondaryBtn}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!form.productTitle.trim()}
            style={{
              ...styles.addToQuoteBtn,
              opacity: !form.productTitle.trim() ? 0.5 : 1,
              cursor: !form.productTitle.trim() ? "not-allowed" : "pointer",
            }}
          >
            Add to Quote
          </button>
        </div>
      </div>
    </div>
  );
}



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
    deliveryDetails,
    companyLocations,
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
  const notificationTimerRef = useRef<number | null>(null);
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);
  const [showAllActivities, setShowAllActivities] = useState(false);
  const [invoiceData, setInvoiceData] = useState<any>(null);
  const [newProductRows, setNewProductRows] = useState<NewProductRow[]>([]);
  const [showAddProductModal, setShowAddProductModal] = useState(false);
  const [productQuery, setProductQuery] = useState("all");
  const [productResults, setProductResults] = useState<any[]>([]);
  const [isFetchingProducts, setIsFetchingProducts] = useState(false);
  const [addProductForm, setAddProductForm] = useState({
    productId: "",
    productTitle: "",
    sku: "",
    variantTitle: "Default variant",
    variantId: "",
    image: "",
    unitPrice: "0",
    discount: "0",
    quantity: 1,
  });

  const openAddProductModal = () => {
    setAddProductForm({
      productId: "",
      productTitle: "",
      sku: "",
      variantTitle: "Default variant",
      variantId: "",
      image: "",
      unitPrice: "0",
      discount: "0",
      quantity: 1,
    });
    setShowAddProductModal(true);
  };

  const confirmAddProduct = () => {
    if (!addProductForm.productTitle.trim()) return;
    const rowKey = String(Date.now());
    setNewProductRows((rows) => [...rows, { ...addProductForm, rowKey }]);
    setShowAddProductModal(false);
  };

  const handleSelectProductVariant = (product: any, variant: any) => {
    const selected = {
      productId: product?.id || "",
      productTitle: product.title || "",
      sku: variant?.sku || "",
      variantTitle: variant?.title || "Default variant",
      variantId: variant?.id || "",
      image: product.image || "",
      unitPrice: variant?.price || "0",
      discount: "0",
      quantity: 1,
    };
    const rowKey = String(Date.now());
    setNewProductRows((rows) => [...rows, { ...selected, rowKey }]);
    setShowAddProductModal(false);
  };

  const removePendingProduct = (rowKey: string) => {
    setNewProductRows((rows) => rows.filter((r) => r.rowKey !== rowKey));
  };

  useEffect(() => {
    if (navigation.state === "idle") submissionLock.current = false;
  }, [navigation.state]);

  useEffect(() => {
    if (actionData?.invoiceData) {
      setInvoiceData(actionData.invoiceData);
      setShowInvoiceModal(true);
    } else if (actionData?.error) {
      setNotification({ type: "error", message: actionData.error });
    } else if (actionData?.success) {
      setNotification({
        type: "success",
        message: actionData.message || "Quote updated successfully.",
      });
      if (pendingIntent === "update_quote") {
        setNewProductRows([]);
      }
    }
  }, [actionData, pendingIntent]);

  useEffect(() => {
    if (initialSuccessMessage) {
      setNotification({ type: "success", message: initialSuccessMessage });
    }
  }, [initialSuccessMessage]);

  useEffect(() => {
    if (notification?.type === "success") {
      if (notificationTimerRef.current) {
        window.clearTimeout(notificationTimerRef.current);
      }
      notificationTimerRef.current = window.setTimeout(() => {
        setNotification(null);
        notificationTimerRef.current = null;
      }, 4000);
    }

    return () => {
      if (notificationTimerRef.current) {
        window.clearTimeout(notificationTimerRef.current);
        notificationTimerRef.current = null;
      }
    };
  }, [notification]);

  const guardSubmission = (event: React.FormEvent<HTMLFormElement>) => {
    if (submissionLock.current || isSubmitting) {
      event.preventDefault();
      return false;
    }
    submissionLock.current = true;
    setNotification(null);
    return true;
  };

  const addRowWithLoader = async () => {
    setNewProductRows((rows) => [...rows, { ...addProductForm, rowKey: String(rows.length) }]);
  };

  const fetchProducts = async (query = "all") => {
    setIsFetchingProducts(true);
    const normalizedQuery = String(query || "").trim() || "all";
    try {
      const url = `/api/sales-product-search?q=${encodeURIComponent(normalizedQuery)}&companyId=${encodeURIComponent(quote.companyId)}`;
      const res = await fetch(url);
      if (!res.ok) {
        setProductResults([]);
        return;
      }
      const data = await res.json();
      setProductResults(data.products || []);
    } catch (error) {
      console.error("Failed to load product search results", error);
      setProductResults([]);
    } finally {
      setIsFetchingProducts(false);
    }
  };

  useEffect(() => {
    if (!showAddProductModal) return;
    fetchProducts(productQuery || "all");
  }, [showAddProductModal, productQuery, quote.companyId]);

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
  const savedCustomerDetails = {
    firstName: quote.invoiceData?.quoteEditMeta?.customerDetails?.firstName || quote.customerFirstName || "",
    lastName: quote.invoiceData?.quoteEditMeta?.customerDetails?.lastName || quote.customerLastName || "",
    email: quote.invoiceData?.quoteEditMeta?.customerDetails?.email || quote.customerEmail || "",
  };
  const savedDeliveryDetails = {
    locationName: quote.invoiceData?.quoteEditMeta?.deliveryDetails?.locationName || "",
    address: quote.invoiceData?.quoteEditMeta?.deliveryDetails?.address || "",
    phone: quote.invoiceData?.quoteEditMeta?.deliveryDetails?.phone || "",
  };

  const initialLocationMatch = companyLocations.find(
    (loc: any) =>
      loc.name === savedDeliveryDetails.locationName ||
      loc.name === deliveryDetails.locationName,
  );
  const [selectedDeliveryLocationId, setSelectedDeliveryLocationId] = useState<string>(
    initialLocationMatch?.id || "",
  );
  const [deliveryLocationNameValue, setDeliveryLocationNameValue] = useState<string>(
    savedDeliveryDetails.locationName || deliveryDetails.locationName || "",
  );
  const [deliveryPhoneValue, setDeliveryPhoneValue] = useState<string>(
    savedDeliveryDetails.phone || deliveryDetails.phone || "",
  );
  const [deliveryAddressValue, setDeliveryAddressValue] = useState<string>(
    savedDeliveryDetails.address || (deliveryDetails.addressLines || []).join("\n") || "",
  );

  useEffect(() => {
    if (!selectedDeliveryLocationId) return;

    const location = companyLocations.find(
      (loc: any) => loc.id === selectedDeliveryLocationId,
    );
    if (!location) return;

    const addressLines = [] as string[];
    const shipping = location.shippingAddress || {};
    const recipient = [shipping.firstName, shipping.lastName]
      .filter(Boolean)
      .join(" ");
    if (recipient) addressLines.push(recipient);
    if (location.name) addressLines.push(location.name);
    if (shipping.address1) addressLines.push(shipping.address1);
    if (shipping.address2) addressLines.push(shipping.address2);
    const cityLine = [shipping.city, shipping.province, shipping.zip]
      .filter(Boolean)
      .join(", ");
    if (cityLine) addressLines.push(cityLine);
    if (shipping.country) addressLines.push(shipping.country);

    setDeliveryLocationNameValue(location.name || "");
    setDeliveryPhoneValue(shipping.phone || location.phone || "");
    setDeliveryAddressValue(addressLines.join("\n"));
  }, [selectedDeliveryLocationId, companyLocations]);

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
      <SalesPortalHeader
        title={quote.quoteNumber}
        subtitle={quote.title}
        companyId={quote.companyId}
        companies={allCompanies}
        startAction={
          <Link
            to={`/sales/portal/company/${quote.companyId}/quotes`}
            aria-disabled={isSubmitting}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              minHeight: 36,
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid #dfe3ea",
              background: "#fff",
              color: "#2c6ecb",
              textDecoration: "none",
              fontWeight: 600,
              fontSize: 13,
              opacity: isSubmitting ? 0.55 : 1,
              pointerEvents: isSubmitting ? "none" : "auto",
            }}
          >
            Back to Quotes
          </Link>
        }
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
            {quote.shopifyDraftOrderId && (
              <Form method="post" onSubmit={guardSubmission}>
                <input type="hidden" name="intent" value="preview_invoice" />
                <button
                  disabled={isSubmitting}
                  aria-busy={pendingIntent === "preview_invoice"}
                  style={disabledButtonStyle(styles.secondaryBtn, isSubmitting)}
                >
                  {pendingIntent === "preview_invoice" && <Spinner dark />}
                  {pendingIntent === "preview_invoice" ? "Loading..." : "Preview Invoice"}
                </button>
              </Form>
            )}
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

      {editableStatuses.includes(quote.status) ? (
        <Form method="post" id="quote-edit-form" onSubmit={guardSubmission}>
          <input type="hidden" name="intent" value="update_quote" />
          <div className="sales-quote-detail-grid" style={styles.grid}>
            <section style={styles.mainCol}>
              {/* Customer Information */}
              <div className="sales-quote-card" style={styles.card}>
                <div style={styles.cardHeader}>
                  <h2 style={styles.cardTitle}>Customer Information</h2>
                  <label style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", minWidth: 180, gap: 6, margin: 0 }}>
                    <span style={{ color: "#6b7280", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                      Status
                    </span>
                    <select name="status" defaultValue={quote.status} style={styles.input} disabled={isSubmitting}>
                      {quoteStatuses.map((status) => (
                        <option key={status} value={status}>
                          {status.charAt(0).toUpperCase() + status.slice(1)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="sales-quote-info-grid" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 16 }}>
                  <label style={styles.label}>
                    Company
                    <input style={styles.input} value={quote.company.name} disabled />
                  </label>
                  <label style={styles.label}>
                    Quote Title
                    <input name="title" defaultValue={quote.title} style={styles.input} disabled={isSubmitting} />
                  </label>
                  <label style={styles.label}>
                    First Name
                    <input name="customerFirstName" defaultValue={savedCustomerDetails.firstName} style={styles.input} disabled={isSubmitting} />
                  </label>
                  <label style={styles.label}>
                    Last Name
                    <input name="customerLastName" defaultValue={savedCustomerDetails.lastName} style={styles.input} disabled={isSubmitting} />
                  </label>
                  <label style={styles.label}>
                    Email
                    <input name="customerEmail" type="email" defaultValue={savedCustomerDetails.email} style={styles.input} disabled={isSubmitting} />
                  </label>
                  <label style={styles.label}>
                    Expiration
                    <input type="date" name="expiresAt" defaultValue={dateInput} style={styles.input} disabled={isSubmitting} />
                  </label>
                </div>
              </div>

              {/* Delivery Details */}
              <div className="sales-quote-card" style={styles.card}>
                <h2 style={styles.cardTitle}>Delivery Details</h2>
                <div className="sales-quote-delivery-grid" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 16 }}>
                  <label style={styles.label}>
                    Saved location
                    <select
                      name="deliveryLocationId"
                      value={selectedDeliveryLocationId}
                      onChange={(e) => setSelectedDeliveryLocationId(e.target.value)}
                      style={styles.input}
                      disabled={isSubmitting}
                    >
                      <option value="">-- Use custom delivery details --</option>
                      {companyLocations.map((location: any) => (
                        <option key={location.id} value={location.id}>
                          {location.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label style={styles.label}>
                    Location name
                    <input
                      name="deliveryLocationName"
                      value={deliveryLocationNameValue}
                      onChange={(e) => {
                        setDeliveryLocationNameValue(e.target.value);
                        if (selectedDeliveryLocationId) setSelectedDeliveryLocationId("");
                      }}
                      placeholder="e.g. Warehouse / Store name"
                      style={styles.input}
                      disabled={isSubmitting}
                    />
                  </label>
                  <label style={styles.label}>
                    Delivery Phone
                    <input
                      name="deliveryPhone"
                      value={deliveryPhoneValue}
                      onChange={(e) => {
                        setDeliveryPhoneValue(e.target.value);
                        if (selectedDeliveryLocationId) setSelectedDeliveryLocationId("");
                      }}
                      style={styles.input}
                      disabled={isSubmitting}
                    />
                  </label>
                  <label style={{ ...styles.label, gridColumn: "1 / -1" }}>
                    Delivery Address
                    <textarea
                      name="deliveryAddress"
                      value={deliveryAddressValue}
                      onChange={(e) => {
                        setDeliveryAddressValue(e.target.value);
                        if (selectedDeliveryLocationId) setSelectedDeliveryLocationId("");
                      }}
                      placeholder="Full delivery address"
                      rows={4}
                      style={{ ...styles.textarea, minHeight: 72 }}
                      disabled={isSubmitting}
                    />
                  </label>
                </div>
                {companyLocations.length > 0 ? (
                  <p style={{ ...styles.muted, marginTop: 10 }}>
                    Select one of the saved company locations to auto-fill address and phone, or leave the location blank to add a new one.
                  </p>
                ) : (
                  <p style={{ ...styles.muted, marginTop: 10 }}>
                    No saved company locations are available. Enter a new delivery location below.
                  </p>
                )}
              </div>

              {/* Notes */}
              <div className="sales-quote-card" style={styles.card}>
                <h2 style={styles.cardTitle}>Notes</h2>
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
              </div>

              {/* Product Information */}
              <div className="sales-quote-card" style={styles.card}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                  <h2 style={{ ...styles.cardTitle, margin: 0 }}>Product Information</h2>
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={openAddProductModal}
                    style={{ ...styles.secondaryBtn, padding: "8px 12px", fontSize: 13 }}
                  >
                    + Add Product
                  </button>
                </div>

                <div className="sales-quote-products-table-wrap" style={{ overflowX: "auto" }}>
                  <div style={styles.productsTable}>
                    {/* Header row */}
                    <div className="sales-quote-product-header" style={styles.productHeaderRow}>
                      <span>Product</span>
                      <span>SKU</span>
                      <span>Variant</span>
                      <span>Quantity</span>
                      <span>Unit Price</span>
                      <span>Discount</span>
                      <span style={{ textAlign: "right" }}>Line Total</span>
                      <span />
                    </div>

                    {/* Existing items */}
                    {quote.items.map((item: any) => (
                      <div key={item.id} className="sales-quote-product-row" style={styles.productRow}>
                        <div style={styles.productCellMain}>
                          <img
                            src={item.image || ""}
                            alt=""
                            style={styles.productThumbSm}
                            onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }}
                          />
                          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                            <input
                              name={`productTitle_${item.id}`}
                              defaultValue={item.productTitle}
                              style={{ ...styles.productRowInput, fontWeight: 700 }}
                              disabled={isSubmitting}
                            />
                            <input
                              name={`image_${item.id}`}
                              defaultValue={item.image || ""}
                              placeholder="Image URL"
                              style={{ ...styles.productRowInput, fontSize: 11, color: "#6b7280" }}
                              disabled={isSubmitting}
                            />
                          </div>
                        </div>

                        <input
                          name={`sku_${item.id}`}
                          defaultValue={item.sku || ""}
                          placeholder="SKU"
                          style={styles.productRowInput}
                          disabled={isSubmitting}
                        />

                        <input
                          name={`variantTitle_${item.id}`}
                          defaultValue={item.variantTitle || "Default Title"}
                          style={styles.productRowInput}
                          disabled={isSubmitting}
                        />

                        <input
                          type="number"
                          min="1"
                          name={`quantity_${item.id}`}
                          defaultValue={item.quantity}
                          style={styles.productRowInput}
                          disabled={isSubmitting}
                        />

                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          name={`unitPrice_${item.id}`}
                          defaultValue={Number(item.unitPrice) || 0}
                          style={styles.productRowInput}
                          disabled={isSubmitting}
                        />

                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          name={`discount_${item.id}`}
                          defaultValue={Number(item.discount) || 0}
                          style={styles.productRowInput}
                          disabled={isSubmitting}
                        />

                        <div style={{ textAlign: "right", fontWeight: 700, fontSize: 14 }}>
                          {fmtMoney(item.totalPrice, item.currencyCode)}
                        </div>

                        <div style={{ display: "flex", justifyContent: "flex-end" }}>
                          <button
                            type="submit"
                            name="intent"
                            value="delete_item"
                            formNoValidate
                            title="Remove item"
                            onClick={(e) => {
                              if (!confirm("Remove this item from the quote?")) e.preventDefault();
                            }}
                            disabled={isSubmitting}
                            style={styles.removeIconBtn}
                          >
                            Remove
                          </button>
                          <input type="hidden" name="itemId" value={item.id} />
                        </div>
                      </div>
                    ))}

                    {/* Newly added (pending save) rows */}
                    {newProductRows.map((row) => (
                      <div key={row.rowKey} className="sales-quote-product-row" style={{ ...styles.productRow, background: "#faf5ff" }}>
                        <input type="hidden" name="newProductRow" value={row.rowKey} />
                        <input type="hidden" name={`newProductId_${row.rowKey}`} value={row.productId || ""} />
                        <input type="hidden" name={`newProductTitle_${row.rowKey}`} value={row.productTitle} />
                        <input type="hidden" name={`newSku_${row.rowKey}`} value={row.sku} />
                        <input type="hidden" name={`newVariantTitle_${row.rowKey}`} value={row.variantTitle} />
                        <input type="hidden" name={`newVariantId_${row.rowKey}`} value={row.variantId} />
                        <input type="hidden" name={`newImage_${row.rowKey}`} value={row.image} />
                        <input type="hidden" name={`newUnitPrice_${row.rowKey}`} value={row.unitPrice} />
                        <input type="hidden" name={`newDiscount_${row.rowKey}`} value={row.discount} />
                        <input type="hidden" name={`newQuantity_${row.rowKey}`} value={row.quantity} />

                        <div style={styles.productCellMain}>
                          <div style={{ ...styles.productThumbSm, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                            {row.image ? (
                              <img src={row.image} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                            ) : (
                              <span style={{ color: "#9ca3af", fontSize: 9 }}>No image</span>
                            )}
                          </div>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 700, fontSize: 13.5 }}>{row.productTitle}</div>
                            <span style={styles.pillPending}>Pending Save</span>
                          </div>
                        </div>
                        <div style={{ fontSize: 13 }}>{row.sku || "N/A"}</div>
                        <div style={{ fontSize: 13 }}>{row.variantTitle || "Default variant"}</div>
                        <div style={{ fontSize: 13 }}>{row.quantity}</div>
                        <div style={{ fontSize: 13 }}>US${Number(row.unitPrice || 0).toFixed(2)}</div>
                        <div style={{ fontSize: 13 }}>US${Number(row.discount || 0).toFixed(2)}</div>
                        <div style={{ textAlign: "right", fontWeight: 700, fontSize: 14 }}>
                          US${Math.max(0, Number(row.unitPrice || 0) * Number(row.quantity || 1) - Number(row.discount || 0)).toFixed(2)}
                        </div>
                        <div style={{ display: "flex", justifyContent: "flex-end" }}>
                          <button
                            type="button"
                            onClick={() => removePendingProduct(row.rowKey)}
                            disabled={isSubmitting}
                            style={styles.removeIconBtn}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Activity History */}
              <div className="sales-quote-card" style={styles.card}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <h2 style={styles.cardTitle}>Activity History</h2>
                  {quote.activities.length > 0 && (
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
                      title={showAllActivities ? "Collapse" : "Expand"}
                    >
                      {showAllActivities ? "\u25B2" : "\u25BC"}
                    </button>
                  )}
                </div>
                {showAllActivities && (
                  quote.activities.length ? (
                    <div className="hide-scrollbar" style={{ maxHeight: 440, overflowY: "auto", paddingRight: 4 }}>
                      <div style={styles.timeline}>
                        {quote.activities.map((activity: any) => (
                          <div key={activity.id} style={styles.activity}>
                            <strong>{activity.action}</strong>
                            <span>{fmtDate(activity.createdAt)}</span>
                            {activity.message && <p>{activity.message}</p>}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p style={styles.muted}>No activity yet.</p>
                  )
                )}
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
                <p style={styles.muted}>Copy this secure quote link for the customer.</p>
              </div>

              <div className="sales-quote-card" style={styles.card}>
                <h2 style={styles.cardTitle}>Pricing Summary</h2>
                <div style={{ display: "grid", gap: 12, marginBottom: 16 }}>
                  <label style={styles.label}>
                    Discount type
                    <select
                      name="discountType"
                      defaultValue={quote.discountType || "FIXED_AMOUNT"}
                      style={styles.input}
                      disabled={isSubmitting}
                    >
                      <option value="FIXED_AMOUNT">Fixed amount</option>
                      <option value="PERCENTAGE">Percentage</option>
                    </select>
                  </label>
                  <label style={styles.label}>
                    Discount
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      name="discountAmount"
                      defaultValue={quote.discountAmount || 0}
                      style={styles.input}
                      disabled={isSubmitting}
                    />
                  </label>
                  <label style={styles.label}>
                    Tax rate (%)
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      name="taxRate"
                      defaultValue={quote.taxRate || 0}
                      style={styles.input}
                      disabled={isSubmitting}
                    />
                  </label>
                  <label style={styles.label}>
                    Shipping
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      name="shippingAmount"
                      defaultValue={quote.shippingAmount || 0}
                      style={styles.input}
                      disabled={isSubmitting}
                    />
                  </label>
                </div>
                <Summary label="Subtotal" value={fmtMoney(quote.subtotal)} />
                <Summary label="Discount" value={`-${fmtMoney(quote.discountTotal)}`} />
                <Summary label={`Tax (${quote.taxRate}%)`} value={fmtMoney(quote.taxAmount)} />
                <Summary label="Shipping" value={fmtMoney(quote.shippingAmount)} />
                <div style={styles.totalRow}>
                  <strong>Grand Total</strong>
                  <strong>{fmtMoney(quote.totalAmount)}</strong>
                </div>
                <p style={{ ...styles.muted, marginTop: 10 }}>
                  Recalculates automatically from line items after saving.
                </p>
              </div>

              <div className="sales-quote-card" style={styles.card}>
                <h2 style={styles.cardTitle}>Quote Actions</h2>
                <button
                  type="submit"
                  form="quote-edit-form"
                  name="intent"
                  value="update_quote"
                  disabled={isSubmitting}
                  aria-busy={pendingIntent === "update_quote"}
                  style={{ ...disabledButtonStyle(styles.primaryBtn, isSubmitting), width: "100%" }}
                >
                  {pendingIntent === "update_quote" && <Spinner />}
                  {pendingIntent === "update_quote" ? "Saving Changes..." : "Save Changes"}
                </button>
              </div>

              <div className="sales-quote-card" style={styles.card}>
                <h2 style={styles.cardTitle}>Customer Note</h2>
                <div style={{ padding: "10px 0", color: "#374151", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                  {quote.customerNotes?.trim() ? quote.customerNotes : "No customer note has been added yet."}
                </div>
              </div>
            </aside>
          </div>
        </Form>
      ) : (
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
                  value={quote.salesAgent?.firstName || quote.salesAgent?.email || "Sales Agent"}
                />
                <Info label="Created" value={fmtDate(quote.createdAt)} />
                <Info label="Expires" value={fmtDate(quote.expiresAt)} />
              </div>
            </div>

            <DeliveryDetailsCard deliveryDetails={deliveryDetails} quote={quote} />

            <div className="sales-quote-card" style={{ ...styles.card, padding: 0, overflow: "hidden" }}>
              <div style={styles.cardHeading}>
                <h2 style={{ ...styles.cardTitle, margin: 0 }}>Product Summary</h2>
              </div>
              <div className="sales-quote-table-wrap">
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Product</th>
                      <th style={styles.th}>Variant</th>
                      <th style={styles.th}>Qty</th>
                      <th style={styles.th}>Unit</th>
                      <th style={styles.th}>Actions</th>
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
                        <td style={styles.td}>{item.variantTitle || "Default"}</td>
                        <td style={styles.td}>{item.quantity}</td>
                        <td style={styles.td}>{fmtMoney(item.unitPrice, item.currencyCode)}</td>
                        <td style={styles.td}>
                          {editableStatuses.includes(quote.status) && (
                            <Form
                              method="post"
                              onSubmit={(e) => {
                                if (!confirm("Remove this item from the quote?")) e.preventDefault();
                              }}
                            >
                              <input type="hidden" name="intent" value="delete_item" />
                              <input type="hidden" name="itemId" value={item.id} />
                              <button
                                type="submit"
                                disabled={isSubmitting}
                                style={{ ...styles.secondaryBtn, padding: "6px 10px", fontSize: 13 }}
                              >
                                Remove
                              </button>
                            </Form>
                          )}
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
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <h2 style={styles.cardTitle}>Activity History</h2>
                {quote.activities.length > 0 && (
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
                    title={showAllActivities ? "Collapse" : "Expand"}
                  >
                    {showAllActivities ? "\u25B2" : "\u25BC"}
                  </button>
                )}
              </div>
              {showAllActivities && (
                quote.activities.length ? (
                  <div className="hide-scrollbar" style={{ maxHeight: 440, overflowY: "auto", paddingRight: 4 }}>
                    <div style={styles.timeline}>
                      {quote.activities.map((activity: any) => (
                        <div key={activity.id} style={styles.activity}>
                          <strong>{activity.action}</strong>
                          <span>{fmtDate(activity.createdAt)}</span>
                          {activity.message && <p>{activity.message}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p style={styles.muted}>No activity yet.</p>
                )
              )}
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
              <p style={styles.muted}>Copy this secure quote link for the customer.</p>
            </div>

            <div className="sales-quote-card" style={styles.card}>
              <h2 style={styles.cardTitle}>Grand Total</h2>
              <Summary label="Subtotal" value={fmtMoney(quote.subtotal)} />
              <Summary label="Discount" value={`-${fmtMoney(quote.discountTotal)}`} />
              <Summary label={`Tax (${quote.taxRate}%)`} value={fmtMoney(quote.taxAmount)} />
              <Summary label="Shipping" value={fmtMoney(quote.shippingAmount)} />
              <div style={styles.totalRow}>
                <strong>Total</strong>
                <strong>{fmtMoney(quote.totalAmount)}</strong>
              </div>
            </div>
          </aside>
        </div>
      )}

      <style>{`
        @keyframes quote-action-spin { to { transform: rotate(360deg); } }
        .sales-quote-table-wrap { overflow-x: auto; }
        .sales-quote-products-table-wrap { overflow-x: auto; }
        .sales-quote-product-row:last-child { border-bottom: none !important; }
        @media (max-width: 1080px) {
          .sales-quote-detail-grid { grid-template-columns: minmax(0, 1fr) !important; }
          .sales-quote-side-column { position: static !important; }
        }
        @media (max-width: 700px) {
          .sales-quote-card { padding: 16px !important; }
          .sales-quote-info-grid, .sales-quote-delivery-grid { grid-template-columns: minmax(0, 1fr) !important; }
          .sales-add-product-grid { grid-template-columns: minmax(0, 1fr) !important; }
        }
      `}</style>

      {/* Add Product Modal */}
      {showAddProductModal && (
        <AddProductModal
          form={addProductForm}
          setForm={setAddProductForm}
          onCancel={() => setShowAddProductModal(false)}
          onConfirm={confirmAddProduct}
          productQuery={productQuery}
          setProductQuery={setProductQuery}
          productResults={productResults}
          fetchProducts={fetchProducts}
          isFetchingProducts={isFetchingProducts}
          onSelectVariant={handleSelectProductVariant}
        />
      )}

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
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Invoice Preview — {quote.quoteNumber}</h3>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button
                  type="button"
                  onClick={() => window.print()}
                  style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid transparent", fontWeight: 600, fontSize: 12, cursor: "pointer", background: "#005bd3", color: "#fff" }}
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
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 24 }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>INVOICE</h2>
                  <p style={{ margin: "4px 0 0", color: "#5c5f62", fontSize: 13 }}>{quote.quoteNumber}</p>
                </div>
                <div style={{ textAlign: "right", fontSize: 13, color: "#5c5f62" }}>
                  <p style={{ margin: 0 }}><strong>Date:</strong> {invoiceData.createdAt ? new Date(invoiceData.createdAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "–"}</p>
                  {invoiceData.invoiceSentAt && (
                    <p style={{ margin: "2px 0 0" }}><strong>Sent:</strong> {new Date(invoiceData.invoiceSentAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</p>
                  )}
                </div>
              </div>

              {invoiceData.customer && (
                <div style={{ marginBottom: 24, fontSize: 13 }}>
                  <strong>Bill To:</strong>
                  <p style={{ margin: "4px 0 0" }}>
                    {[invoiceData.customer.firstName, invoiceData.customer.lastName].filter(Boolean).join(" ")}
                  </p>
                  {invoiceData.customer.email && <p style={{ margin: "2px 0 0", color: "#5c5f62" }}>{invoiceData.customer.email}</p>}
                </div>
              )}

              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginBottom: 24 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: "8px 10px", background: "#f4f6f8", borderBottom: "1px solid #e3e7ec", fontWeight: 600, color: "#5c5f62" }}>Product</th>
                    <th style={{ textAlign: "left", padding: "8px 10px", background: "#f4f6f8", borderBottom: "1px solid #e3e7ec", fontWeight: 600, color: "#5c5f62" }}>SKU</th>
                    <th style={{ textAlign: "center", padding: "8px 10px", background: "#f4f6f8", borderBottom: "1px solid #e3e7ec", fontWeight: 600, color: "#5c5f62" }}>Qty</th>
                    <th style={{ textAlign: "right", padding: "8px 10px", background: "#f4f6f8", borderBottom: "1px solid #e3e7ec", fontWeight: 600, color: "#5c5f62" }}>Unit Price</th>
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
                      <td style={{ padding: "8px 10px", borderBottom: "1px solid #f0f0f0", textAlign: "right", fontWeight: 600 }}>
                        {fmtMoney(item.discountedTotal, invoiceData.currencyCode)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <div style={{ width: 280, fontSize: 13 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}><span>Subtotal</span><span>{fmtMoney(invoiceData.subtotal, invoiceData.currencyCode)}</span></div>
                  {Number(invoiceData.totalDiscounts) > 0 && (
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}><span>Discount</span><span style={{ color: "#b91b1b" }}>-{fmtMoney(invoiceData.totalDiscounts, invoiceData.currencyCode)}</span></div>
                  )}
                  {Number(invoiceData.totalShipping) > 0 && (
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}><span>Shipping</span><span>{fmtMoney(invoiceData.totalShipping, invoiceData.currencyCode)}</span></div>
                  )}
                  {Number(invoiceData.totalTax) > 0 && (
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}><span>Tax</span><span>{fmtMoney(invoiceData.totalTax, invoiceData.currencyCode)}</span></div>
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, fontSize: 15, borderTop: "2px solid #e3e7ec", marginTop: 8, paddingTop: 8 }}>
                    <span>Total</span>
                    <span>{fmtMoney(invoiceData.totalPrice, invoiceData.currencyCode)}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
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

function QuantityStepper({
  name,
  defaultValue,
  disabled,
}: {
  name: string;
  defaultValue: number;
  disabled?: boolean;
}) {
  return (
    <input
      type="number"
      name={name}
      min={1}
      defaultValue={defaultValue}
      disabled={disabled}
      style={{
        width: 80,
        padding: "8px 10px",
        borderRadius: 8,
        border: "1px solid #d1d5db",
        textAlign: "center",
      }}
    />
  );
}

function DeliveryDetailsCard({
  deliveryDetails,
  quote,
}: {
  deliveryDetails: DeliveryDetails;
  quote?: any;
}) {
  const manualDelivery = quote?.invoiceData?.quoteEditMeta?.deliveryDetails || {};
  const locationName = manualDelivery.locationName || deliveryDetails.locationName || "Not captured";
  const addressLines = manualDelivery.address
    ? manualDelivery.address
        .split(/\n+/)
        .map((line: string) => line.trim())
        .filter(Boolean)
    : deliveryDetails.addressLines;
  const phone = manualDelivery.phone || deliveryDetails.phone;

  return (
    <div className="sales-quote-card" style={styles.card}>
      <h2 style={styles.cardTitle}>Delivery Details</h2>
      <div className="sales-quote-delivery-grid" style={styles.deliveryGrid}>
        <Info label="Location" value={locationName} />
        <div>
          <span style={styles.metaLabel}>
            {deliveryDetails.source === "company_location"
              ? "Location Address"
              : "Delivery Address"}
          </span>
          {addressLines.length > 0 ? (
            <address style={styles.addressText}>
              {addressLines.map((line: string) => (
                <span key={line}>{line}</span>
              ))}
            </address>
          ) : (
            <p style={styles.muted}>
              Delivery address was not captured for this quote.
            </p>
          )}
        </div>
        {phone && <Info label="Phone" value={phone} />}
      </div>
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
  deliveryGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 16,
  },
  addressText: {
    display: "flex",
    flexDirection: "column",
    gap: 3,
    margin: 0,
    color: "#111827",
    fontSize: 13,
    fontStyle: "normal",
    lineHeight: 1.45,
  },
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

  /* ---- Product Information table row layout ---- */
  productsTable: {
    display: "flex",
    flexDirection: "column",
    minWidth: 780,
  },
  productHeaderRow: {
    display: "grid",
    gridTemplateColumns: "2.2fr 1fr 1fr 0.8fr 1fr 1fr 1fr 70px",
    gap: 12,
    padding: "0 0 10px",
    borderBottom: "1px solid #e5e7eb",
    color: "#6b7280",
    fontSize: 12,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  productRow: {
    display: "grid",
    gridTemplateColumns: "2.2fr 1fr 1fr 0.8fr 1fr 1fr 1fr 70px",
    gap: 12,
    alignItems: "center",
    padding: "14px 0",
    borderBottom: "1px solid #f0f1f2",
  },
  productCellMain: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    minWidth: 0,
  },
  productThumbSm: {
    width: 44,
    height: 44,
    borderRadius: 8,
    objectFit: "cover",
    border: "1px solid #e5e7eb",
    background: "#f9fafb",
    flexShrink: 0,
  },
  productRowInput: {
    width: "100%",
    boxSizing: "border-box",
    height: 38,
    border: "1px solid #d1d5db",
    borderRadius: 7,
    padding: "0 9px",
    font: "inherit",
    fontSize: 13,
  },
  removeIconBtn: {
    background: "none",
    border: "none",
    color: "#9ca3af",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
    padding: "6px 4px",
  },
  sidebarTabBtn: {
    background: "#f9fafb",
    border: "1px solid #d1d5db",
    borderRadius: 999,
    color: "#374151",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 700,
    padding: "8px 14px",
  },
  sidebarTabActive: {
    background: "#111827",
    border: "1px solid #111827",
    borderRadius: 999,
    color: "#ffffff",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 700,
    padding: "8px 14px",
  },

  /* ---- retained legacy card tokens (still used as fallbacks) ---- */
  productCard: {
    display: "flex",
    gap: 14,
    border: "1px solid #e5e7eb",
    borderRadius: 10,
    padding: 14,
    alignItems: "flex-start",
  },
  productThumb: {
    width: 64,
    height: 64,
    borderRadius: 8,
    objectFit: "cover",
    border: "1px solid #e5e7eb",
    background: "#f9fafb",
    flexShrink: 0,
  },
  productTag: {
    display: "inline-block",
    background: "#f3f4f6",
    color: "#6b7280",
    borderRadius: 999,
    padding: "3px 9px",
    fontSize: 11,
    fontWeight: 600,
    marginRight: 6,
    marginTop: 4,
  },
  productPriceLabel: { fontSize: 11, color: "#9333ea", fontWeight: 700, marginBottom: 2 },
  productPriceValue: { fontSize: 16, fontWeight: 800, color: "#9333ea" },
  productActionBtn: {
    background: "#9333ea",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "9px 16px",
    fontWeight: 700,
    fontSize: 13,
    cursor: "pointer",
  },
  stepperBtn: {
    width: 28,
    height: 28,
    borderRadius: 7,
    border: "1px solid #d1d5db",
    background: "#f9fafb",
    color: "#374151",
    fontSize: 16,
    fontWeight: 700,
    cursor: "pointer",
    lineHeight: 1,
  },
  stepperInput: {
    width: 40,
    height: 28,
    textAlign: "center",
    border: "1px solid #d1d5db",
    borderRadius: 7,
    font: "inherit",
    fontSize: 13,
  },

  /* ---- storefront-style Add Product preview card (matches product picker UI) ---- */
  storefrontCard: {
    display: "flex",
    gap: 14,
    border: "1px solid #eceef1",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
    background: "#fff",
  },
  storefrontThumb: {
    width: 64,
    height: 64,
    borderRadius: 10,
    objectFit: "cover",
    border: "1px solid #eceef1",
    background: "#f9fafb",
    flexShrink: 0,
  },
  pillRow: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 },
  pill: {
    display: "inline-block",
    background: "#f1f2f4",
    color: "#4b5563",
    borderRadius: 999,
    padding: "3px 10px",
    fontSize: 11,
    fontWeight: 600,
  },
  pillPending: {
    display: "inline-block",
    background: "#f3e8ff",
    color: "#7e22ce",
    borderRadius: 999,
    padding: "3px 10px",
    fontSize: 11,
    fontWeight: 700,
  },
  storefrontPriceLabel: { fontSize: 12, color: "#a21caf", fontWeight: 700 },
  storefrontPriceValue: { fontSize: 18, fontWeight: 800, color: "#a21caf", marginTop: 2 },
  addToQuoteBtn: {
    background: "linear-gradient(135deg, #c026d3, #9333ea)",
    color: "#fff",
    border: "none",
    borderRadius: 999,
    padding: "10px 20px",
    fontWeight: 700,
    fontSize: 13,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
};
