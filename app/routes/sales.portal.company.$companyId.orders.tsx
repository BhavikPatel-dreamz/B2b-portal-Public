import { LoaderFunctionArgs, redirect } from "react-router";
import {
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
import {
  restoreCredit,
  calculateAvailableCredit,
} from "app/services/creditService";
import { getAdminForShop } from "app/shopify.server";
import type { ActionFunctionArgs } from "react-router";
import { Decimal } from "@prisma/client/runtime/library";

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
        select: { shopName: true, shopDomain: true, accessToken: true },
      },
    },
  });

  if (!company) {
    return redirect("/sales/portal");
  }

  // Fetch all orders for this company (both drafts and completed)
  const orders = await prisma.b2BOrder.findMany({
    where: {
      companyId: company.id,
      orderStatus: { notIn: ["converted", "archived"] },
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
      createdByUser: {
        select: { firstName: true, lastName: true, email: true },
      },
    },
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
      storeName: company.shop.shopName || company.shop.shopDomain,
    },
    orders: orders.map((o) => ({
      ...o,
      orderTotal: o.orderTotal?.toString() || "0",
      remainingBalance: o.remainingBalance?.toString() || "0",
      createdAt: o.createdAt.toISOString(),
    })),
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
          admin as any,
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
    } catch (err: any) {
      console.error("Error deleting order:", err);
      return Response.json(
        { error: `Failed to delete order: ${err.message}` },
        { status: 500 },
      );
    }
  }

  return Response.json({ error: "Unknown intent" }, { status: 400 });
};

