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
  getOrCreateSalesOrderPaymentLink,
  getAccessibleOrder,
  getOrderAccessWhere,
  getOrderNumber,
  getSalesOrderAccessLevel,
  logOrderActivity,
  notifyOrderCreator,
} from "app/services/sales-order-management.server";
import { sendOrderPaymentLinkEmail } from "app/utils/email";

type ActionResponse = {
  success?: boolean;
  message?: string;
  error?: string;
  paymentLink?: string;
};

type ShopifyAddress = {
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  country?: string | null;
  zip?: string | null;
  phone?: string | null;
};

type DeliveryDetails = {
  locationName: string | null;
  addressLines: string[];
  phone: string | null;
  source: "shipping_address" | "company_location" | "none";
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { user } = await requireSalesSession(request);
  if (!params.orderId) return redirect("/sales/portal/orders");
  const order = await getAccessibleOrder(user, params.orderId);
  if (!order) throw new Response("Order not found", { status: 404 });
  const accessLevel = getSalesOrderAccessLevel(user);
  const url = new URL(request.url);
  const createdFrom = url.searchParams.get("createdFrom");
  const sourceOrder = url.searchParams.get("sourceOrder");
  const companyIds = user.salesCompanies.map((item) => item.companyId);
  const [orderCount, quoteCount] = await Promise.all([
    prisma.b2BOrder.count({ where: getOrderAccessWhere(user) }),
    prisma.quote.count({
      where: {
        companyId: { in: companyIds },
        ...(accessLevel === "agent" ? { salesAgentId: user.id } : {}),
      },
    }),
  ]);
  const deliveryDetails = await getShopifyDeliveryDetails(order);
  return Response.json({
    user: {
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
    },
    accessLevel,
    orderCount,
    quoteCount,
    successMessage:
      createdFrom && sourceOrder
        ? `${getOrderNumber(order)} was ${createdFrom === "reorder" ? "reordered" : createdFrom === "draft_conversion" ? "converted to an order" : "duplicated"} successfully from ${sourceOrder}.`
        : null,
    companies: user.salesCompanies.map((item) => ({
      id: item.company.id,
      name: item.company.name,
    })),
    order: {
      ...order,
      orderNumber: getOrderNumber(order),
      orderTotal: order.orderTotal.toString(),
      paidAmount: order.paidAmount.toString(),
      remainingBalance: order.remainingBalance.toString(),
      subtotal: order.subtotal.toString(),
      discountTotal: order.discountTotal.toString(),
      taxAmount: order.taxAmount.toString(),
      shippingAmount: order.shippingAmount.toString(),
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
      items: order.items.map((item) => ({
        ...item,
        unitPrice: item.unitPrice.toString(),
        discount: item.discount.toString(),
        lineTotal: item.lineTotal.toString(),
      })),
      payments: order.payments.map((payment) => ({
        ...payment,
        amount: payment.amount.toString(),
        createdAt: payment.createdAt.toISOString(),
        receivedAt: payment.receivedAt?.toISOString() || null,
      })),
      activities: order.activities.map((activity) => ({
        ...activity,
        createdAt: activity.createdAt.toISOString(),
      })),
    },
    deliveryDetails,
  });
};

