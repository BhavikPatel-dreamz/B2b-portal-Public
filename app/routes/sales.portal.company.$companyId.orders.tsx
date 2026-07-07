import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  redirect,
  useLoaderData,
  Link,
  Form,
  useNavigation,
  useActionData,
} from "react-router";
import prisma from "app/db.server";
import {
  requireSalesSession,
  hasCompanyAccess,
  buildClearSessionCookie,
} from "app/utils/sales-session.server";
import { restoreCredit } from "app/services/creditService";
import { getAdminForShop } from "app/shopify.server";
import {
  SalesPortalHeader,
  SalesPortalLayout,
  salesPortalButtonStyles,
} from "app/components/SalesPortalLayout";
import {
  getOrCreateSalesOrderPaymentLink,
  getShopifyOrderWhere,
  isSalesPortalPaymentLinkEligible,
  logOrderActivity,
} from "app/services/sales-order-management.server";

// ⚠️ NOTE: isSalesPortalPaymentLinkEligible is only called inside loader/action
// (server-only exports). It must NOT be called in the component body.

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { user } = await requireSalesSession(request);
  const companyId = params.companyId;

  if (!companyId) {
    return redirect("/sales/portal");
  }

  if (!hasCompanyAccess(user, companyId)) {
    return redirect("/sales/portal");
  }

  const company = await prisma.companyAccount.findUnique({
    where: { id: companyId },
    include: {
      shop: {
        select: {
          shopName: true,
          shopDomain: true,
          themeColor: true,
          accessToken: true,
        },
      },
    },
  });

  if (!company) {
    return redirect("/sales/portal");
  }

  // Fetch only real Shopify Orders for this company.
  const orders = await prisma.b2BOrder.findMany({
    where: {
      AND: [
        {
          companyId: company.id,
          orderStatus: { notIn: ["converted", "archived"] },
        },
        getShopifyOrderWhere(),
      ],
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      shopifyOrderId: true,
      orderTotal: true,
      paymentStatus: true,
      orderStatus: true,
      createdAt: true,
      remainingBalance: true,
      currencyCode: true,
      customerEmail: true,
      source: true,
      paymentLink: true,
      paymentLinkToken: true,
      createdByUser: {
        select: { firstName: true, lastName: true, email: true },
      },
    },
  });
  const quoteCount = await prisma.quote.count({
    where: { companyId: company.id },
  });

  return Response.json({
    user: {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
    },
    company: {
      id: company.id,
      name: company.name,
      creditLimit: company.creditLimit.toString(),
      themeColor: company.shop.themeColor ?? null,
      storeName: company.shop.shopName || company.shop.shopDomain,
    },
    orders: orders.map((o) => ({
      ...o,
      orderTotal: o.orderTotal?.toString() || "0",
      remainingBalance: o.remainingBalance?.toString() || "0",
      createdAt: o.createdAt.toISOString(),
      canGeneratePaymentLink: isSalesPortalPaymentLinkEligible(o),
    })),
    quoteCount,
    allCompanies: user.salesCompanies.map((sc) => ({
      id: sc.company.id,
      name: sc.company.name,
    })),
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { user } = await requireSalesSession(request);
  const companyId = params.companyId;

  if (!companyId || !hasCompanyAccess(user, companyId)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "logout") {
    return redirect("/sales/login", {
      headers: {
        "Set-Cookie": buildClearSessionCookie(),
      },
    });
  }

  if (intent === "delete_order") {
    const orderId = formData.get("orderId") as string;
    if (!orderId) {
      return Response.json({ error: "Missing order ID" }, { status: 400 });
    }

    const order = await prisma.b2BOrder.findFirst({
      where: { id: orderId, companyId },
      include: {
        company: {
          include: {
            shop: true,
          },
        },
      },
    });

    if (!order) {
      return Response.json({ error: "Order not found" }, { status: 404 });
    }

    try {
      const shop = order.company.shop;
      const admin = shop.accessToken
        ? await getAdminForShop(shop.shopDomain)
        : undefined;

      // 1. Restore company/user credit if the order has remaining balance and was not already cancelled
      if (
        order.orderStatus !== "cancelled" &&
        (order.paymentStatus === "pending" ||
          order.paymentStatus === "partial") &&
        order.remainingBalance.greaterThan(0)
      ) {
        console.log(
          `🏦 Restoring credit: ${order.remainingBalance} for deleted order ${order.id}`,
        );
        await restoreCredit(
          order.companyId,
          order.id,
          order.remainingBalance,
          user.id,
          "cancelled",
          admin as Parameters<typeof restoreCredit>[5],
        );
      }

      // 2. If it is a draft order, try to delete the draft in Shopify
      if (order.shopifyOrderId && admin) {
        const isDraft =
          !order.shopifyOrderId.startsWith("gid://shopify/Order/") &&
          (order.orderStatus === "draft" ||
            !order.shopifyOrderId.includes("/Order/"));

        if (isDraft) {
          const gid = order.shopifyOrderId.startsWith("gid://")
            ? order.shopifyOrderId
            : `gid://shopify/DraftOrder/${order.shopifyOrderId}`;

          console.log(`🗑️ Deleting Shopify Draft Order: ${gid}`);
          const mutation = `
            mutation draftOrderDelete($input: DraftOrderDeleteInput!) {
              draftOrderDelete(input: $input) {
                deletedId
                userErrors {
                  field
                  message
                }
              }
            }
          `;
          try {
            const response = await admin.graphql(mutation, {
              variables: { input: { id: gid } },
            });
            const data = await response.json();
            const errors = data.data?.draftOrderDelete?.userErrors || [];
            if (errors.length > 0) {
              console.error("Shopify DraftOrder delete errors:", errors);
            }
          } catch (shopifyErr) {
            console.error(
              "Failed to delete draft order on Shopify:",
              shopifyErr,
            );
          }
        }
      }

      // 3. Delete related credit transactions and notifications safely to avoid foreign key/relation issues
      const orderIdentifiers = [
        order.id,
        order.shopifyOrderId,
        order.shopifyOrderId?.split("/").pop(),
      ].filter(Boolean) as string[];

      await prisma.creditTransaction.deleteMany({
        where: {
          companyId: order.companyId,
          orderId: { in: orderIdentifiers },
        },
      });

      if (order.shopifyOrderId) {
        const numericShopifyId = order.shopifyOrderId.split("/").pop();
        await prisma.notification.deleteMany({
          where: {
            shopifyOrderId: {
              in: [order.shopifyOrderId, numericShopifyId].filter(
                Boolean,
              ) as string[],
            },
          },
        });
      }

      // 4. Delete the B2BOrder itself (cascade deletes payments)
      await prisma.b2BOrder.delete({
        where: { id: order.id },
      });

      console.log(
        `✅ Successfully deleted order ${order.id} from local database`,
      );
      return Response.json({
        success: true,
        message: "Order deleted successfully",
      });
    } catch (err: unknown) {
      console.error("Error deleting order:", err);
      return Response.json(
        {
          error: `Failed to delete order: ${
            err instanceof Error ? err.message : "Unknown error"
          }`,
        },
        { status: 500 },
      );
    }
  }

  if (intent === "generate_payment_link") {
    const orderId = String(formData.get("orderId") || "");
    const order = await prisma.b2BOrder.findFirst({
      where: { id: orderId, companyId },
      include: { company: { include: { shop: true } } },
    });
    if (!order) {
      return Response.json({ error: "Order not found" }, { status: 404 });
    }
    try {
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
      });
    } catch (error) {
      console.error("[sales-payment-link] Generation failed", {
        orderId: order.id,
        companyId,
        error: error instanceof Error ? error.message : String(error),
      });
      return Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Payment link generation failed.",
        },
        { status: 400 },
      );
    }
  }

  return Response.json({ error: "Unknown intent" }, { status: 400 });
};