export default function OrderManageScreen() {
  const { user, company, orders, allCompanies } = useLoaderData<{
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
      createdByUser: {
        firstName: string | null;
        lastName: string | null;
        email: string;
      } | null;
    }>;
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

  const formatDate = (iso: string) =>
    new Intl.DateTimeFormat("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));

  const formatCurrency = (val: string | number) =>
    `$${Number(val).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
    <div style={styles.container}>
      {/* Sidebar */}
      <aside style={styles.sidebar}>
        <div style={styles.logoContainer}>
          <div style={styles.logoIcon}>
            <img
              src="https://cdn.shopify.com/s/files/applications/c6da0a0589e2c3c978aadf2afec07db7_200x200.png?v=1776950914"
              alt="Logo"
              style={styles.logoImage}
            />
          </div>
          <span style={styles.logoText}>SmartB2B</span>
        </div>

        {/* Company Switcher */}
        <div style={styles.companySwitcher}>
          <div style={styles.companySwitcherLabel}>Current Company</div>
          <div style={styles.companySwitcherValue}>{company.name}</div>
          <div style={styles.companySwitcherStore}>{company.storeName}</div>
        </div>

        <nav style={styles.nav}>
          <Link
            to={`/sales/portal?companyId=${company.id}`}
            style={styles.navItem}
          >
            <span style={styles.navIcon}>📊</span> Overview
          </Link>
          <Link
            to={`/sales/portal/company/${company.id}/orders`}
            style={{ ...styles.navItem, ...styles.navItemActive }}
          >
            <span style={styles.navIcon}>📦</span> Orders ({orders.length})
          </Link>
        </nav>

        {/* Other Companies */}
        {allCompanies.length > 1 && (
          <div style={styles.otherCompanies}>
            <div style={styles.otherCompaniesLabel}>Switch Company</div>
            {allCompanies
              .filter((c) => c.id !== company.id)
              .map((c) => (
                <Link
                  key={c.id}
                  to={`/sales/portal?companyId=${c.id}`}
                  style={styles.companyLink}
                >
                  🏢 {c.name}
                </Link>
              ))}
          </div>
        )}

        <div style={styles.sidebarFooter}>
          <div style={styles.userProfile}>
            <div style={styles.avatar}>
              {user.firstName?.charAt(0) || user.email.charAt(0).toUpperCase()}
            </div>
            <div style={styles.userInfo}>
              <div style={styles.userName}>
                {user.firstName} {user.lastName}
              </div>
              <div style={styles.userRole}>Sales Agent</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: "8px", flexDirection: "column" }}>
            <Link
              to={`/sales/portal?companyId=${company.id}`}
              style={styles.backLink}
            >
              ← Back to Portal
            </Link>
            <Form method="post">
              <input type="hidden" name="intent" value="logout" />
              <button type="submit" style={styles.logoutBtn}>
                Sign Out
              </button>
            </Form>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main style={styles.mainContent}>
        <header
          style={{
            ...styles.header,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <h1 style={styles.heroTitle}>Manage Orders</h1>
            <p style={styles.subtitle}>
              List, review, and manage B2B orders for {company.name}
            </p>
          </div>
          <div>
            <Link
              to={`/sales/portal/company/${company.id}/create-order`}
              style={styles.createOrderBtn}
            >
              + Create Order
            </Link>
          </div>
        </header>

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
            <div style={styles.tableContainer}>
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
                    <th style={{ ...styles.th, textAlign: "right" }}>
                      Actions
                    </th>
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
                          <strong>{formatCurrency(order.orderTotal)}</strong>
                        </td>
                        <td style={styles.td}>
                          {getStatusBadge(order.paymentStatus)}
                        </td>
                        <td style={styles.td}>
                          {getStatusBadge(order.orderStatus)}
                        </td>
                        <td style={{ ...styles.td, textAlign: "right" }}>
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
                            <span
                              style={{ fontSize: "12px", color: "#8c9196" }}
                            >
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
      </main>
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    minHeight: "100vh",
    backgroundColor: "#fafafa",
    fontFamily: "'Inter', system-ui, sans-serif",
  },
  sidebar: {
    width: "280px",
    minWidth: "280px",
    backgroundColor: "#ffffff",
    borderRight: "1px solid #eaeaea",
    display: "flex",
    flexDirection: "column" as const,
    padding: "24px 0",
  },
  logoContainer: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "0 24px",
    marginBottom: "24px",
  },
  logoIcon: {
    width: "48px",
    height: "48px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  logoImage: {
    width: "100%",
    height: "100%",
    objectFit: "contain",
  },
  logoText: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: "20px",
    fontWeight: 700,
    background: "linear-gradient(135deg, #E91E63 0%, #FF6B35 100%)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
  },
  companySwitcher: {
    margin: "0 16px 24px",
    padding: "14px 16px",
    borderRadius: "12px",
    background: "linear-gradient(135deg, #fdf4f7 0%, #fff7eb 100%)",
    border: "1px solid #f8d7e3",
  },
  companySwitcherLabel: {
    fontSize: "11px",
    fontWeight: 600,
    textTransform: "uppercase" as const,
    color: "#8c9196",
    letterSpacing: "0.06em",
    marginBottom: "4px",
  },
  companySwitcherValue: {
    fontSize: "15px",
    fontWeight: 700,
    color: "#E91E63",
    fontFamily: "'Poppins', sans-serif",
  },
  companySwitcherStore: {
    fontSize: "12px",
    color: "#8c9196",
    marginTop: "2px",
  },
  nav: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "4px",
    padding: "0 12px",
    flex: 1,
  },
  navItem: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "11px 16px",
    textDecoration: "none",
    color: "#5c5f62",
    borderRadius: "10px",
    fontWeight: 500,
    fontSize: "14px",
    transition: "all 0.2s ease",
  },
  navItemActive: {
    backgroundColor: "#fff0f4",
    color: "#E91E63",
    fontWeight: 600,
  },
  navIcon: { fontSize: "16px" },
  otherCompanies: {
    padding: "16px 24px",
    borderTop: "1px solid #eaeaea",
    marginTop: "8px",
  },
  otherCompaniesLabel: {
    fontSize: "11px",
    fontWeight: 600,
    textTransform: "uppercase" as const,
    color: "#8c9196",
    letterSpacing: "0.06em",
    marginBottom: "12px",
  },
  companyLink: {
    display: "block",
    padding: "8px 12px",
    borderRadius: "8px",
    textDecoration: "none",
    color: "#202223",
    fontSize: "13px",
    fontWeight: 500,
    marginBottom: "4px",
    transition: "background-color 0.2s",
    backgroundColor: "#f9fafb",
    border: "1px solid #eaeaea",
  },
  sidebarFooter: {
    padding: "16px 24px",
    borderTop: "1px solid #eaeaea",
  },
  userProfile: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    marginBottom: "12px",
  },
  avatar: {
    width: "36px",
    height: "36px",
    borderRadius: "50%",
    background: "linear-gradient(135deg, #E91E63 0%, #FF6B35 100%)",
    color: "white",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 600,
    fontSize: "14px",
    fontFamily: "'Poppins', sans-serif",
  },
  userInfo: { display: "flex", flexDirection: "column" as const },
  userName: { fontWeight: 600, fontSize: "13px", color: "#202223" },
  userRole: { fontSize: "11px", color: "#8c9196" },
  backLink: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    fontSize: "13px",
    color: "#2c6ecb",
    textDecoration: "none",
    fontWeight: 500,
    marginBottom: "8px",
  },
  logoutBtn: {
    width: "100%",
    padding: "8px 14px",
    borderRadius: "8px",
    border: "1px solid #e5e7eb",
    backgroundColor: "#fff",
    color: "#6b7280",
    fontSize: "12px",
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "'Inter', sans-serif",
  },
  mainContent: {
    flex: 1,
    padding: "32px 40px",
    overflowY: "auto" as const,
  },
  header: { marginBottom: "28px" },
  heroTitle: {
    fontFamily: "'Poppins', sans-serif",
    fontSize: "28px",
    fontWeight: 700,
    color: "#111",
    margin: "0 0 6px 0",
    letterSpacing: "-0.02em",
  },
  subtitle: {
    fontSize: "15px",
    color: "#5c5f62",
    margin: 0,
  },
  createOrderBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    padding: "10px 18px",
    backgroundColor: "#111827",
    color: "#ffffff",
    borderRadius: "8px",
    textDecoration: "none",
    fontWeight: 500,
    fontSize: "14px",
    transition: "background-color 0.2s",
  },
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
