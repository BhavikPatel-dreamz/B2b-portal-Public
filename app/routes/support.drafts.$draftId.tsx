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
  SalesPortalHeader,
  SalesPortalLayout,
} from "app/components/SalesPortalLayout";
import {
  buildClearSessionCookie,
  requireSalesSession,
} from "app/utils/sales-session.server";
import {
  getOrderAccessWhere,
  getOrderNumber,
  getSalesOrderAccessLevel,
  getShopifyOrderWhere,
  logOrderActivity,
} from "app/services/sales-order-management.server";
import {
  createQuoteFromCart,
  getQuoteUrl,
  type QuoteCartItem,
} from "app/services/quote.server";
import {
  getDeliveryDetailsForRecord,
  type DeliveryDetails,
} from "app/services/delivery-details.server";
import { getCompanyLocations } from "app/utils/b2b-customer.server";
import { getAdminForShop } from "app/shopify.server";
import {
  assertNoShopifyUserErrors,
  shopifyOrderGraphql,
  verifyShopifyOrder,
} from "app/services/shopify-order-creation.server";

type DraftNotes = {
  internalNotes: string;
  customerNotes: string;
  deliveryDetails?: {
    locationName: string;
    address1: string;
    address2: string;
    city: string;
    province: string;
    zip: string;
    country: string;
    phone: string;
  };
};

type ActionResponse = {
  success?: boolean;
  message?: string;
  error?: string;
};

type NewProductRow = {
  rowKey: string;
  productId?: string | null;
  productTitle: string;
  sku: string;
  variantTitle: string;
  variantId: string;
  image: string;
  quantity: number;
  unitPrice: number;
  discount: number;
};

function parseDraftNotes(notes?: string | null): DraftNotes {
  if (!notes) return { internalNotes: "", customerNotes: "", deliveryDetails: undefined };
  try {
    const parsed = JSON.parse(notes);
    if (parsed && typeof parsed === "object") {
      const dd = (parsed as any).deliveryDetails as Record<string, any> | undefined;
      return {
        internalNotes: String((parsed as any).internalNotes || ""),
        customerNotes: String((parsed as any).customerNotes || ""),
        deliveryDetails:
          dd && typeof dd === "object"
            ? {
                locationName: String(dd.locationName || ""),
                address1: String(dd.address1 || dd.address?.split("\n")[0] || ""),
                address2: String(dd.address2 || dd.address?.split("\n")[1] || ""),
                city: String(dd.city || dd.address?.split("\n")[2] || ""),
                province: String(dd.province || dd.address?.split("\n")[3] || ""),
                zip: String(dd.zip || dd.address?.split("\n")[4] || ""),
                country: String(dd.country || dd.address?.split("\n")[5] || ""),
                phone: String(dd.phone || ""),
              }
            : undefined,
      };
    }
  } catch {
    // Legacy drafts stored a single notes field. Treat that as internal notes.
  }
  return { internalNotes: notes, customerNotes: "" };
}

function serializeDraftNotes(input: DraftNotes) {
  return JSON.stringify(input);
}

function numberField(formData: FormData, key: string, fallback = 0) {
  const value = Number(formData.get(key) || fallback);
  return Number.isFinite(value) ? value : fallback;
}

function getDraftForUser(user: any, draftId: string) {
  return prisma.b2BOrder.findFirst({
    where: {
      id: draftId,
      companyId: {
        in: user.salesCompanies.map((item: any) => item.companyId),
      },
      orderStatus: "draft",
    },
    include: {
      company: { include: { shop: true } },
      createdByUser: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      items: { orderBy: { createdAt: "asc" } },
      payments: { orderBy: { createdAt: "desc" } },
      activities: {
        orderBy: { createdAt: "desc" },
        include: {
          user: { select: { firstName: true, lastName: true, email: true } },
        },
      },
    },
  });
}

type DraftRecord = NonNullable<Awaited<ReturnType<typeof getDraftForUser>>>;

function draftLineItems(order: DraftRecord) {
  if (!order) return [];
  return order.items.map((item) => ({
    productId: item.productId || undefined,
    productTitle: item.productTitle,
    variantId: item.variantId || "",
    variantTitle: item.variantTitle || undefined,
    sku: item.sku || undefined,
    image: item.image || undefined,
    quantity: item.quantity,
    price: Number(item.unitPrice),
    currencyCode: order.currencyCode,
  })) satisfies QuoteCartItem[];
}

async function resolveCustomerId(draft: DraftRecord) {
  if (draft.customerId) return draft.customerId;
  if (draft.customerEmail) {
    const customer = await prisma.user.findFirst({
      where: {
        shopId: draft.shopId,
        email: draft.customerEmail,
      },
      select: { id: true, shopifyCustomerId: true },
    });
    return customer?.shopifyCustomerId || customer?.id || "";
  }
  return "";
}

async function deleteDraftRecord(
  draft: DraftRecord,
) {
  const draftIdentifiers = [
    draft.id,
    draft.shopifyOrderId,
    draft.shopifyOrderId?.split("/").pop(),
  ].filter(Boolean) as string[];

  await prisma.creditTransaction.deleteMany({
    where: { companyId: draft.companyId, orderId: { in: draftIdentifiers } },
  });

  if (draft.shopifyOrderId) {
    const numericShopifyId = draft.shopifyOrderId.split("/").pop();
    await prisma.notification.deleteMany({
      where: {
        shopifyOrderId: {
          in: [draft.shopifyOrderId, numericShopifyId].filter(
            Boolean,
          ) as string[],
        },
      },
    });
  }

  await prisma.b2BOrder.delete({ where: { id: draft.id } });
}