async function getShopifyDeliveryDetails(order: any): Promise<DeliveryDetails> {
  const empty: DeliveryDetails = {
    locationName: null,
    addressLines: [],
    phone: null,
    source: "none",
  };
  const shopDomain = order.company?.shop?.shopDomain;
  const accessToken = order.company?.shop?.accessToken;
  const shopifyOrder = normalizeShopifyOrderId(order);

  if (
    !shopDomain ||
    !accessToken ||
    !shopifyOrder
  ) {
    return getCompanyLocationDeliveryDetails(order, empty);
  }

  try {
    const orderQuery = `
      query GetSupportOrderDelivery($id: ID!) {
        node(id: $id) {
          ... on Order {
            shippingAddress {
              firstName
              lastName
              company
              address1
              address2
              city
              province
              country
              zip
              phone
            }
            purchasingEntity {
              ... on PurchasingCompany {
                location {
                  id
                  name
                }
              }
            }
            customAttributes {
              key
              value
            }
          }
        }
      }
    `;
    const orderResponse = await fetch(
      `https://${shopDomain}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: orderQuery,
          variables: { id: shopifyOrder.id },
        }),
      },
    );
    const orderPayload = await orderResponse.json();
    if (orderPayload.errors?.length) {
      console.warn("[support-order] delivery lookup failed", {
        orderId: order.id,
        errors: orderPayload.errors,
      });
      return getCompanyLocationDeliveryDetails(order, empty);
    }

    const shopifyOrderNode = orderPayload.data?.node;
    const purchasingLocation =
      shopifyOrderNode?.purchasingEntity?.location || null;
    const customLocationName =
      shopifyOrderNode?.customAttributes?.find(
        (attribute: { key?: string }) => attribute.key === "Delivery Location",
      )?.value || null;
    const locationName =
      purchasingLocation?.name || customLocationName || empty.locationName;
    const shippingLines = formatAddressLines(
      shopifyOrderNode?.shippingAddress,
      locationName,
    );
    if (shippingLines.length > 0) {
      return {
        locationName,
        addressLines: shippingLines,
        phone: shopifyOrderNode.shippingAddress?.phone || null,
        source: "shipping_address",
      };
    }

    if (purchasingLocation?.id) {
      const locationQuery = `
        query GetSupportOrderLocationAddress($id: ID!) {
          companyLocation(id: $id) {
            id
            name
            phone
            shippingAddress {
              address1
              address2
              city
              province
              country
              zip
              phone
            }
          }
        }
      `;
      const locationResponse = await fetch(
        `https://${shopDomain}/admin/api/2025-01/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({
            query: locationQuery,
            variables: { id: purchasingLocation.id },
          }),
        },
      );
      const locationPayload = await locationResponse.json();
      if (locationPayload.errors?.length) {
        console.warn("[support-order] location address lookup failed", {
          orderId: order.id,
          locationId: purchasingLocation.id,
          errors: locationPayload.errors,
        });
      }
      const location = locationPayload.data?.companyLocation;
      const locationLines = formatAddressLines(
        location?.shippingAddress,
        location?.name || locationName,
      );
      return {
        locationName: location?.name || locationName,
        addressLines: locationLines,
        phone: location?.shippingAddress?.phone || location?.phone || null,
        source: locationLines.length > 0 ? "company_location" : "none",
      };
    }

    return getCompanyLocationDeliveryDetails(order, { ...empty, locationName });
  } catch (error) {
    console.error("[support-order] delivery details unavailable", {
      orderId: order.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return getCompanyLocationDeliveryDetails(order, empty);
  }
}

function normalizeShopifyOrderId(order: any) {
  const rawId = String(order.shopifyOrderId || "").trim();
  if (!rawId) return null;
  if (rawId.startsWith("gid://shopify/Order/")) {
    return { id: rawId };
  }
  if (rawId.startsWith("gid://shopify/DraftOrder/")) {
    return { id: rawId };
  }
  if (/^\d+$/.test(rawId)) {
    const resource = order.orderStatus === "draft" ? "DraftOrder" : "Order";
    return { id: `gid://shopify/${resource}/${rawId}` };
  }
  return null;
}

async function getCompanyLocationDeliveryDetails(
  order: any,
  fallback: DeliveryDetails,
): Promise<DeliveryDetails> {
  const shopDomain = order.company?.shop?.shopDomain;
  const accessToken = order.company?.shop?.accessToken;
  const shopifyCompanyId = order.company?.shopifyCompanyId;

  if (!shopDomain || !accessToken || !shopifyCompanyId) {
    return fallback;
  }

  try {
    const query = `
      query GetSupportOrderCompanyLocations($companyId: ID!) {
        company(id: $companyId) {
          locations(first: 50) {
            nodes {
              id
              name
              phone
              shippingAddress {
                address1
                address2
                city
                province
                country
                zip
                phone
              }
            }
          }
          contacts(first: 50) {
            edges {
              node {
                customer {
                  id
                }
                roleAssignments(first: 5) {
                  edges {
                    node {
                      companyLocation {
                        id
                        name
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;
    const response = await fetch(
      `https://${shopDomain}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query,
          variables: { companyId: shopifyCompanyId },
        }),
      },
    );
    const payload = await response.json();
    if (payload.errors?.length) {
      console.warn("[support-order] company location fallback failed", {
        orderId: order.id,
        errors: payload.errors,
      });
      return fallback;
    }

    const locations = payload.data?.company?.locations?.nodes || [];
    const contacts = payload.data?.company?.contacts?.edges || [];
    const customerGid = normalizeCustomerGid(order.customerId);
    const assignedLocationId = customerGid
      ? contacts
          .find((edge: any) => edge.node?.customer?.id === customerGid)
          ?.node?.roleAssignments?.edges?.[0]?.node?.companyLocation?.id
      : null;
    const namedLocation = fallback.locationName
      ? locations.find(
          (location: any) =>
            location.name?.toLowerCase() ===
            fallback.locationName?.toLowerCase(),
        )
      : null;
    const location =
      locations.find((item: any) => item.id === assignedLocationId) ||
      namedLocation ||
      (locations.length === 1 ? locations[0] : null);

    if (!location) return fallback;

    const addressLines = formatAddressLines(
      location.shippingAddress,
      location.name,
    );
    return {
      locationName: location.name || fallback.locationName,
      addressLines:
        addressLines.length > 0 ? addressLines : fallback.addressLines,
      phone:
        location.shippingAddress?.phone ||
        location.phone ||
        fallback.phone ||
        null,
      source:
        addressLines.length > 0 ? "company_location" : fallback.source,
    };
  } catch (error) {
    console.error("[support-order] company location fallback unavailable", {
      orderId: order.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}

function normalizeCustomerGid(customerId?: string | null) {
  const rawId = String(customerId || "").trim();
  if (!rawId) return null;
  if (rawId.startsWith("gid://shopify/Customer/")) return rawId;
  if (/^\d+$/.test(rawId)) return `gid://shopify/Customer/${rawId}`;
  return null;
}

function formatAddressLines(
  address?: ShopifyAddress | null,
  locationName?: string | null,
) {
  if (!address) return [];
  const recipient = [address.firstName, address.lastName]
    .filter(Boolean)
    .join(" ");
  const cityLine = [address.city, address.province, address.zip]
    .filter(Boolean)
    .join(", ");
  const lines = [
    recipient,
    address.company || locationName,
    address.address1,
    address.address2,
    cityLine,
    address.country,
  ];
  return Array.from(
    new Set(lines.map((line) => String(line || "").trim()).filter(Boolean)),
  );
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { user } = await requireSalesSession(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  if (intent === "logout") {
    return redirect("/sales/login", {
      headers: { "Set-Cookie": buildClearSessionCookie() },
    });
  }
  if (!params.orderId)
    return Response.json({ error: "Order not found" }, { status: 404 });
  const order = await getAccessibleOrder(user, params.orderId);
  if (!order)
    return Response.json({ error: "Order not found" }, { status: 404 });
  const accessLevel = getSalesOrderAccessLevel(user);

  try {
    if (intent === "duplicate_order" || intent === "reorder") {
      const duplicate = await prisma.b2BOrder.create({
        data: {
          companyId: order.companyId,
          createdByUserId: user.id,
          shopId: order.shopId,
          orderNumber: `ORD-${Date.now().toString().slice(-8)}`,
          orderTotal: order.orderTotal,
          creditUsed: 0,
          userCreditUsed: 0,
          remainingBalance: order.orderTotal,
          paymentStatus: "pending",
          orderStatus: "draft",
          customerName: order.customerName,
          customerEmail: order.customerEmail,
          customerId: order.customerId,
          poNumber: order.poNumber,
          currencyCode: order.currencyCode,
          subtotal: order.subtotal,
          discountTotal: order.discountTotal,
          taxAmount: order.taxAmount,
          shippingAmount: order.shippingAmount,
          notes: order.notes,
          source:
            intent === "reorder"
              ? "Sales Portal Reorder"
              : "Sales Portal Duplicate",
          items: {
            create: order.items.map((item) => ({
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
        action: "Order Created",
        message: `Created from ${getOrderNumber(order)}.`,
      });
      return redirect(
        `/sales/portal/orders/${duplicate.id}?createdFrom=${intent}&sourceOrder=${encodeURIComponent(getOrderNumber(order))}`,
      );
    }

    if (intent === "generate_payment_link") {
      const generated = await getOrCreateSalesOrderPaymentLink(order);
      await logOrderActivity({
        orderId: order.id,
        userId: user.id,
        action: generated.reused
          ? "Payment Link Reused"
          : "Payment Link Generated",
        message: generated.link,
      });
      return Response.json({
        success: true,
        message: generated.reused
          ? "Existing active payment link reused."
          : "Payment link generated.",
        paymentLink: generated.link,
      });
    }

    if (intent === "send_payment_link" || intent === "resend_payment_link") {
      if (
        order.source !== "Sales Portal" ||
        order.paymentStatus !== "pending" ||
        order.orderStatus === "cancelled"
      )
        return Response.json(
          {
            error:
              "Only pending Sales Portal orders can receive payment links.",
          },
          { status: 400 },
        );
      if (!order.paymentLink)
        return Response.json(
          { error: "Generate a payment link first." },
          { status: 400 },
        );
      if (!order.customerEmail)
        return Response.json(
          { error: "This order does not have a customer email." },
          { status: 400 },
        );
      const verifiedPaymentLink = await getOrCreateSalesOrderPaymentLink(order);
      await sendOrderPaymentLinkEmail({
        storeId: order.shopId,
        to: order.customerEmail,
        customerName: order.customerName,
        orderNumber: getOrderNumber(order),
        companyName: order.company.name,
        totalAmount: order.remainingBalance.toString(),
        currencyCode: order.currencyCode,
        paymentUrl: verifiedPaymentLink.link,
      });
      await prisma.b2BOrder.update({
        where: { id: order.id },
        data: { paymentLinkSentAt: new Date() },
      });
      await logOrderActivity({
        orderId: order.id,
        userId: user.id,
        action:
          intent === "resend_payment_link"
            ? "Payment Link Resent"
            : "Payment Link Sent",
        message: `Sent to ${order.customerEmail}.`,
      });
      return Response.json({
        success: true,
        message: "Payment link emailed to the customer.",
      });
    }

    if (intent === "cancel_order") {
      if (accessLevel === "agent")
        return Response.json(
          { error: "Manager access is required." },
          { status: 403 },
        );
      await prisma.b2BOrder.update({
        where: { id: order.id },
        data: { orderStatus: "cancelled" },
      });
      await logOrderActivity({
        orderId: order.id,
        userId: user.id,
        action: "Order Cancelled",
      });
      await notifyOrderCreator({
        orderId: order.id,
        receiverId: order.createdByUserId,
        shopId: order.shopId,
        shopifyOrderId: order.shopifyOrderId,
        title: "Order Cancelled",
        message: `${getOrderNumber(order)} was cancelled.`,
        activityType: "cancelled",
      });
      return Response.json({ success: true, message: "Order cancelled." });
    }

    if (intent === "update_status") {
      if (accessLevel !== "admin")
        return Response.json(
          { error: "Admin access is required." },
          { status: 403 },
        );
      const orderStatus = String(
        formData.get("orderStatus") || order.orderStatus,
      );
      const paymentStatus = String(
        formData.get("paymentStatus") || order.paymentStatus,
      );
      await prisma.b2BOrder.update({
        where: { id: order.id },
        data: {
          orderStatus,
          paymentStatus,
          paidAt: paymentStatus === "paid" ? new Date() : order.paidAt,
        },
      });
      await logOrderActivity({
        orderId: order.id,
        userId: user.id,
        action: "Status Changed",
        message: `Order: ${orderStatus}; payment: ${paymentStatus}.`,
      });
      if (
        ["paid", "completed", "refunded"].includes(paymentStatus) ||
        ["completed", "refunded"].includes(orderStatus)
      ) {
        const status =
          orderStatus === "refunded" || paymentStatus === "refunded"
            ? "refunded"
            : paymentStatus === "paid"
              ? "paid"
              : "completed";
        await notifyOrderCreator({
          orderId: order.id,
          receiverId: order.createdByUserId,
          shopId: order.shopId,
          shopifyOrderId: order.shopifyOrderId,
          title: `Order ${label(status)}`,
          message: `${getOrderNumber(order)} is now ${label(status).toLowerCase()}.`,
          activityType: status,
        });
      }
      return Response.json({ success: true, message: "Order status updated." });
    }

    if (intent === "delete_order") {
      if (accessLevel !== "admin")
        return Response.json(
          { error: "Admin access is required." },
          { status: 403 },
        );
      const deletedOrderNumber = getOrderNumber(order);
      await prisma.b2BOrder.delete({ where: { id: order.id } });
      return redirect(
        `/sales/portal/orders?deletedOrder=${encodeURIComponent(deletedOrderNumber)}`,
      );
    }
  } catch (error) {
    console.error("[sales-order-action] Action failed", {
      orderId: order.id,
      intent,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Order action failed.",
      },
      { status: 400 },
    );
  }
  return Response.json({ error: "Unknown action" }, { status: 400 });
};

export default function OrderDetailsPage() {
  const data = useLoaderData<any>();
  const actionData = useActionData<ActionResponse>();
  const navigation = useNavigation();
  const order = data.order;
  const deliveryDetails = data.deliveryDetails as DeliveryDetails;
  const busy = navigation.state !== "idle";
  const pendingIntent = String(navigation.formData?.get("intent") || "");
  const submissionLock = useRef(false);
  const [notification, setNotification] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(data.successMessage ? { type: "success", message: data.successMessage } : null);

  useEffect(() => {
    if (navigation.state === "idle") submissionLock.current = false;
  }, [navigation.state]);

  useEffect(() => {
    if (actionData?.error) {
      setNotification({ type: "error", message: actionData.error });
    } else if (actionData?.success) {
      setNotification({
        type: "success",
        message: actionData.message || "Order updated successfully.",
      });
    }
  }, [actionData]);

  useEffect(() => {
    if (data.successMessage) {
      setNotification({ type: "success", message: data.successMessage });
    }
  }, [data.successMessage]);

  const guardSubmission = (event: React.FormEvent<HTMLFormElement>) => {
    if (submissionLock.current || busy) {
      event.preventDefault();
      return false;
    }
    submissionLock.current = true;
    setNotification(null);
    return true;
  };
  const money = (amount: string) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: order.currencyCode,
    }).format(Number(amount) || 0);
  const date = (value: string) =>
    new Intl.DateTimeFormat("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));

  return (
    <SalesPortalLayout
      company={{
        id: order.company.id,
        name: order.company.name,
        storeName: order.company.shop.shopName || order.company.shop.shopDomain,
      }}
      user={data.user}
      activePage="orders"
      orderCount={data.orderCount}
      quoteCount={data.quoteCount}
    >
      <Link
        to="/sales/portal/orders"
        aria-disabled={busy}
        style={{
          ...styles.backLink,
          opacity: busy ? 0.55 : 1,
          pointerEvents: busy ? "none" : "auto",
        }}
      >
        Back to Orders
      </Link>
      <SalesPortalHeader
        title={order.orderNumber}
        subtitle={`${order.customerName || order.customerEmail || "Customer not captured"} · Created ${date(order.createdAt)}`}
        companyId={order.company.id}
        companies={data.companies}
        actions={
          <>
            <Action
              intent="duplicate_order"
              label="Duplicate"
              disabled={busy}
              pending={pendingIntent === "duplicate_order"}
              onSubmit={guardSubmission}
            />
            <Action
              intent="reorder"
              label="Reorder"
              disabled={busy}
              pending={pendingIntent === "reorder"}
              onSubmit={guardSubmission}
            />
            <button
              type="button"
              onClick={() => window.print()}
              style={styles.secondaryButton}
              disabled={busy}
            >
              Download PDF
            </button>
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

      <div className="order-detail-grid" style={styles.grid}>
        <section style={styles.mainColumn}>
          <Card title="Order Information">
            <div className="order-info-grid" style={styles.infoGrid}>
              <Info label="Order Number" value={order.orderNumber} />
              <Info label="Company" value={order.company.name} />
              <Info
                label="Customer"
                value={order.customerName || "Not captured"}
              />
              <Info
                label="Customer Email"
                value={order.customerEmail || "Not captured"}
              />
              <Info
                label="Sales Agent"
                value={
                  [order.createdByUser.firstName, order.createdByUser.lastName]
                    .filter(Boolean)
                    .join(" ") || order.createdByUser.email
                }
              />
              <Info
                label="PO Number"
                value={order.poNumber || "Not provided"}
              />
              <Info label="Created" value={date(order.createdAt)} />
              <Info label="Updated" value={date(order.updatedAt)} />
              <Info label="Order Status" value={label(order.orderStatus)} />
              <Info
                label="Payment Status"
                value={paymentLabel(order.paymentStatus)}
              />
            </div>
          </Card>

          <Card title="Delivery Details">
            <div className="delivery-detail-grid" style={styles.deliveryBlock}>
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
                    Delivery address was not captured for this order.
                  </p>
                )}
              </div>
              {deliveryDetails.phone && (
                <Info label="Phone" value={deliveryDetails.phone} />
              )}
              {deliveryDetails.source === "company_location" && (
                <p style={styles.deliveryHint}>
                  Shopify order shipping address was empty, so this uses the
                  selected company location address.
                </p>
              )}
            </div>
          </Card>

          <div style={{ ...styles.card, padding: 0, overflow: "hidden" }}>
            <div style={styles.cardHeader}>
              <h2 style={styles.cardTitle}>Products</h2>
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
                  {order.items.map((item: any) => (
                    <tr key={item.id}>
                      <td style={styles.td}>
                        <div style={styles.product}>
                          {item.image ? (
                            <img
                              src={item.image}
                              alt=""
                              style={styles.productImage}
                            />
                          ) : (
                            <span style={styles.imagePlaceholder} />
                          )}
                          <strong>{item.productTitle}</strong>
                        </div>
                      </td>
                      <td style={styles.td}>{item.sku || "-"}</td>
                      <td style={styles.td}>
                        {item.variantTitle || "Default"}
                      </td>
                      <td style={styles.td}>{item.quantity}</td>
                      <td style={styles.td}>{money(item.unitPrice)}</td>
                      <td style={styles.td}>{money(item.discount)}</td>
                      <td style={styles.td}>
                        <strong>{money(item.lineTotal)}</strong>
                      </td>
                    </tr>
                  ))}
                  {!order.items.length && (
                    <tr>
                      <td colSpan={7} style={styles.empty}>
                        Product details were not captured for this legacy order.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <Card title="Activity Timeline">
            <div style={styles.timeline}>
              {order.activities.map((activity: any) => (
                <div key={activity.id} style={styles.activity}>
                  <span style={styles.dot} />
                  <div>
                    <strong>{activity.action}</strong>
                    <p style={styles.activityMeta}>
                      {activity.user
                        ? [activity.user.firstName, activity.user.lastName]
                            .filter(Boolean)
                            .join(" ") || activity.user.email
                        : "System"}{" "}
                      · {date(activity.createdAt)}
                    </p>
                    {activity.message && (
                      <p style={styles.activityMessage}>{activity.message}</p>
                    )}
                  </div>
                </div>
              ))}
              {!order.activities.length && (
                <p style={styles.muted}>
                  No activity has been recorded for this order yet.
                </p>
              )}
            </div>
          </Card>
        </section>

        <aside className="order-detail-side" style={styles.sideColumn}>
          <Card title="Pricing Summary">
            <Row
              label="Subtotal"
              value={money(order.subtotal || order.orderTotal)}
            />
            <Row label="Discounts" value={`-${money(order.discountTotal)}`} />
            <Row label="Taxes" value={money(order.taxAmount)} />
            <Row label="Shipping" value={money(order.shippingAmount)} />
            <div style={styles.totalRow}>
              <strong>Grand Total</strong>
              <strong>{money(order.orderTotal)}</strong>
            </div>
            <Row label="Paid" value={money(order.paidAmount)} />
            <Row label="Balance" value={money(order.remainingBalance)} />
          </Card>

          {order.source === "Sales Portal" &&
          order.paymentStatus === "pending" &&
          order.orderStatus !== "cancelled" ? (
            <Card title="Payment Link">
              {order.paymentLink &&
              !order.paymentLinkToken &&
              !order.paymentLink.includes("/account/orders/") ? (
                <>
                  <span style={styles.generated}>Payment Link Generated</span>
                  <div style={styles.copyRow}>
                    <input
                      readOnly
                      value={order.paymentLink}
                      style={styles.input}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <button
                      type="button"
                      style={styles.copyButton}
                      onClick={() =>
                        navigator.clipboard.writeText(order.paymentLink)
                      }
                    >
                      Copy
                    </button>
                  </div>
                  <div style={styles.buttonStack}>
                    <Action
                      intent="send_payment_link"
                      label="Send Email"
                      disabled={busy || !order.customerEmail}
                      pending={pendingIntent === "send_payment_link"}
                      onSubmit={guardSubmission}
                      primary
                    />
                    <Action
                      intent="resend_payment_link"
                      label="Resend Link"
                      disabled={busy || !order.customerEmail}
                      pending={pendingIntent === "resend_payment_link"}
                      onSubmit={guardSubmission}
                    />
                  </div>
                </>
              ) : (
                <Action
                  intent="generate_payment_link"
                  label="Generate Payment Link"
                  disabled={busy}
                  pending={pendingIntent === "generate_payment_link"}
                  onSubmit={guardSubmission}
                  primary
                />
              )}
              {order.payments.length > 0 && (
                <div style={styles.paymentList}>
                  {order.payments.map((payment: any) => (
                    <div key={payment.id} style={styles.paymentRow}>
                      <span>{paymentLabel(payment.status)}</span>
                      <strong>{money(payment.amount)}</strong>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          ) : null}

          {data.accessLevel !== "agent" && (
            <Card title="Manager Actions">
              <Action
                intent="cancel_order"
                label="Cancel Order"
                disabled={busy || order.orderStatus === "cancelled"}
                pending={pendingIntent === "cancel_order"}
                onSubmit={guardSubmission}
                danger
              />
            </Card>
          )}
          {data.accessLevel === "admin" && (
            <Card title="Admin Controls">
              <Form method="post" style={styles.adminForm} onSubmit={guardSubmission}>
                <input type="hidden" name="intent" value="update_status" />
                <label style={styles.label}>
                  Order status
                  <select
                    name="orderStatus"
                    defaultValue={order.orderStatus}
                    style={styles.input}
                    disabled={busy}
                  >
                    {[
                      "draft",
                      "payment_pending",
                      "paid",
                      "processing",
                      "completed",
                      "cancelled",
                      "refunded",
                    ].map((status) => (
                      <option key={status} value={status}>
                        {label(status)}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={styles.label}>
                  Payment status
                  <select
                    name="paymentStatus"
                    defaultValue={order.paymentStatus}
                    style={styles.input}
                    disabled={busy}
                  >
                    {[
                      "pending",
                      "partial",
                      "paid",
                      "failed",
                      "expired",
                      "refunded",
                    ].map((status) => (
                      <option key={status} value={status}>
                        {paymentLabel(status)}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  disabled={busy}
                  aria-busy={pendingIntent === "update_status"}
                  style={disabledButtonStyle(styles.primaryButton, busy)}
                >
                  {pendingIntent === "update_status" && <Spinner />}
                  {pendingIntent === "update_status" ? "Updating Status..." : "Update Status"}
                </button>
              </Form>
              <Form
                method="post"
                onSubmit={(event) => {
                  if (!confirm("Delete this order permanently?")) {
                    event.preventDefault();
                    return;
                  }
                  guardSubmission(event);
                }}
              >
                <input type="hidden" name="intent" value="delete_order" />
                <button
                  disabled={busy}
                  aria-busy={pendingIntent === "delete_order"}
                  style={disabledButtonStyle(styles.dangerButton, busy)}
                >
                  {pendingIntent === "delete_order" && <Spinner dark />}
                  {pendingIntent === "delete_order" ? "Deleting Order..." : "Delete Order"}
                </button>
              </Form>
            </Card>
          )}
        </aside>
      </div>
      <style>{responsiveCss}</style>
    </SalesPortalLayout>
  );
}

function label(value: string) {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
function paymentLabel(value: string) {
  return value === "partial" ? "Partially Paid" : label(value);
}
function Action({
  intent,
  label: text,
  disabled,
  pending,
  onSubmit,
  primary,
  danger,
}: {
  intent: string;
  label: string;
  disabled?: boolean;
  pending?: boolean;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => boolean;
  primary?: boolean;
  danger?: boolean;
}) {
  const buttonStyle = primary
    ? styles.primaryButton
    : danger
      ? styles.dangerButton
      : styles.secondaryButton;

  return (
    <Form method="post" style={{ display: "inline-flex" }} onSubmit={onSubmit}>
      <input type="hidden" name="intent" value={intent} />
      <button
        type="submit"
        disabled={disabled}
        aria-busy={pending}
        style={disabledButtonStyle(buttonStyle, Boolean(disabled))}
      >
        {pending && <Spinner dark={!primary} />}
        {pending ? pendingLabel(intent) : text}
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
    duplicate_order: "Duplicating...",
    reorder: "Creating Reorder...",
    generate_payment_link: "Generating Link...",
    send_payment_link: "Sending Email...",
    resend_payment_link: "Resending Link...",
    cancel_order: "Cancelling Order...",
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
function Info({ label: title, value }: { label: string; value: string }) {
  return (
    <div>
      <span style={styles.metaLabel}>{title}</span>
      <strong style={styles.infoValue}>{value}</strong>
    </div>
  );
}
function Row({ label: title, value }: { label: string; value: string }) {
  return (
    <div style={styles.summaryRow}>
      <span>{title}</span>
      <strong>{value}</strong>
    </div>
  );
}

const responsiveCss = `
  @keyframes order-action-spin { to { transform: rotate(360deg); } }
  @media (max-width: 1080px) { .order-detail-grid { grid-template-columns: minmax(0, 1fr) !important; } .order-detail-side { position: static !important; } }
  @media (max-width: 680px) { .order-info-grid, .delivery-detail-grid { grid-template-columns: minmax(0, 1fr) !important; } }
  @media print { .sales-portal-sidebar, .sales-portal-header-actions, .order-detail-side form { display: none !important; } .sales-portal-main { padding: 0 !important; } }
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
    gridTemplateColumns: "minmax(0, 1fr) 360px",
    gap: 20,
    alignItems: "start",
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
    padding: 20,
  },
  cardHeader: { padding: "18px 20px", borderBottom: "1px solid #e1e3e5" },
  cardTitle: { margin: "0 0 16px", color: "#202223", fontSize: 17 },
  infoGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: 20,
  },
  deliveryBlock: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 20,
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
  deliveryHint: {
    gridColumn: "1 / -1",
    margin: 0,
    color: "#6d7175",
    fontSize: 12,
  },
  metaLabel: {
    display: "block",
    marginBottom: 4,
    color: "#6d7175",
    fontSize: 12,
  },
  infoValue: { fontSize: 13 },
  tableWrap: { overflowX: "auto" },
  table: { width: "100%", minWidth: 800, borderCollapse: "collapse" },
  th: {
    padding: "11px 12px",
    textAlign: "left",
    color: "#6d7175",
    fontSize: 12,
    borderBottom: "1px solid #e1e3e5",
  },
  td: { padding: "12px", fontSize: 13, borderBottom: "1px solid #f1f2f3" },
  product: { display: "flex", alignItems: "center", gap: 10 },
  productImage: {
    width: 42,
    height: 42,
    objectFit: "cover",
    borderRadius: 6,
    border: "1px solid #e1e3e5",
  },
  imagePlaceholder: {
    width: 42,
    height: 42,
    borderRadius: 6,
    background: "#f4f6f8",
  },
  empty: { padding: 28, color: "#6d7175", textAlign: "center" },
  summaryRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    padding: "7px 0",
    color: "#4b5563",
    fontSize: 13,
  },
  totalRow: {
    display: "flex",
    justifyContent: "space-between",
    borderTop: "1px solid #e1e3e5",
    marginTop: 8,
    padding: "14px 0 7px",
    fontSize: 17,
  },
  generated: {
    display: "inline-flex",
    marginBottom: 12,
    padding: "4px 9px",
    borderRadius: 8,
    background: "#dcfce7",
    color: "#166534",
    fontSize: 12,
    fontWeight: 600,
  },
  copyRow: { display: "flex", gap: 8, marginBottom: 12 },
  input: {
    width: "100%",
    height: 40,
    padding: "0 10px",
    border: "1px solid #c9cccf",
    borderRadius: 8,
    background: "#fff",
    font: "inherit",
    fontSize: 13,
  },
  copyButton: {
    padding: "0 12px",
    border: "1px solid #c9cccf",
    borderRadius: 8,
    background: "#fff",
    color: "#2c6ecb",
    fontWeight: 600,
    cursor: "pointer",
  },
  buttonStack: { display: "flex", flexWrap: "wrap", gap: 8 },
  primaryButton: {
    minHeight: 40,
    padding: "9px 14px",
    border: "1px solid #111827",
    borderRadius: 8,
    background: "#111827",
    color: "#fff",
    fontWeight: 600,
    cursor: "pointer",
  },
  secondaryButton: {
    minHeight: 40,
    padding: "9px 14px",
    border: "1px solid #c9cccf",
    borderRadius: 8,
    background: "#fff",
    color: "#374151",
    fontWeight: 600,
    cursor: "pointer",
  },
  dangerButton: {
    minHeight: 40,
    padding: "9px 14px",
    border: "1px solid #fecaca",
    borderRadius: 8,
    background: "#fff",
    color: "#b91c1c",
    fontWeight: 600,
    cursor: "pointer",
  },
  adminForm: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    marginBottom: 12,
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    color: "#374151",
    fontSize: 13,
    fontWeight: 600,
  },
  timeline: { display: "flex", flexDirection: "column", gap: 16 },
  activity: { display: "grid", gridTemplateColumns: "10px 1fr", gap: 12 },
  dot: {
    width: 9,
    height: 9,
    marginTop: 4,
    borderRadius: "50%",
    background: "#e91e63",
  },
  activityMeta: { margin: "4px 0 0", color: "#8c9196", fontSize: 12 },
  activityMessage: { margin: "5px 0 0", color: "#4b5563", fontSize: 13 },
  muted: { color: "#6d7175", fontSize: 13 },
  paymentList: {
    marginTop: 16,
    paddingTop: 12,
    borderTop: "1px solid #e1e3e5",
  },
  paymentRow: {
    display: "flex",
    justifyContent: "space-between",
    padding: "6px 0",
    fontSize: 13,
  },
  success: {
    border: "1px solid #a7f3d0",
    background: "#ecfdf5",
    color: "#065f46",
  },
  error: {
    border: "1px solid #fecaca",
    background: "#fef2f2",
    color: "#991b1b",
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
    animation: "order-action-spin 0.8s linear infinite",
    flexShrink: 0,
  },
};
