import type React from "react";
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
  salesPortalButtonStyles,
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
import { getAdminForShop } from "app/shopify.server";
import {
  assertNoShopifyUserErrors,
  shopifyOrderGraphql,
  verifyShopifyOrder,
} from "app/services/shopify-order-creation.server";

type DraftNotes = {
  internalNotes: string;
  customerNotes: string;
};

function parseDraftNotes(notes?: string | null): DraftNotes {
  if (!notes) return { internalNotes: "", customerNotes: "" };
  try {
    const parsed = JSON.parse(notes);
    if (parsed && typeof parsed === "object") {
      return {
        internalNotes: String(parsed.internalNotes || ""),
        customerNotes: String(parsed.customerNotes || ""),
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
    companyUsers,
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
  const intent = String(formData.get("intent") || "");

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

      const newProductTitle = String(formData.get("newProductTitle") || "").trim();
      const newQuantity = Math.max(1, numberField(formData, "newQuantity", 1));
      const newUnitPrice = Math.max(0, numberField(formData, "newUnitPrice"));
      const newDiscount = Math.max(0, numberField(formData, "newDiscount"));
      const newItem =
        newProductTitle || newUnitPrice > 0
          ? {
              productId: String(formData.get("newProductId") || "") || null,
              productTitle: newProductTitle || "Product",
              variantId: String(formData.get("newVariantId") || "") || null,
              variantTitle: String(formData.get("newVariantTitle") || "") || null,
              sku: String(formData.get("newSku") || "") || null,
              image: String(formData.get("newImage") || "") || null,
              quantity: newQuantity,
              unitPrice: newUnitPrice,
              discount: newDiscount,
              lineTotal: Math.max(0, newQuantity * newUnitPrice - newDiscount),
            }
          : null;

      const subtotal = updates.reduce(
        (sum, item) => sum + item.quantity * item.unitPrice,
        newItem ? newItem.quantity * newItem.unitPrice : 0,
      );
      const lineDiscountTotal = updates.reduce(
        (sum, item) => sum + item.discount,
        newItem ? newItem.discount : 0,
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
        if (newItem) {
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
      return redirect(`/support/drafts/${duplicate.id}`);
    }

    if (intent === "delete_draft") {
      await deleteShopifyDraftOrder(draft);
      await deleteDraftRecord(draft);
      return redirect("/sales/portal/drafts");
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
          mutation CompleteDraftOrder($id: ID!, $paymentPending: Boolean) {
            draftOrderComplete(id: $id, paymentPending: $paymentPending) {
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
        variables: { id: draftOrderId, paymentPending: true },
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
      return redirect(`/sales/portal/orders/${draft.id}`);
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
  const actionData = useActionData<any>();
  const navigation = useNavigation();
  const draft = data.draft;
  const busy = navigation.state !== "idle";
  const saved =
    typeof window === "undefined"
      ? false
      : new URLSearchParams(window.location.search).get("saved") === "1";
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
      <Link to="/sales/portal/drafts" style={styles.backLink}>
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
            />
            <DraftAction
              intent="convert_to_quote"
              label="Convert To Quote"
              disabled={busy}
            />
            <DraftAction
              intent="convert_to_order"
              label="Convert To Order"
              disabled={busy}
              primary
            />
          </>
        }
      />

      {saved && <div style={styles.success}>Draft changes saved.</div>}
      {actionData?.error && <div style={styles.error}>{actionData.error}</div>}

      <Form method="post">
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

            <div style={{ ...styles.card, padding: 0, overflow: "hidden" }}>
              <div style={styles.cardHeader}>
                <h2 style={styles.cardTitle}>Product Information</h2>
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
                        "Remove",
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
                        <td style={styles.td}>
                          <label style={styles.checkLabel}>
                            <input
                              type="checkbox"
                              name="removeItemId"
                              value={item.id}
                            />
                            Remove
                          </label>
                        </td>
                      </tr>
                    ))}
                    {/* <tr>
                      <td style={styles.td}>
                        <div style={styles.productInputs}>
                          <input
                            name="newProductTitle"
                            placeholder="New product name"
                            style={styles.input}
                          />
                          <input
                            name="newImage"
                            placeholder="Image URL"
                            style={styles.smallInput}
                          />
                          <input
                            name="newProductId"
                            placeholder="Product ID"
                            style={styles.smallInput}
                          />
                        </div>
                      </td>
                      <td style={styles.td}>
                        <input name="newSku" placeholder="SKU" style={styles.smallInput} />
                      </td>
                      <td style={styles.td}>
                        <input
                          name="newVariantTitle"
                          placeholder="Variant"
                          style={styles.smallInput}
                        />
                        <input
                          name="newVariantId"
                          placeholder="Variant ID"
                          style={styles.smallInput}
                        />
                      </td>
                      <td style={styles.td}>
                        <input
                          type="number"
                          min="1"
                          name="newQuantity"
                          defaultValue="1"
                          style={styles.numberInput}
                        />
                      </td>
                      <td style={styles.td}>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          name="newUnitPrice"
                          defaultValue="0"
                          style={styles.numberInput}
                        />
                      </td>
                      <td style={styles.td}>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          name="newDiscount"
                          defaultValue="0"
                          style={styles.numberInput}
                        />
                      </td>
                      <td colSpan={2} style={styles.td}>
                        Add this product on Save Changes
                      </td>
                    </tr> */}
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
                <button disabled={busy} style={styles.primaryButton}>
                  Save Changes
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
          />
          <DraftAction
            intent="convert_to_quote"
            label="Convert To Quote"
            disabled={busy}
          />
          <DraftAction
            intent="convert_to_order"
            label="Convert To Order"
            disabled={busy}
            primary
          />
          <DraftAction
            intent="delete_draft"
            label="Delete Draft"
            disabled={busy}
            danger
            confirmMessage="Delete this draft permanently?"
          />
        </div>
      </Card>
      <style>{responsiveCss}</style>
    </SalesPortalLayout>
  );
}

function DraftAction({
  intent,
  label,
  disabled,
  primary,
  danger,
  confirmMessage,
}: {
  intent: string;
  label: string;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
  confirmMessage?: string;
}) {
  return (
    <Form
      method="post"
      style={{ display: "inline-flex" }}
      onSubmit={(event) => {
        if (confirmMessage && !confirm(confirmMessage)) event.preventDefault();
      }}
    >
      <input type="hidden" name="intent" value={intent} />
      <button
        disabled={disabled}
        style={
          primary
            ? styles.primaryButton
            : danger
              ? styles.dangerButton
              : styles.secondaryButton
        }
      >
        {label}
      </button>
    </Form>
  );
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

const responsiveCss = `
  .draft-detail-grid { align-items: start; }
  @media (max-width: 1180px) {
    .draft-detail-grid { grid-template-columns: minmax(0, 1fr) !important; }
    .draft-detail-side { position: static !important; }
  }
  @media (max-width: 760px) {
    .draft-info-grid, .draft-notes-grid { grid-template-columns: minmax(0, 1fr) !important; }
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
    padding: "16px 18px",
    borderBottom: "1px solid #e1e3e5",
  },
  cardTitle: { margin: "0 0 14px", fontSize: 16, color: "#202223" },
  infoGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 14,
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
    marginBottom: 16,
    padding: 12,
    border: "1px solid #a7f3d0",
    borderRadius: 8,
    background: "#ecfdf5",
    color: "#065f46",
    fontSize: 13,
  },
  error: {
    marginBottom: 16,
    padding: 12,
    border: "1px solid #fecaca",
    borderRadius: 8,
    background: "#fef2f2",
    color: "#991b1b",
    fontSize: 13,
  },
};