export default function OrderManageScreen() {
  const { user, company, orders, quoteCount, allCompanies } = useLoaderData<{
    user: {
      id: string;
      firstName: string | null;
      lastName: string | null;
      email: string;
    };
    company: {
      id: string;
      name: string;
      creditLimit: string;
      themeColor: string | null;
      storeName: string | null;
    };
    orders: Array<{
      id: string;
      shopifyOrderId: string | null;
      orderTotal: string;
      paymentStatus: string;
      orderStatus: string;
      createdAt: string;
      remainingBalance: string;
      currencyCode: string;
      customerEmail: string | null;
      source: string | null;
      paymentLink: string | null;
      paymentLinkToken: string | null;
      canGeneratePaymentLink: boolean;
      createdByUser: {
        firstName: string | null;
        lastName: string | null;
        email: string;
      } | null;
    }>;
    quoteCount: number;
    allCompanies: Array<{ id: string; name: string }>;
  }>();
  const navigation = useNavigation();
  const actionData = useActionData<{
    success?: boolean;
    error?: string;
    message?: string;
  }>();
  const isDeleting =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "delete_order";
  const generatingOrderId =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "generate_payment_link"
      ? String(navigation.formData.get("orderId"))
      : null;

  const formatDate = (iso: string) =>
    new Intl.DateTimeFormat("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));

  const formatCurrency = (val: string | number, currencyCode: string) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyCode,
    }).format(Number(val) || 0);

  const getStatusBadge = (status: string) => {
    const map: Record<string, { bg: string; color: string }> = {
      paid: { bg: "#dcfce7", color: "#166534" },
      pending: { bg: "#fef9c3", color: "#854d0e" },
      partial: { bg: "#e0f2fe", color: "#075985" },
      cancelled: { bg: "#fce4ec", color: "#b71c1c" },
      fulfilled: { bg: "#dcfce7", color: "#166534" },
      unfulfilled: { bg: "#fef9c3", color: "#854d0e" },
      draft: { bg: "#f3e8ff", color: "#6b21a8" },
      completed: { bg: "#dbeafe", color: "#1e40af" },
      submitted: { bg: "#e0f2fe", color: "#0369a1" },
    };
    const s = map[status?.toLowerCase()] || { bg: "#f3f4f6", color: "#374151" };
    return (
      <span
        style={{
          padding: "4px 10px",
          borderRadius: "20px",
          fontSize: "12px",
          fontWeight: 600,
          backgroundColor: s.bg,
          color: s.color,
          textTransform: "capitalize",
        }}
      >
        {status || "N/A"}
      </span>
    );
  };

  return (
    <SalesPortalLayout
      company={company}
      user={user}
      activePage="orders"
      orderCount={orders.length}
      quoteCount={quoteCount}
      themeColor={company.themeColor}
    >
      <SalesPortalHeader
        title="Manage Orders"
        subtitle={`List, review, and manage B2B orders for ${company.name}`}
        companyId={company.id}
        companies={allCompanies}
        actions={
          <>
            <Link
              to={`/sales/portal/company/${company.id}/create-order`}
              style={salesPortalButtonStyles.primary}
            >
              + Create Order
            </Link>
            <Link
              to={`/sales/portal/company/${company.id}/create-quote`}
              style={salesPortalButtonStyles.secondary}
            >
              + Create Quote
            </Link>
          </>
        }
      />

      {actionData?.error && (
        <div style={styles.errorBanner}>⚠️ {actionData.error}</div>
      )}

      {actionData?.success && (
        <div style={styles.successBanner}>
          ✅ {actionData.message || "Action completed successfully."}
        </div>
      )}

      {/* Orders Table Card */}
      <div style={styles.card}>
        <h2 style={styles.cardTitle}>All B2B Orders</h2>
        {orders.length > 0 ? (
          <div className="sales-quote-table-wrap" style={styles.tableContainer}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Order ID</th>
                  <th style={styles.th}>Shopify Name</th>
                  <th style={styles.th}>Created By</th>
                  <th style={styles.th}>Date</th>
                  <th style={styles.th}>Total</th>
                  <th style={styles.th}>Payment Status</th>
                  <th style={styles.th}>Order Status</th>
                  <th style={{ ...styles.th, textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => {
                  const isOrderDeleting =
                    isDeleting &&
                    navigation.formData?.get("orderId") === order.id;
                  const canDelete =
                    order.orderStatus !== "shipped" &&
                    order.orderStatus !== "delivered";
                  const { canGeneratePaymentLink } = order;

                  return (
                    <tr key={order.id} style={styles.tr}>
                      <td style={styles.td}>
                        <span style={styles.orderIdBadge}>
                          {order.id.slice(-8).toUpperCase()}
                        </span>
                      </td>
                      <td style={styles.td}>
                        <strong style={{ color: "#2c6ecb" }}>
                          {order.shopifyOrderId
                            ? `#${order.shopifyOrderId.split("/").pop()}`
                            : "N/A"}
                        </strong>
                      </td>
                      <td style={styles.td}>
                        {order.createdByUser
                          ? `${order.createdByUser.firstName} ${order.createdByUser.lastName}`
                          : "System"}
                      </td>
                      <td style={styles.td}>{formatDate(order.createdAt)}</td>
                      <td style={styles.td}>
                        <strong>
                          {formatCurrency(order.orderTotal, order.currencyCode)}
                        </strong>
                      </td>
                      <td style={styles.td}>
                        {getStatusBadge(order.paymentStatus)}
                      </td>
                      <td style={styles.td}>
                        {getStatusBadge(order.orderStatus)}
                      </td>
                      <td style={{ ...styles.td, textAlign: "right" }}>
                        {canGeneratePaymentLink &&
                          (order.paymentLink &&
                          !order.paymentLinkToken &&
                          !order.paymentLink.includes("/account/orders/") ? (
                            <a
                              href={order.paymentLink}
                              target="_blank"
                              rel="noreferrer"
                              style={styles.paymentLinkBtn}
                            >
                              Open Payment Checkout
                            </a>
                          ) : (
                            <Form method="post" style={{ display: "inline" }}>
                              <input
                                type="hidden"
                                name="intent"
                                value="generate_payment_link"
                              />
                              <input
                                type="hidden"
                                name="orderId"
                                value={order.id}
                              />
                              <button
                                type="submit"
                                disabled={generatingOrderId === order.id}
                                style={styles.paymentLinkBtn}
                              >
                                {generatingOrderId === order.id
                                  ? "Generating..."
                                  : "Generate Payment Link"}
                              </button>
                            </Form>
                          ))}
                        {canDelete ? (
                          <Form
                            method="post"
                            style={{ display: "inline" }}
                            onSubmit={(e) => {
                              if (
                                !confirm(
                                  "Are you sure you want to delete this order? This will restore company credit and remove the order record permanently.",
                                )
                              ) {
                                e.preventDefault();
                              }
                            }}
                          >
                            <input
                              type="hidden"
                              name="intent"
                              value="delete_order"
                            />
                            <input
                              type="hidden"
                              name="orderId"
                              value={order.id}
                            />
                            <button
                              type="submit"
                              disabled={isOrderDeleting}
                              style={{
                                ...styles.deleteBtn,
                                opacity: isOrderDeleting ? 0.6 : 1,
                              }}
                            >
                              {isOrderDeleting ? "Deleting..." : "🗑️ Delete"}
                            </button>
                          </Form>
                        ) : (
                          <span style={{ fontSize: "12px", color: "#8c9196" }}>
                            Non-deletable
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={styles.emptyState}>
            <span style={{ fontSize: "48px", marginBottom: "16px" }}>📦</span>
            <p style={{ margin: 0, fontWeight: 500, fontSize: "16px" }}>
              No orders found.
            </p>
            <p
              style={{
                margin: "8px 0 0",
                fontSize: "13px",
                color: "#9ca3af",
              }}
            >
              There are no orders logged for this company yet.
            </p>
          </div>
        )}
      </div>
    </SalesPortalLayout>
  );
}

const styles = {
  card: {
    backgroundColor: "white",
    borderRadius: "16px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.03)",
    border: "1px solid #eaeaea",
    padding: "24px",
  },
  cardTitle: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: "17px",
    fontWeight: 600,
    color: "#111",
    margin: "0 0 20px 0",
  },
  tableContainer: { overflowX: "auto" as const },
  table: { width: "100%", borderCollapse: "collapse" as const },
  th: {
    textAlign: "left" as const,
    padding: "12px 14px",
    borderBottom: "1px solid #eaeaea",
    color: "#5c5f62",
    fontWeight: 600,
    fontSize: "13px",
    whiteSpace: "nowrap" as const,
  },
  tr: { borderBottom: "1px solid #f5f5f5" },
  td: { padding: "14px 14px", fontSize: "14px", color: "#202223" },
  orderIdBadge: {
    backgroundColor: "#f3f4f6",
    padding: "4px 8px",
    borderRadius: "6px",
    fontSize: "12px",
    fontWeight: 500,
    color: "#4b5563",
    fontFamily: "monospace",
  },
  deleteBtn: {
    backgroundColor: "#fee2e2",
    color: "#991b1b",
    border: "none",
    padding: "6px 12px",
    borderRadius: "6px",
    fontSize: "13px",
    fontWeight: 500,
    cursor: "pointer",
    transition: "background-color 0.2s",
  },
  paymentLinkBtn: {
    display: "inline-block",
    marginRight: "8px",
    padding: "7px 10px",
    border: "1px solid #2c6ecb",
    borderRadius: "6px",
    background: "white",
    color: "#2c6ecb",
    fontSize: "12px",
    fontWeight: 600,
    textDecoration: "none",
    cursor: "pointer",
  },
  errorBanner: {
    backgroundColor: "#fef2f2",
    border: "1px solid #fee2e2",
    borderRadius: "12px",
    color: "#991b1b",
    padding: "16px",
    fontSize: "14px",
    fontWeight: 500,
    marginBottom: "20px",
  },
  successBanner: {
    backgroundColor: "#f0fdf4",
    border: "1px solid #dcfce7",
    borderRadius: "12px",
    color: "#166534",
    padding: "16px",
    fontSize: "14px",
    fontWeight: 500,
    marginBottom: "20px",
  },
  emptyState: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    padding: "48px",
    color: "#5c5f62",
    textAlign: "center" as const,
  },
};