async function deleteShopifyDraftOrder(
  draft: DraftRecord,
) {
  if (
    !draft.shopifyOrderId ||
    draft.shopifyOrderId.startsWith("gid://shopify/Order/") ||
    !draft.company.shop.accessToken
  ) {
    return;
  }

  const admin = await getAdminForShop(draft.company.shop.shopDomain);
  const draftOrderId = draft.shopifyOrderId.startsWith("gid://")
    ? draft.shopifyOrderId
    : `gid://shopify/DraftOrder/${draft.shopifyOrderId}`;
  const deleteData = await shopifyOrderGraphql<{
    draftOrderDelete: {
      deletedId: string | null;
      userErrors: Array<{ field?: string[] | null; message: string }>;
    };
  }>({
    admin,
    operation: "DeleteSalesPortalDraftOrder",
    query: `#graphql
      mutation DeleteSalesPortalDraftOrder($input: DraftOrderDeleteInput!) {
        draftOrderDelete(input: $input) {
          deletedId
          userErrors { field message }
        }
      }
    `,
    variables: { input: { id: draftOrderId } },
  });
  assertNoShopifyUserErrors(
    "DeleteSalesPortalDraftOrder",
    deleteData.draftOrderDelete.userErrors,
  );
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { user } = await requireSalesSession(request);
  if (!params.draftId) return redirect("/sales/portal/drafts");

  const draft = await getDraftForUser(user, params.draftId);
  if (!draft || draft.orderStatus !== "draft") {
    throw new Response("Draft not found", { status: 404 });
  }

  const accessLevel = getSalesOrderAccessLevel(user);
  const url = new URL(request.url);
  const saved = url.searchParams.get("saved") === "1";
  const duplicatedFrom = url.searchParams.get("duplicatedFrom");
  const accessWhere = getOrderAccessWhere(user);
  const companyIds = user.salesCompanies.map((item) => item.companyId);
  const [draftCount, orderCount, quoteCount, companyUsers] = await Promise.all([
    prisma.b2BOrder.count({
      where: {
        AND: [
          accessWhere,
          { orderStatus: "draft", NOT: getShopifyOrderWhere() },
        ],
      },
    }),
    prisma.b2BOrder.count({
      where: { AND: [accessWhere, getShopifyOrderWhere()] },
    }),
    prisma.quote.count({
      where: {
        companyId: { in: companyIds },
        ...(accessLevel === "agent" ? { salesAgentId: user.id } : {}),
      },
    }),
    prisma.user.findMany({
      where: {
        companyId: draft.companyId,
        isActive: true,
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        shopifyCustomerId: true,
      },
      orderBy: { firstName: "asc" },
    }),
  ]);

  const notes = parseDraftNotes(draft.notes);
  let deliveryDetails = await getDeliveryDetailsForRecord(draft);
  if (notes.deliveryDetails) {
    const addressLines = [
      notes.deliveryDetails.address1,
      notes.deliveryDetails.address2,
      notes.deliveryDetails.city,
      notes.deliveryDetails.province,
      notes.deliveryDetails.zip,
      notes.deliveryDetails.country,
    ].filter(Boolean);

    deliveryDetails = {
      ...deliveryDetails,
      locationName:
        notes.deliveryDetails.locationName || deliveryDetails.locationName,
      addressLines:
        addressLines.length > 0 ? addressLines : deliveryDetails.addressLines,
      phone: notes.deliveryDetails.phone || deliveryDetails.phone,
    };
  }

  let companyLocations: any[] = [];
  if (
    draft.company?.shopifyCompanyId &&
    draft.company.shop?.shopDomain &&
    draft.company.shop?.accessToken
  ) {
    const companyLocationsResult = await getCompanyLocations(
      draft.company.shopifyCompanyId,
      draft.company.shop.shopDomain,
      draft.company.shop.accessToken,
    );
    if (!companyLocationsResult.error) {
      companyLocations = companyLocationsResult.locations || [];
    }
  }

  return Response.json({
    user: {
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
    },
    companies: user.salesCompanies.map((item) => ({
      id: item.company.id,
      name: item.company.name,
    })),
    counts: { drafts: draftCount, orders: orderCount, quotes: quoteCount },
    successMessage: saved
      ? "Draft changes saved successfully."
      : duplicatedFrom
        ? `${getOrderNumber(draft)} was duplicated successfully from ${duplicatedFrom}.`
        : null,
    companyUsers,
    deliveryDetails,
    companyLocations,
    draft: {
      id: draft.id,
      orderNumber: getOrderNumber(draft),
      shopifyOrderId: draft.shopifyOrderId,
      company: {
        id: draft.company.id,
        name: draft.company.name,
        storeName:
          draft.company.shop.shopName || draft.company.shop.shopDomain,
      },
      customerName: draft.customerName,
      customerId: draft.customerId,
      customerEmail: draft.customerEmail,
      orderTotal: draft.orderTotal.toString(),
      subtotal: draft.subtotal.toString(),
      discountTotal: draft.discountTotal.toString(),
      taxAmount: draft.taxAmount.toString(),
      shippingAmount: draft.shippingAmount.toString(),
      currencyCode: draft.currencyCode,
      internalNotes: notes.internalNotes,
      customerNotes: notes.customerNotes,
      createdAt: draft.createdAt.toISOString(),
      updatedAt: draft.updatedAt.toISOString(),
      items: draft.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        productTitle: item.productTitle,
        variantId: item.variantId,
        variantTitle: item.variantTitle,
        sku: item.sku,
        image: item.image,
        quantity: item.quantity,
        unitPrice: item.unitPrice.toString(),
        discount: item.discount.toString(),
        lineTotal: item.lineTotal.toString(),
      })),
    },
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { user } = await requireSalesSession(request);
  const formData = await request.formData();
  const intentValues = formData.getAll("intent").map(String).filter(Boolean);
  const intent = intentValues.length > 0 ? intentValues[intentValues.length - 1] : "";

  if (intent === "logout") {
    return redirect("/sales/login", {
      headers: { "Set-Cookie": buildClearSessionCookie() },
    });
  }

  if (!params.draftId) {
    return Response.json({ error: "Draft not found." }, { status: 404 });
  }
  const draft = await getDraftForUser(user, params.draftId);
  if (!draft || draft.orderStatus !== "draft") {
    return Response.json({ error: "Draft not found." }, { status: 404 });
  }

  try {
    if (intent === "save_changes") {
      const itemIds = formData.getAll("itemId").map(String);
      const removeItemIds = new Set(formData.getAll("removeItemId").map(String));
      const updates = itemIds
        .filter((id) => !removeItemIds.has(id))
        .map((id) => {
          const quantity = Math.max(1, numberField(formData, `quantity_${id}`, 1));
          const unitPrice = Math.max(0, numberField(formData, `unitPrice_${id}`));
          const discount = Math.max(0, numberField(formData, `discount_${id}`));
          return {
            id,
            productTitle: String(formData.get(`productTitle_${id}`) || "Product"),
            sku: String(formData.get(`sku_${id}`) || ""),
            variantTitle: String(formData.get(`variantTitle_${id}`) || ""),
            image: String(formData.get(`image_${id}`) || ""),
            quantity,
            unitPrice,
            discount,
            lineTotal: Math.max(0, quantity * unitPrice - discount),
          };
        });

      const newRowKeys = formData
        .getAll("newProductRow")
        .map(String)
        .filter(Boolean);

      const newRows = newRowKeys
        .map((rowKey) => {
          const productTitle = String(formData.get(`newProductTitle_${rowKey}`) || "").trim();
          const variantTitle = String(formData.get(`newVariantTitle_${rowKey}`) || "").trim();
          const sku = String(formData.get(`newSku_${rowKey}`) || "").trim();
          const variantId = String(formData.get(`newVariantId_${rowKey}`) || "").trim();
          const image = String(formData.get(`newImage_${rowKey}`) || "").trim();
          const quantity = Math.max(1, numberField(formData, `newQuantity_${rowKey}`, 1));
          const unitPrice = Math.max(0, numberField(formData, `newUnitPrice_${rowKey}`));
          const discount = Math.max(0, numberField(formData, `newDiscount_${rowKey}`));

          if (!productTitle && !variantTitle && !sku && !image && quantity === 1 && unitPrice === 0 && discount === 0) {
            return null;
          }

          return {
            productId: String(formData.get(`newProductId_${rowKey}`) || "") || null,
            productTitle: productTitle || "Product",
            variantId: variantId || null,
            variantTitle: variantTitle || null,
            sku: sku || null,
            image: image || null,
            quantity,
            unitPrice,
            discount,
            lineTotal: Math.max(0, quantity * unitPrice - discount),
          };
        })
        .filter(Boolean) as Array<{
          productId: string | null;
          productTitle: string;
          variantId: string | null;
          variantTitle: string | null;
          sku: string | null;
          image: string | null;
          quantity: number;
          unitPrice: number;
          discount: number;
          lineTotal: number;
        }>;

      const newItems = newRows;

      const subtotal = updates.reduce(
        (sum, item) => sum + item.quantity * item.unitPrice,
        newItems.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
      );
      const lineDiscountTotal = updates.reduce(
        (sum, item) => sum + item.discount,
        newItems.reduce((sum, item) => sum + item.discount, 0),
      );
      const discountTotal = Math.max(
        0,
        numberField(formData, "discountTotal", lineDiscountTotal),
      );
      const taxAmount = Math.max(0, numberField(formData, "taxAmount"));
      const shippingAmount = Math.max(0, numberField(formData, "shippingAmount"));
      const orderTotal = Math.max(
        0,
        subtotal - discountTotal + taxAmount + shippingAmount,
      );
      const selectedCustomerId = String(formData.get("customerId") || "");
      const selectedCustomer = selectedCustomerId
        ? await prisma.user.findFirst({
            where: {
              OR: [
                { id: selectedCustomerId },
                { shopifyCustomerId: selectedCustomerId },
              ],
            },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              shopifyCustomerId: true,
            },
          })
        : null;
      const customerName =
        selectedCustomer
          ? [selectedCustomer.firstName, selectedCustomer.lastName]
              .filter(Boolean)
              .join(" ")
          : String(formData.get("customerName") || "").trim();
      const customerEmail =
        selectedCustomer?.email ||
        String(formData.get("customerEmail") || "").trim() ||
        null;
      const customerId =
        selectedCustomer?.shopifyCustomerId ||
        selectedCustomer?.id ||
        String(formData.get("customerNumber") || "").trim() ||
        null;

      await prisma.$transaction(async (tx) => {
        if (removeItemIds.size) {
          await tx.b2BOrderItem.deleteMany({
            where: { orderId: draft.id, id: { in: Array.from(removeItemIds) } },
          });
        }
        for (const item of updates) {
          await tx.b2BOrderItem.update({
            where: { id: item.id },
            data: {
              productTitle: item.productTitle,
              sku: item.sku || null,
              variantTitle: item.variantTitle || null,
              image: item.image || null,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              discount: item.discount,
              lineTotal: item.lineTotal,
            },
          });
        }
        for (const newItem of newItems) {
          await tx.b2BOrderItem.create({
            data: { ...newItem, orderId: draft.id },
          });
        }
        await tx.b2BOrder.update({
          where: { id: draft.id },
          data: {
            customerName: customerName || null,
            customerEmail,
            customerId,
            subtotal,
            discountTotal,
            taxAmount,
            shippingAmount,
            orderTotal,
            remainingBalance: orderTotal,
            notes: serializeDraftNotes({
              internalNotes: String(formData.get("internalNotes") || ""),
              customerNotes: String(formData.get("customerNotes") || ""),
              deliveryDetails: {
                locationName: String(formData.get("deliveryLocationName") || ""),
                address1: String(formData.get("deliveryAddress1") || ""),
                address2: String(formData.get("deliveryAddress2") || ""),
                city: String(formData.get("deliveryCity") || ""),
                province: String(formData.get("deliveryProvince") || ""),
                zip: String(formData.get("deliveryZip") || ""),
                country: String(formData.get("deliveryCountry") || ""),
                phone: String(formData.get("deliveryPhone") || ""),
              },
            }),
          },
        });
      });
      await logOrderActivity({
        orderId: draft.id,
        userId: user.id,
        action: "Draft Updated",
        message: "Draft details were updated.",
      });
      return redirect(`/support/drafts/${draft.id}?saved=1`);
    }

    if (intent === "save_details") {
      const selectedCustomerId = String(formData.get("customerId") || "");
      const selectedCustomer = selectedCustomerId
        ? await prisma.user.findFirst({
            where: {
              OR: [
                { id: selectedCustomerId },
                { shopifyCustomerId: selectedCustomerId },
              ],
            },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              shopifyCustomerId: true,
            },
          })
        : null;
      const customerName =
        selectedCustomer
          ? [selectedCustomer.firstName, selectedCustomer.lastName]
              .filter(Boolean)
              .join(" ")
          : String(formData.get("customerName") || "").trim();
      const customerEmail =
        selectedCustomer?.email ||
        String(formData.get("customerEmail") || "").trim() ||
        null;
      const customerId =
        selectedCustomer?.shopifyCustomerId ||
        selectedCustomer?.id ||
        String(formData.get("customerNumber") || "").trim() ||
        null;

      const deliveryData = {
        locationName: String(formData.get("deliveryLocationName") || ""),
        address1: String(formData.get("deliveryAddress1") || ""),
        address2: String(formData.get("deliveryAddress2") || ""),
        city: String(formData.get("deliveryCity") || ""),
        province: String(formData.get("deliveryProvince") || ""),
        zip: String(formData.get("deliveryZip") || ""),
        country: String(formData.get("deliveryCountry") || ""),
        phone: String(formData.get("deliveryPhone") || ""),
      };

      const currentNotes = parseDraftNotes(draft.notes);

      await prisma.b2BOrder.update({
        where: { id: draft.id },
        data: {
          customerName,
          customerEmail,
          customerId,
          notes: serializeDraftNotes({
            internalNotes: currentNotes.internalNotes,
            customerNotes: currentNotes.customerNotes,
            deliveryDetails: deliveryData,
          }),
        },
      });

      if (draft.shopifyOrderId && draft.company.shop.accessToken) {
        const shopDomain = draft.company.shop.shopDomain;
        const accessToken = draft.company.shop.accessToken;
        const draftOrderId = draft.shopifyOrderId.startsWith("gid://")
          ? draft.shopifyOrderId
          : `gid://shopify/DraftOrder/${draft.shopifyOrderId}`;

        const deliveryLines = [
          deliveryData.address1,
          deliveryData.address2,
          [deliveryData.city, deliveryData.province, deliveryData.zip].filter(Boolean).join(", "),
          deliveryData.country,
        ].filter(Boolean);

        const shopifyMutation = `#graphql
          mutation UpdateDraftCustomAttributes($id: ID!, $input: DraftOrderInput!) {
            draftOrderUpdate(id: $id, input: $input) {
              draftOrder {
                id
                shippingAddress {
                  address1
                  address2
                  city
                  province
                  zip
                  country
                  phone
                }
                customAttributes {
                  key
                  value
                }
              }
              userErrors {
                field
                message
              }
            }
          }
        `;

        const shopifyInput: any = {
          shippingAddress: {
            address1: deliveryData.address1 || undefined,
            address2: deliveryData.address2 || undefined,
            city: deliveryData.city || undefined,
            province: deliveryData.province || undefined,
            zip: deliveryData.zip || undefined,
            country: deliveryData.country || undefined,
            phone: deliveryData.phone || undefined,
          },
          customAttributes: [
            { key: "Delivery Location", value: deliveryData.locationName },
            { key: "Delivery Address", value: deliveryLines.join(", ") },
            { key: "Delivery Phone", value: deliveryData.phone },
            { key: "Customer Name", value: customerName },
            { key: "Customer Email", value: customerEmail || "" },
            { key: "Sales Agent Name", value: [user.firstName, user.lastName].filter(Boolean).join(" ") },
            { key: "Sales Agent Email", value: user.email },
          ],
        };

        await fetch(`https://${shopDomain}/admin/api/2025-01/graphql.json`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({
            query: shopifyMutation,
            variables: { id: draftOrderId, input: shopifyInput },
          }),
        });
      }

      await logOrderActivity({
        orderId: draft.id,
        userId: user.id,
        action: "Delivery Details Updated",
        message: "Delivery and customer details were saved.",
      });
      return redirect(`/support/drafts/${draft.id}?saved=1`);
    }

    if (intent === "duplicate_draft") {
      const duplicate = await prisma.b2BOrder.create({
        data: {
          companyId: draft.companyId,
          createdByUserId: user.id,
          shopId: draft.shopId,
          orderNumber: `DRAFT-${Date.now().toString().slice(-8)}`,
          orderTotal: draft.orderTotal,
          creditUsed: 0,
          userCreditUsed: 0,
          remainingBalance: draft.orderTotal,
          paymentStatus: "pending",
          orderStatus: "draft",
          customerName: draft.customerName,
          customerEmail: draft.customerEmail,
          customerId: draft.customerId,
          currencyCode: draft.currencyCode,
          subtotal: draft.subtotal,
          discountTotal: draft.discountTotal,
          taxAmount: draft.taxAmount,
          shippingAmount: draft.shippingAmount,
          notes: draft.notes,
          source: "Sales Portal Draft Duplicate",
          items: {
            create: draft.items.map((item) => ({
              productId: item.productId,
              productTitle: item.productTitle,
              variantId: item.variantId,
              variantTitle: item.variantTitle,
              sku: item.sku,
              image: item.image,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              discount: item.discount,
              lineTotal: item.lineTotal,
            })),
          },
        },
      });
      await logOrderActivity({
        orderId: duplicate.id,
        userId: user.id,
        action: "Draft Duplicated",
        message: `Created from ${getOrderNumber(draft)}.`,
      });
      return redirect(
        `/support/drafts/${duplicate.id}?duplicatedFrom=${encodeURIComponent(getOrderNumber(draft))}`,
      );
    }

    if (intent === "delete_draft") {
      await deleteShopifyDraftOrder(draft);
      await deleteDraftRecord(draft);
      return redirect(
        `/sales/portal/drafts?deletedDraft=${encodeURIComponent(getOrderNumber(draft))}`,
      );
    }

    if (intent === "convert_to_quote") {
      const customerId = await resolveCustomerId(draft);
      if (!customerId) {
        return Response.json(
          { error: "Add a customer before converting this draft to a quote." },
          { status: 400 },
        );
      }
      const notes = parseDraftNotes(draft.notes);
      const quote = await createQuoteFromCart({
        companyId: draft.companyId,
        salesAgentId: user.id,
        customerId,
        cartData: draftLineItems(draft),
        title: `${getOrderNumber(draft)} quote`,
        internalNotes: notes.internalNotes,
        customerNotes: notes.customerNotes,
        discountAmount: Number(draft.discountTotal),
        discountType: "FIXED_AMOUNT",
        shippingCost: Number(draft.shippingAmount),
        taxRate:
          Number(draft.subtotal) > 0
            ? (Number(draft.taxAmount) / Number(draft.subtotal)) * 100
            : 0,
        submit: false,
      });
      return redirect(
        `/sales/portal/company/${draft.companyId}/quotes/${quote.id}?created=1&quoteUrl=${encodeURIComponent(getQuoteUrl(request, quote))}`,
      );
    }

    if (intent === "convert_to_order") {
      if (!draft.shopifyOrderId) {
        return Response.json(
          {
            error:
              "This draft has no Shopify Draft Order id. Save it through the catalog flow before converting to an order.",
          },
          { status: 400 },
        );
      }
      if (draft.shopifyOrderId.startsWith("gid://shopify/Order/")) {
        return Response.json(
          { error: "This draft is already linked to a Shopify Order." },
          { status: 400 },
        );
      }
      const admin = draft.company.shop.accessToken
        ? await getAdminForShop(draft.company.shop.shopDomain)
        : null;
      if (!admin) {
        return Response.json(
          { error: "Shopify credentials are missing for this draft." },
          { status: 400 },
        );
      }
      const draftOrderId = draft.shopifyOrderId.startsWith("gid://")
        ? draft.shopifyOrderId
        : `gid://shopify/DraftOrder/${draft.shopifyOrderId}`;
      const completeData = await shopifyOrderGraphql<{
        draftOrderComplete: {
          draftOrder: null | {
            order: null | {
              id: string;
              name: string;
              totalPriceSet?: {
                shopMoney?: { amount?: string; currencyCode?: string };
              };
            };
          };
          userErrors: Array<{ field?: string[] | null; message: string }>;
        };
      }>({
        admin,
        operation: "CompleteSalesPortalDraftOrder",
        query: `#graphql
          mutation CompleteDraftOrder($id: ID!) {
            draftOrderComplete(id: $id) {
              draftOrder {
                order {
                  id
                  name
                  totalPriceSet { shopMoney { amount currencyCode } }
                }
              }
              userErrors { field message }
            }
          }
        `,
        variables: { id: draftOrderId },
      });
      assertNoShopifyUserErrors(
        "CompleteSalesPortalDraftOrder",
        completeData.draftOrderComplete.userErrors,
      );
      const createdOrder = completeData.draftOrderComplete.draftOrder?.order;
      if (!createdOrder?.id) {
        return Response.json(
          { error: "Shopify did not return a completed order." },
          { status: 400 },
        );
      }
      const verifiedOrder = await verifyShopifyOrder(admin, createdOrder.id);
      const orderTotal =
        Number(createdOrder.totalPriceSet?.shopMoney?.amount) ||
        Number(draft.orderTotal);
      await prisma.b2BOrder.update({
        where: { id: draft.id },
        data: {
          shopifyOrderId: verifiedOrder.id,
          orderNumber: verifiedOrder.name,
          orderStatus: "payment_pending",
          paymentStatus: "pending",
          orderTotal,
          remainingBalance: orderTotal,
          currencyCode:
            createdOrder.totalPriceSet?.shopMoney?.currencyCode ||
            draft.currencyCode,
        },
      });
      await logOrderActivity({
        orderId: draft.id,
        userId: user.id,
        action: "Draft Converted To Order",
        message: `Converted to ${verifiedOrder.name}.`,
      });
      return redirect(
        `/sales/portal/orders/${draft.id}?createdFrom=draft_conversion&sourceOrder=${encodeURIComponent(getOrderNumber(draft))}`,
      );
    }
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Draft action failed.",
      },
      { status: 400 },
    );
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
};

export default function DraftDetailsPage() {
  const data = useLoaderData<any>();
  const actionData = useActionData<ActionResponse>();
  const navigation = useNavigation();
  const draft = data.draft;
  const deliveryDetails = data.deliveryDetails as DeliveryDetails;
  const busy = navigation.state !== "idle";
  const pendingIntent = String(navigation.formData?.get("intent") || "");
  const submissionLock = useRef(false);
  const notificationTimerRef = useRef<number | null>(null);
  const [notification, setNotification] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(data.successMessage ? { type: "success", message: data.successMessage } : null);
  const [showProductModal, setShowProductModal] = useState(false);
  const [productQuery, setProductQuery] = useState("all");
  const [productResults, setProductResults] = useState<any[]>([]);
  const [isFetchingProducts, setIsFetchingProducts] = useState(false);
  const [newProductRows, setNewProductRows] = useState<NewProductRow[]>([]);

  const companyLocations = data.companyLocations || [];
  const initialLocationMatch = companyLocations.find(
    (loc: any) => loc.name === deliveryDetails.locationName,
  );
  const [selectedDeliveryLocationId, setSelectedDeliveryLocationId] = useState<string>(
    initialLocationMatch?.id || "",
  );
  const [deliveryLocationNameValue, setDeliveryLocationNameValue] = useState<string>(
    deliveryDetails.locationName || "",
  );
  const [deliveryPhoneValue, setDeliveryPhoneValue] = useState<string>(
    deliveryDetails.phone || "",
  );
  const [deliveryAddress1Value, setDeliveryAddress1Value] = useState<string>(
    deliveryDetails.addressLines?.[0] || "",
  );
  const [deliveryAddress2Value, setDeliveryAddress2Value] = useState<string>(
    deliveryDetails.addressLines?.[1] || "",
  );
  type ShippingCountryOption = {
    value: string;
    label: string;
    provinces: Array<{ value: string; label: string }>;
  };

  const [deliveryCityValue, setDeliveryCityValue] = useState<string>(
    deliveryDetails.addressLines?.[2] || "",
  );
  const [deliveryProvinceValue, setDeliveryProvinceValue] = useState<string>(
    deliveryDetails.addressLines?.[3] || "",
  );
  const [deliveryZipValue, setDeliveryZipValue] = useState<string>(
    deliveryDetails.addressLines?.[4] || "",
  );
  const [deliveryCountryValue, setDeliveryCountryValue] = useState<string>(
    deliveryDetails.addressLines?.[5] || "",
  );
  const [shippingCountryOptions, setShippingCountryOptions] = useState<ShippingCountryOption[]>(
    [],
  );

  const selectedDeliveryCountry = shippingCountryOptions.find((country) => {
    const rawValue = deliveryCountryValue.trim();
    return (
      country.value === rawValue ||
      country.label.toLowerCase() === rawValue.toLowerCase()
    );
  });
  const deliveryProvinceOptions = selectedDeliveryCountry?.provinces ?? [];

  useEffect(() => {
    if (navigation.state === "idle") submissionLock.current = false;
  }, [navigation.state]);

  useEffect(() => {
    if (actionData?.error) {
      setNotification({ type: "error", message: actionData.error });
    } else if (actionData?.success) {
      setNotification({
        type: "success",
        message: actionData.message || "Draft updated successfully.",
      });
    }
  }, [actionData]);

  useEffect(() => {
    let active = true;
    fetch("/api/proxy/shipping-zones")
      .then(async (response) => {
        if (!active) return;
        if (!response.ok) return [];
        const payload = await response.json();
        return Array.isArray(payload?.countries) ? payload.countries : [];
      })
      .then((countries) => {
        if (!active) return;
        setShippingCountryOptions(countries);
      })
      .catch(() => {
        if (!active) return;
        setShippingCountryOptions([]);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!deliveryCountryValue || shippingCountryOptions.length === 0) return;
    const match = shippingCountryOptions.find(
      (country) =>
        country.value === deliveryCountryValue ||
        country.label.toLowerCase() === deliveryCountryValue.toLowerCase(),
    );
    if (match && match.value !== deliveryCountryValue) {
      setDeliveryCountryValue(match.value);
    }
  }, [deliveryCountryValue, shippingCountryOptions]);

  useEffect(() => {
    if (!deliveryProvinceValue || !selectedDeliveryCountry) return;
    const match = selectedDeliveryCountry.provinces.find(
      (province) =>
        province.value === deliveryProvinceValue ||
        province.label.toLowerCase() === deliveryProvinceValue.toLowerCase(),
    );
    if (match && match.value !== deliveryProvinceValue) {
      setDeliveryProvinceValue(match.value);
    }
  }, [deliveryProvinceValue, selectedDeliveryCountry]);

  useEffect(() => {
    if (!selectedDeliveryLocationId) return;
    const location = companyLocations.find((loc: any) => loc.id === selectedDeliveryLocationId);
    if (!location) return;

    const shipping = location.shippingAddress || {};
    setDeliveryLocationNameValue(location.name || "");
    setDeliveryAddress1Value(shipping.address1 || "");
    setDeliveryAddress2Value(shipping.address2 || "");
    setDeliveryCityValue(shipping.city || "");
    setDeliveryProvinceValue(shipping.province || "");
    setDeliveryZipValue(shipping.zip || "");
    setDeliveryCountryValue(shipping.country || "");
    setDeliveryPhoneValue(shipping.phone || location.phone || "");
  }, [selectedDeliveryLocationId, companyLocations]);

  useEffect(() => {
    if (data.successMessage) {
      setNotification({ type: "success", message: data.successMessage });
    }
  }, [data.successMessage]);

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

  const fetchProducts = async (query = "all") => {
    setIsFetchingProducts(true);
    try {
      const normalizedQuery = String(query || "").trim() || "all";
      const url = `/api/sales-product-search?q=${encodeURIComponent(normalizedQuery)}&companyId=${encodeURIComponent(draft.company.id)}`;
      const res = await fetch(url);
      if (!res.ok) return setProductResults([]);
      const data = await res.json();
      setProductResults(data.products || []);
    } catch {
      setProductResults([]);
    } finally {
      setIsFetchingProducts(false);
    }
  };

  useEffect(() => {
    if (!showProductModal) return;
    fetchProducts(productQuery || "all");
  }, [showProductModal, productQuery, draft.company.id]);

  const handleSelectProductVariant = (product: any, variant: any) => {
    const selected = {
      productId: product.id || null,
      productTitle: product.title || "",
      sku: variant?.sku || "",
      variantTitle: variant?.title || "Default variant",
      variantId: variant?.id || "",
      image: product.image || "",
      unitPrice: Number(variant?.price || 0),
      discount: 0,
      quantity: 1,
      rowKey: String(Date.now()),
    };
    setNewProductRows((rows) => [...rows, selected]);
    setShowProductModal(false);
  };

  const removePendingProduct = (rowKey: string) => {
    setNewProductRows((rows) => rows.filter((row) => row.rowKey !== rowKey));
  };

  const guardSubmission = (event: React.FormEvent<HTMLFormElement>) => {
    if (submissionLock.current || busy) {
      event.preventDefault();
      return false;
    }
    submissionLock.current = true;
    setNotification(null);
    return true;
  };
  const money = (amount: string | number) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: draft.currencyCode,
    }).format(Number(amount) || 0);

  return (
    <SalesPortalLayout
      company={draft.company}
      user={data.user}
      activePage="drafts"
      orderCount={data.counts.orders}
      draftCount={data.counts.drafts}
      quoteCount={data.counts.quotes}
    >
      <Link
        to="/sales/portal/drafts"
        aria-disabled={busy}
        style={{
          ...styles.backLink,
          opacity: busy ? 0.55 : 1,
          pointerEvents: busy ? "none" : "auto",
        }}
      >
        Back to Drafts
      </Link>
      <SalesPortalHeader
        title={draft.orderNumber}
        subtitle="Draft Details"
        companyId={draft.company.id}
        companies={data.companies}
        actions={
          <>
            <DraftAction
              intent="duplicate_draft"
              label="Duplicate Draft"
              disabled={busy}
              pending={pendingIntent === "duplicate_draft"}
              onSubmit={guardSubmission}
            />
            <DraftAction
              intent="convert_to_quote"
              label="Convert To Quote"
              disabled={busy}
              pending={pendingIntent === "convert_to_quote"}
              onSubmit={guardSubmission}
            />
            <DraftAction
              intent="convert_to_order"
              label="Convert To Order"
              disabled={busy}
              pending={pendingIntent === "convert_to_order"}
              onSubmit={guardSubmission}
              primary
            />
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

      <Form method="post" onSubmit={guardSubmission}>
        <input type="hidden" name="intent" value="save_changes" />
        <div className="draft-detail-grid" style={styles.grid}>
          <section style={styles.mainColumn}>
            <Card title="Customer Information">
              <div className="draft-info-grid" style={styles.infoGrid}>
                <label style={styles.label}>
                  Company
                  <input readOnly value={draft.company.name} style={styles.input} />
                </label>
                <label style={styles.label}>
                  Update Customer
                  <select
                    name="customerId"
                    defaultValue={draft.customerId || ""}
                    style={styles.input}
                  >
                    <option value="">Keep / manual customer</option>
                    {data.companyUsers.map((customer: any) => (
                      <option
                        key={customer.id}
                        value={customer.shopifyCustomerId || customer.id}
                      >
                        {[customer.firstName, customer.lastName]
                          .filter(Boolean)
                          .join(" ") || customer.email}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={styles.label}>
                  Customer Name
                  <input
                    name="customerName"
                    defaultValue={draft.customerName || ""}
                    style={styles.input}
                  />
                </label>
                <label style={styles.label}>
                  Customer Number
                  <input
                    name="customerNumber"
                    defaultValue={draft.customerId || ""}
                    style={styles.input}
                  />
                </label>
                <label style={styles.label}>
                  Email
                  <input
                    type="email"
                    name="customerEmail"
                    defaultValue={draft.customerEmail || ""}
                    style={styles.input}
                  />
                </label>
              </div>
            </Card>

            <section style={styles.card}>
              <h2 style={styles.cardTitle}>Delivery Details</h2>
              <div className="draft-delivery-grid" style={styles.deliveryGrid}>
                <label style={styles.label}>
                  Saved location
                  <select
                    name="deliveryLocationId"
                    value={selectedDeliveryLocationId}
                    onChange={(e) => setSelectedDeliveryLocationId(e.target.value)}
                    style={styles.input}
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
                  />
                </label>
                <label style={styles.label}>
                  Address line 1
                  <input
                    name="deliveryAddress1"
                    value={deliveryAddress1Value}
                    onChange={(e) => {
                      setDeliveryAddress1Value(e.target.value);
                      if (selectedDeliveryLocationId) setSelectedDeliveryLocationId("");
                    }}
                    placeholder="Street address"
                    style={styles.input}
                  />
                </label>
                <label style={styles.label}>
                  Address line 2
                  <input
                    name="deliveryAddress2"
                    value={deliveryAddress2Value}
                    onChange={(e) => {
                      setDeliveryAddress2Value(e.target.value);
                      if (selectedDeliveryLocationId) setSelectedDeliveryLocationId("");
                    }}
                    placeholder="Apartment, suite, unit, etc."
                    style={styles.input}
                  />
                </label>
                <label style={styles.label}>
                  Country
                  <select
                    name="deliveryCountry"
                    value={deliveryCountryValue}
                    onChange={(e) => {
                      setDeliveryCountryValue(e.target.value);
                      if (selectedDeliveryLocationId) setSelectedDeliveryLocationId("");
                      setDeliveryProvinceValue("");
                    }}
                    style={{ ...styles.input, appearance: "none" as const }}
                  >
                    <option value="">Select country</option>
                    {shippingCountryOptions.map((country) => (
                      <option key={country.value} value={country.value}>
                        {country.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={styles.label}>
                  State / Province
                  {deliveryProvinceOptions.length > 0 ? (
                    <select
                      name="deliveryProvince"
                      value={deliveryProvinceValue}
                      onChange={(e) => {
                        setDeliveryProvinceValue(e.target.value);
                        if (selectedDeliveryLocationId) setSelectedDeliveryLocationId("");
                      }}
                      style={{ ...styles.input, appearance: "none" as const }}
                    >
                      <option value="">Select state / province</option>
                      {deliveryProvinceOptions.map((province) => (
                        <option key={province.value} value={province.value}>
                          {province.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      name="deliveryProvince"
                      value={deliveryProvinceValue}
                      onChange={(e) => {
                        setDeliveryProvinceValue(e.target.value);
                        if (selectedDeliveryLocationId) setSelectedDeliveryLocationId("");
                      }}
                      placeholder="State or province"
                      style={styles.input}
                    />
                  )}
                </label>
                <label style={styles.label}>
                  City
                  <input
                    name="deliveryCity"
                    value={deliveryCityValue}
                    onChange={(e) => {
                      setDeliveryCityValue(e.target.value);
                      if (selectedDeliveryLocationId) setSelectedDeliveryLocationId("");
                    }}
                    placeholder="City"
                    style={styles.input}
                  />
                </label>
                <label style={styles.label}>
                  Postal code
                  <input
                    name="deliveryZip"
                    value={deliveryZipValue}
                    onChange={(e) => {
                      setDeliveryZipValue(e.target.value);
                      if (selectedDeliveryLocationId) setSelectedDeliveryLocationId("");
                    }}
                    placeholder="Zip / postal code"
                    style={styles.input}
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
              <div style={{ marginTop: 16 }}>
                <button
                  type="submit"
                  name="intent"
                  value="save_details"
                  disabled={busy}
                  aria-busy={pendingIntent === "save_details"}
                  style={{ ...disabledButtonStyle(styles.primaryButton, busy), width: "100%" }}
                >
                  {pendingIntent === "save_details" && <Spinner />}
                  {pendingIntent === "save_details" ? "Saving Details..." : "Save Detail"}
                </button>
              </div>
            </section>

            <div style={{ ...styles.card, padding: 0, overflow: "hidden" }}>
              <div style={styles.cardHeader}>
                <h2 style={styles.cardTitle}>Product Information</h2>
                <button
                  type="button"
                  onClick={() => setShowProductModal(true)}
                  style={{
                    ...styles.secondaryButton,
                    padding: "8px 12px",
                    fontSize: 13,
                  }}
                >
                  + Add Product
                </button>
              </div>
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      {[
                        "Product",
                        "SKU",
                        "Variant",
                        "Quantity",
                        "Unit Price",
                        "Discount",
                        "Line Total",
                      ].map((heading) => (
                        <th key={heading} style={styles.th}>
                          {heading}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {draft.items.map((item: any) => (
                      <tr key={item.id}>
                        <td style={styles.td}>
                          <input type="hidden" name="itemId" value={item.id} />
                          <div style={styles.productCell}>
                            {item.image ? (
                              <img
                                src={item.image}
                                alt=""
                                style={styles.productImage}
                              />
                            ) : (
                              <span style={styles.imagePlaceholder} />
                            )}
                            <div style={styles.productInputs}>
                              <input
                                name={`productTitle_${item.id}`}
                                defaultValue={item.productTitle}
                                style={styles.input}
                              />
                              <input
                                name={`image_${item.id}`}
                                defaultValue={item.image || ""}
                                placeholder="Image URL"
                                style={styles.smallInput}
                              />
                            </div>
                          </div>
                        </td>
                        <td style={styles.td}>
                          <input
                            name={`sku_${item.id}`}
                            defaultValue={item.sku || ""}
                            style={styles.smallInput}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            name={`variantTitle_${item.id}`}
                            defaultValue={item.variantTitle || ""}
                            style={styles.smallInput}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            type="number"
                            min="1"
                            name={`quantity_${item.id}`}
                            defaultValue={item.quantity}
                            style={styles.numberInput}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            name={`unitPrice_${item.id}`}
                            defaultValue={item.unitPrice}
                            style={styles.numberInput}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            name={`discount_${item.id}`}
                            defaultValue={item.discount}
                            style={styles.numberInput}
                          />
                        </td>
                        <td style={styles.td}>
                          <strong>{money(item.lineTotal)}</strong>
                        </td>

                      </tr>
                    ))}
                    {newProductRows.map((row) => (
                      <tr key={row.rowKey} style={{ background: "#f8f5ff" }}>
                        <td style={styles.td}>
                          <div style={styles.productCell}>
                            <span style={{ display: "none" }}>
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
                            </span>
                            {row.image ? (
                              <img src={row.image} alt="" style={styles.productImage} />
                            ) : (
                              <span style={styles.imagePlaceholder} />
                            )}
                            <div style={styles.productInputs}>
                              <div style={{ fontWeight: 700 }}>{row.productTitle}</div>
                              <div style={{ color: "#6b7280", fontSize: 12 }}>Pending save</div>
                            </div>
                          </div>
                        </td>
                        <td style={styles.td}>{row.sku || "N/A"}</td>
                        <td style={styles.td}>{row.variantTitle || "Default variant"}</td>
                        <td style={styles.td}>{row.quantity}</td>
                        <td style={styles.td}>{money(row.unitPrice)}</td>
                        <td style={styles.td}>{money(row.discount)}</td>
                        <td style={styles.td}>
                          <strong>{money(Math.max(0, row.quantity * row.unitPrice - row.discount))}</strong>
                        </td>
                        <td style={styles.td}>
                          <button
                            type="button"
                            onClick={() => removePendingProduct(row.rowKey)}
                            style={{
                              border: "1px solid #d1d5db",
                              borderRadius: 8,
                              background: "#fff",
                              color: "#374151",
                              padding: "6px 10px",
                              fontSize: 12,
                              cursor: "pointer",
                            }}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <Card title="Notes">
              <div className="draft-notes-grid" style={styles.notesGrid}>
                <label style={styles.label}>
                  Internal Notes
                  <textarea
                    name="internalNotes"
                    defaultValue={draft.internalNotes}
                    style={styles.textarea}
                  />
                </label>
                <label style={styles.label}>
                  Customer Notes
                  <textarea
                    name="customerNotes"
                    defaultValue={draft.customerNotes}
                    style={styles.textarea}
                  />
                </label>
              </div>
            </Card>
          </section>

          <aside className="draft-detail-side" style={styles.sideColumn}>
            <Card title="Pricing Summary">
              <SummaryInput label="Subtotal" value={draft.subtotal} readOnly />
              <SummaryInput label="Discounts" name="discountTotal" value={draft.discountTotal} />
              <SummaryInput label="Taxes" name="taxAmount" value={draft.taxAmount} />
              <SummaryInput
                label="Shipping"
                name="shippingAmount"
                value={draft.shippingAmount}
              />
              <div style={styles.totalRow}>
                <strong>Grand Total</strong>
                <strong>{money(draft.orderTotal)}</strong>
              </div>
            </Card>

            <Card title="Draft Actions">
              <div style={styles.buttonStack}>
                <button
                  type="submit"
                  disabled={busy}
                  aria-busy={pendingIntent === "save_changes"}
                  style={disabledButtonStyle(styles.primaryButton, busy)}
                >
                  {pendingIntent === "save_changes" && <Spinner />}
                  {pendingIntent === "save_changes" ? "Saving Changes..." : "Save Changes"}
                </button>
              </div>
            </Card>
          </aside>
        </div>
      </Form>

      <Card title="More Actions">
        <div style={styles.actionRow}>
          <DraftAction
            intent="duplicate_draft"
            label="Duplicate Draft"
            disabled={busy}
            pending={pendingIntent === "duplicate_draft"}
            onSubmit={guardSubmission}
          />
          <DraftAction
            intent="convert_to_quote"
            label="Convert To Quote"
            disabled={busy}
            pending={pendingIntent === "convert_to_quote"}
            onSubmit={guardSubmission}
          />
          <DraftAction
            intent="convert_to_order"
            label="Convert To Order"
            disabled={busy}
            pending={pendingIntent === "convert_to_order"}
            onSubmit={guardSubmission}
            primary
          />
          <DraftAction
            intent="delete_draft"
            label="Delete Draft"
            disabled={busy}
            pending={pendingIntent === "delete_draft"}
            onSubmit={guardSubmission}
            danger
            confirmMessage="Delete this draft permanently?"
          />
        </div>
      </Card>

      {showProductModal && (
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
          onClick={() => setShowProductModal(false)}
        >
          <div
            style={{
              width: "90vw",
              maxWidth: 900,
              maxHeight: "90vh",
              overflow: "auto",
              background: "#fff",
              borderRadius: 8,
              padding: 18,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <h3 style={{ margin: 0 }}>Add Product</h3>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  placeholder="Search products"
                  value={productQuery}
                  onChange={(e) => setProductQuery(e.target.value)}
                  style={{ ...styles.input, width: 260 }}
                />
                <button
                  type="button"
                  onClick={() => fetchProducts(productQuery)}
                  style={styles.secondaryButton}
                >
                  Search
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setProductQuery("all");
                    fetchProducts("all");
                  }}
                  style={styles.secondaryButton}
                >
                  Show All
                </button>
                <button
                  type="button"
                  onClick={() => setShowProductModal(false)}
                  style={styles.secondaryButton}
                >
                  Close
                </button>
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              {productResults.length === 0 ? (
                <p style={styles.muted}>No products found. Try a different search or click Show All.</p>
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  {productResults.map((product: any) => (
                    <div
                      key={product.id}
                      style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, display: "flex", alignItems: "center", justifyContent: "space-between" }}
                    >
                      <div>
                        <div style={{ fontWeight: 700 }}>{product.title}</div>
                        <div style={{ color: "#6b7280", fontSize: 13 }}>{product.vendor || ""}</div>
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        {(product.variants || []).map((variant: any) => (
                          <button
                            key={variant.id}
                            type="button"
                            onClick={() => handleSelectProductVariant(product, variant)}
                            style={styles.secondaryButton}
                          >
                            Add {variant.title || "Variant"}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      <style>{responsiveCss}</style>
    </SalesPortalLayout>
  );
}

function DraftAction({
  intent,
  label,
  disabled,
  pending,
  onSubmit,
  primary,
  danger,
  confirmMessage,
}: {
  intent: string;
  label: string;
  disabled?: boolean;
  pending?: boolean;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => boolean;
  primary?: boolean;
  danger?: boolean;
  confirmMessage?: string;
}) {
  const buttonStyle = primary
    ? styles.primaryButton
    : danger
      ? styles.dangerButton
      : styles.secondaryButton;

  return (
    <Form
      method="post"
      style={{ display: "inline-flex" }}
      onSubmit={(event) => {
        if (confirmMessage && !confirm(confirmMessage)) {
          event.preventDefault();
          return;
        }
        onSubmit(event);
      }}
    >
      <input type="hidden" name="intent" value={intent} />
      <button
        type="submit"
        disabled={disabled}
        aria-busy={pending}
        style={disabledButtonStyle(buttonStyle, Boolean(disabled))}
      >
        {pending && <Spinner dark={!primary} />}
        {pending ? pendingLabel(intent) : label}
      </button>
    </Form>
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

function pendingLabel(intent: string) {
  const labels: Record<string, string> = {
    duplicate_draft: "Duplicating Draft...",
    convert_to_quote: "Converting To Quote...",
    convert_to_order: "Converting To Order...",
    delete_draft: "Deleting Draft...",
  };
  return labels[intent] || "Processing...";
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

function SummaryInput({
  label,
  name,
  value,
  readOnly,
}: {
  label: string;
  name?: string;
  value: string;
  readOnly?: boolean;
}) {
  return (
    <label style={styles.summaryInputRow}>
      <span>{label}</span>
      <input
        name={name}
        readOnly={readOnly}
        defaultValue={value}
        style={styles.summaryInput}
        type="number"
        step="0.01"
        min="0"
      />
    </label>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section style={styles.card}>
      <h2 style={styles.cardTitle}>{title}</h2>
      {children}
    </section>
  );
}

function DeliveryDetailsCard({
  deliveryDetails,
}: {
  deliveryDetails: DeliveryDetails;
}) {
  return (
    <Card title="Delivery Details">
      <div className="draft-delivery-grid" style={styles.deliveryGrid}>
        <div>
          <span style={styles.metaLabel}>Location</span>
          <strong style={styles.infoValue}>
            {deliveryDetails.locationName || "Not captured"}
          </strong>
        </div>
        <div>
          <span style={styles.metaLabel}>
            {deliveryDetails.source === "company_location"
              ? "Location Address"
              : "Delivery Address"}
          </span>
          {deliveryDetails.addressLines.length > 0 ? (
            <address style={styles.addressText}>
              {deliveryDetails.addressLines.map((line) => (
                <span key={line}>{line}</span>
              ))}
            </address>
          ) : (
            <p style={styles.muted}>
              Delivery address was not captured for this draft.
            </p>
          )}
        </div>
        {deliveryDetails.phone && (
          <div>
            <span style={styles.metaLabel}>Phone</span>
            <strong style={styles.infoValue}>{deliveryDetails.phone}</strong>
          </div>
        )}
      </div>
    </Card>
  );
}

const responsiveCss = `
  @keyframes draft-action-spin { to { transform: rotate(360deg); } }
  .draft-detail-grid { align-items: start; }
  @media (max-width: 1180px) {
    .draft-detail-grid { grid-template-columns: minmax(0, 1fr) !important; }
    .draft-detail-side { position: static !important; }
  }
  @media (max-width: 760px) {
    .draft-info-grid, .draft-notes-grid, .draft-delivery-grid { grid-template-columns: minmax(0, 1fr) !important; }
  }
`;

const styles: Record<string, React.CSSProperties> = {
  backLink: {
    display: "inline-flex",
    marginBottom: 7,
    color: "#2c6ecb",
    textDecoration: "none",
    fontSize: 13,
    fontWeight: 600,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) 340px",
    gap: 20,
  },
  mainColumn: { display: "flex", flexDirection: "column", gap: 20 },
  sideColumn: {
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
    padding: 18,
    marginBottom: 20,
  },
  cardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "16px 18px",
    borderBottom: "1px solid #e1e3e5",
  },
  cardTitle: { margin: "0 0 14px", fontSize: 16, color: "#202223" },
  muted: {
    color: "#6d7175",
    fontSize: 13,
  },
  infoGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 14,
  },
  deliveryGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 14,
  },
  metaLabel: {
    display: "block",
    marginBottom: 4,
    color: "#6d7175",
    fontSize: 12,
  },
  infoValue: {
    color: "#202223",
    fontSize: 13,
  },
  addressText: {
    display: "flex",
    flexDirection: "column",
    gap: 3,
    margin: 0,
    color: "#202223",
    fontSize: 13,
    fontStyle: "normal",
    lineHeight: 1.45,
  },
  notesGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 14,
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    color: "#374151",
    fontSize: 13,
    fontWeight: 600,
  },
  input: {
    width: "100%",
    border: "1px solid #d1d5db",
    borderRadius: 8,
    padding: "9px 10px",
    font: "inherit",
    background: "#fff",
  },
  smallInput: {
    width: "100%",
    border: "1px solid #d1d5db",
    borderRadius: 6,
    padding: "7px 8px",
    font: "inherit",
    fontSize: 12,
    background: "#fff",
    marginTop: 6,
  },
  numberInput: {
    width: 94,
    border: "1px solid #d1d5db",
    borderRadius: 6,
    padding: "7px 8px",
    font: "inherit",
  },
  textarea: {
    minHeight: 120,
    border: "1px solid #d1d5db",
    borderRadius: 8,
    padding: 10,
    font: "inherit",
    resize: "vertical",
  },
  tableWrap: { overflowX: "auto" },
  table: { width: "100%", borderCollapse: "collapse" },
  th: {
    textAlign: "left",
    color: "#6d7175",
    fontSize: 12,
    fontWeight: 600,
    padding: "10px 12px",
    borderBottom: "1px solid #e1e3e5",
    whiteSpace: "nowrap",
    background: "#f9fafb",
  },
  td: {
    padding: 12,
    verticalAlign: "top",
    borderBottom: "1px solid #f1f1f1",
    fontSize: 13,
  },
  productCell: { display: "flex", gap: 10, minWidth: 260 },
  productInputs: { flex: 1, minWidth: 0 },
  productImage: {
    width: 52,
    height: 52,
    borderRadius: 8,
    objectFit: "cover",
    border: "1px solid #e1e3e5",
  },
  imagePlaceholder: {
    width: 52,
    height: 52,
    borderRadius: 8,
    background: "#f3f4f6",
    border: "1px solid #e1e3e5",
    display: "inline-block",
    flexShrink: 0,
  },
  checkLabel: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    color: "#b91c1c",
    fontSize: 12,
    fontWeight: 600,
  },
  summaryInputRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 12,
    fontSize: 14,
    color: "#4b5563",
  },
  summaryInput: {
    width: 130,
    border: "1px solid #d1d5db",
    borderRadius: 6,
    padding: "7px 8px",
    textAlign: "right",
    font: "inherit",
  },
  totalRow: {
    display: "flex",
    justifyContent: "space-between",
    borderTop: "1px solid #e1e3e5",
    marginTop: 12,
    paddingTop: 14,
    fontSize: 16,
  },
  buttonStack: { display: "flex", flexDirection: "column", gap: 10 },
  actionRow: { display: "flex", flexWrap: "wrap", gap: 10 },
  primaryButton: {
    border: "1px solid #111827",
    borderRadius: 8,
    background: "#111827",
    color: "#fff",
    padding: "10px 14px",
    fontWeight: 700,
    cursor: "pointer",
  },
  secondaryButton: {
    border: "1px solid #d1d5db",
    borderRadius: 8,
    background: "#fff",
    color: "#374151",
    padding: "10px 14px",
    fontWeight: 700,
    cursor: "pointer",
  },
  dangerButton: {
    border: "1px solid #fecaca",
    borderRadius: 8,
    background: "#fff",
    color: "#b91c1c",
    padding: "10px 14px",
    fontWeight: 700,
    cursor: "pointer",
  },
  success: {
    border: "1px solid #a7f3d0",
    background: "#ecfdf5",
    color: "#065f46",
    fontSize: 13,
  },
  error: {
    border: "1px solid #fecaca",
    background: "#fef2f2",
    color: "#991b1b",
    fontSize: 13,
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
    animation: "draft-action-spin 0.8s linear infinite",
    flexShrink: 0,
  },
};
