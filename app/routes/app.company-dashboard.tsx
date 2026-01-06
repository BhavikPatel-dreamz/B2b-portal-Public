import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getCreditSummary } from "../services/creditService";

type LoaderData = {
  company: {
    id: string;
    name: string;
    contactName: string | null;
    contactEmail: string | null;
  };
  creditLimit: number;
  availableCredit: number;
  usedCredit: number;
  pendingCredit: number;
  creditPercentageUsed: number;
  pendingOrderCount: number;
  recentTransactions: Array<{
    id: string;
    transactionType: string;
    creditAmount: number;
    previousBalance: number;
    newBalance: number;
    notes: string | null;
    createdAt: string;
    orderId: string | null;
  }>;
  recentOrders: Array<{
    id: string;
    shopifyOrderId: string | null;
    orderTotal: number;
    paidAmount: number;
    remainingBalance: number;
    paymentStatus: string;
    orderStatus: string;
    createdAt: string;
    createdBy: string;
  }>;
  orderStats: {
    total: number;
    paid: number;
    unpaid: number;
    pending: number;
  };
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const companyId = params.companyId;
  if (!companyId) {
    throw new Response("Company ID is required", { status: 400 });
  }

  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!store) {
    throw new Response("Store not found", { status: 404 });
  }

  // Get company
  const company = await prisma.companyAccount.findUnique({
    where: { id: companyId },
    select: {
      id: true,
      name: true,
      contactName: true,
      contactEmail: true,
      shopId: true,
    },
  });

  if (!company || company.shopId !== store.id) {
    throw new Response("Company not found", { status: 404 });
  }

  // Get credit summary
  const creditSummary = await getCreditSummary(companyId);

  if (!creditSummary) {
    throw new Response("Unable to fetch credit summary", { status: 500 });
  }

  // Get recent orders
  const recentOrders = await prisma.b2BOrder.findMany({
    where: {
      companyId,
      orderStatus: { not: "cancelled" },
    },
    orderBy: {
      createdAt: "desc",
    },
    take: 10,
    include: {
      createdByUser: {
        select: {
          email: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  });

  // Get order statistics
  const [totalOrders, paidOrders, unpaidOrders, pendingOrders] =
    await Promise.all([
      prisma.b2BOrder.count({
        where: { companyId, orderStatus: { not: "cancelled" } },
      }),
      prisma.b2BOrder.count({
        where: {
          companyId,
          paymentStatus: "paid",
          orderStatus: { not: "cancelled" },
        },
      }),
      prisma.b2BOrder.count({
        where: {
          companyId,
          paymentStatus: { in: ["pending", "partial"] },
          orderStatus: { not: "cancelled" },
        },
      }),
      prisma.b2BOrder.count({
        where: {
          companyId,
          orderStatus: { in: ["draft", "submitted", "processing"] },
        },
      }),
    ]);

  const creditPercentageUsed =
    creditSummary.creditLimit.toNumber() > 0
      ? ((creditSummary.usedCredit.toNumber() +
          creditSummary.pendingCredit.toNumber()) /
          creditSummary.creditLimit.toNumber()) *
        100
      : 0;

  return Response.json({
    company: {
      id: company.id,
      name: company.name,
      contactName: company.contactName,
      contactEmail: company.contactEmail,
    },
    creditLimit: creditSummary.creditLimit.toNumber(),
    availableCredit: creditSummary.availableCredit.toNumber(),
    usedCredit: creditSummary.usedCredit.toNumber(),
    pendingCredit: creditSummary.pendingCredit.toNumber(),
    creditPercentageUsed,
    pendingOrderCount: creditSummary.pendingOrderCount,
    recentTransactions: creditSummary.recentTransactions.map((tx) => ({
      id: tx.id,
      transactionType: tx.transactionType,
      creditAmount: tx.creditAmount.toNumber(),
      previousBalance: tx.previousBalance.toNumber(),
      newBalance: tx.newBalance.toNumber(),
      notes: tx.notes,
      createdAt: tx.createdAt.toISOString(),
      orderId: tx.orderId,
    })),
    recentOrders: recentOrders.map((order) => ({
      id: order.id,
      shopifyOrderId: order.shopifyOrderId,
      orderTotal: order.orderTotal.toNumber(),
      paidAmount: order.paidAmount.toNumber(),
      remainingBalance: order.remainingBalance.toNumber(),
      paymentStatus: order.paymentStatus,
      orderStatus: order.orderStatus,
      createdAt: order.createdAt.toISOString(),
      createdBy:
        [order.createdByUser.firstName, order.createdByUser.lastName]
          .filter(Boolean)
          .join(" ") || order.createdByUser.email,
    })),
    orderStats: {
      total: totalOrders,
      paid: paidOrders,
      unpaid: unpaidOrders,
      pending: pendingOrders,
    },
  } satisfies LoaderData);
};

function getCreditStatusColor(
  percentageUsed: number,
): "success" | "warning" | "critical" {
  if (percentageUsed < 70) return "success";
  if (percentageUsed < 90) return "warning";
  return "critical";
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getPaymentStatusBadge(status: string) {
  const statusMap: Record<string, string> = {
    paid: "success",
    partial: "warning",
    pending: "critical",
    cancelled: "info",
  };
  return (
    <span
      style={{
        padding: "4px 8px",
        borderRadius: "4px",
        fontSize: "12px",
        fontWeight: 500,
        backgroundColor:
          statusMap[status] === "success"
            ? "#d4f3e6"
            : statusMap[status] === "warning"
              ? "#fff4cc"
              : statusMap[status] === "critical"
                ? "#ffd4d4"
                : "#e0e0e0",
        color:
          statusMap[status] === "success"
            ? "#008060"
            : statusMap[status] === "warning"
              ? "#b98900"
              : statusMap[status] === "critical"
                ? "#d72c0d"
                : "#5c5f62",
      }}
    >
      {status.toUpperCase()}
    </span>
  );
}

function getOrderStatusBadge(status: string) {
  const statusMap: Record<string, string> = {
    delivered: "success",
    shipped: "info",
    processing: "warning",
    submitted: "warning",
    draft: "info",
    cancelled: "critical",
  };
  return (
    <span
      style={{
        padding: "4px 8px",
        borderRadius: "4px",
        fontSize: "12px",
        fontWeight: 500,
        backgroundColor:
          statusMap[status] === "success"
            ? "#d4f3e6"
            : statusMap[status] === "warning"
              ? "#fff4cc"
              : statusMap[status] === "critical"
                ? "#ffd4d4"
                : "#e0e0e0",
        color:
          statusMap[status] === "success"
            ? "#008060"
            : statusMap[status] === "warning"
              ? "#b98900"
              : statusMap[status] === "critical"
                ? "#d72c0d"
                : "#5c5f62",
      }}
    >
      {status.toUpperCase()}
    </span>
  );
}

export default function CompanyDashboard() {
  const data = useLoaderData<LoaderData>();

  const creditStatus = getCreditStatusColor(data.creditPercentageUsed);
  const creditStatusColor =
    creditStatus === "success"
      ? "#008060"
      : creditStatus === "warning"
        ? "#b98900"
        : "#d72c0d";

  return (
    <s-page heading={`${data.company.name} - Credit Dashboard`}>
      <div style={{ marginBottom: 16 }}>
        <Link
          to="/app/companies"
          style={{
            color: "#005bd3",
            textDecoration: "none",
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          ← Back to Companies
        </Link>
      </div>

      {/* Company Information Section */}

      <s-section heading="Company Information">
        <div
          style={{
            border: "1px solid #e0e0e0",
            borderRadius: 8,
            padding: 16,
            backgroundColor: "#ffffff",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 24,
            }}
          >
            {/* Company Name */}
            <div>
              <div
                style={{
                  fontSize: 12,
                  color: "#5c5f62",
                  marginBottom: 6,
                  fontWeight: 500,
                }}
              >
                Company Name
              </div>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "#202223",
                }}
              >
                {data.company.name}
              </div>
            </div>

            {/* Contact Person */}
            <div>
              <div
                style={{
                  fontSize: 12,
                  color: "#5c5f62",
                  marginBottom: 6,
                  fontWeight: 500,
                }}
              >
                Contact Person
              </div>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "#202223",
                }}
              >
                {data.company.contactName || "—"}
              </div>
            </div>

            {/* Contact Email */}
            <div>
              <div
                style={{
                  fontSize: 12,
                  color: "#5c5f62",
                  marginBottom: 6,
                  fontWeight: 500,
                }}
              >
                Contact Email
              </div>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "#202223",
                  wordBreak: "break-word",
                }}
              >
                {data.company.contactEmail || "—"}
              </div>
            </div>
          </div>
        </div>
      </s-section>
      {/* Top Row: Company Info, Credit Status, Order Summary */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, 1fr)",
          gap: 10,
          marginBottom: 10,
        }}
      >
        {/* Company Information Section */}
        {/* Credit Overview */}
        <s-section heading="Credit Status">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, 1fr)",
              gap: 12,
            }}
          >
            <div>
              <div style={{ fontSize: 12, color: "#5c5f62", marginBottom: 4 }}>
                Credit Limit
              </div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>
                {formatCurrency(data.creditLimit)}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "#5c5f62", marginBottom: 4 }}>
                Available Credit
              </div>
              <div
                style={{
                  fontSize: 20,
                  fontWeight: 600,
                  color: creditStatusColor,
                }}
              >
                {formatCurrency(data.availableCredit)}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "#5c5f62", marginBottom: 4 }}>
                Used Credit
              </div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>
                {formatCurrency(data.usedCredit)}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "#5c5f62", marginBottom: 4 }}>
                Pending Credit
              </div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>
                {formatCurrency(data.pendingCredit)}
              </div>
              <div style={{ fontSize: 11, color: "#5c5f62", marginTop: 2 }}>
                {data.pendingOrderCount} pending orders
              </div>
            </div>
          </div>
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 12, marginBottom: 8 }}>
              Credit Usage: {data.creditPercentageUsed.toFixed(1)}%
            </div>
            <div
              style={{
                width: "100%",
                height: 8,
                backgroundColor: "#e0e0e0",
                borderRadius: 4,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${Math.min(data.creditPercentageUsed, 100)}%`,
                  height: "100%",
                  backgroundColor: creditStatusColor,
                  transition: "width 0.3s ease",
                }}
              />
            </div>
          </div>
        </s-section>

        {/* Order Statistics */}
        <s-section heading="Order Summary">
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Total Orders:</span>
              <strong>{data.orderStats.total}</strong>
            </div>
            <div style={{ borderTop: "1px solid #e0e0e0" }} />
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                color: "#008060",
              }}
            >
              <span>Paid:</span>
              <span>{data.orderStats.paid}</span>
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                color: "#d72c0d",
              }}
            >
              <span>Unpaid:</span>
              <span>{data.orderStats.unpaid}</span>
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                color: "#b98900",
              }}
            >
              <span>Pending:</span>
              <span>{data.orderStats.pending}</span>
            </div>
          </div>
        </s-section>
      </div>

      {/* Recent Orders */}
      <s-section heading="Recent Orders">
        {data.recentOrders.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e0e0e0" }}>
                  <th
                    style={{
                      padding: 12,
                      textAlign: "left",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    Order ID
                  </th>
                  <th
                    style={{
                      padding: 12,
                      textAlign: "left",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    Date
                  </th>
                  <th
                    style={{
                      padding: 12,
                      textAlign: "right",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    Total
                  </th>
                  <th
                    style={{
                      padding: 12,
                      textAlign: "right",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    Paid
                  </th>
                  <th
                    style={{
                      padding: 12,
                      textAlign: "right",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    Balance
                  </th>
                  <th
                    style={{
                      padding: 12,
                      textAlign: "left",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    Payment
                  </th>
                  <th
                    style={{
                      padding: 12,
                      textAlign: "left",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    Status
                  </th>
                  <th
                    style={{
                      padding: 12,
                      textAlign: "left",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    Created By
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.recentOrders.map((order) => (
                  <tr
                    key={order.id}
                    style={{ borderBottom: "1px solid #e0e0e0" }}
                  >
                    <td style={{ padding: 12, fontSize: 13 }}>
                      {order.id.substring(0, 8)}
                    </td>
                    <td style={{ padding: 12, fontSize: 13 }}>
                      {formatDate(order.createdAt)}
                    </td>
                    <td
                      style={{ padding: 12, textAlign: "right", fontSize: 13 }}
                    >
                      {formatCurrency(order.orderTotal)}
                    </td>
                    <td
                      style={{ padding: 12, textAlign: "right", fontSize: 13 }}
                    >
                      {formatCurrency(order.paidAmount)}
                    </td>
                    <td
                      style={{ padding: 12, textAlign: "right", fontSize: 13 }}
                    >
                      {formatCurrency(order.remainingBalance)}
                    </td>
                    <td style={{ padding: 12 }}>
                      {getPaymentStatusBadge(order.paymentStatus)}
                    </td>
                    <td style={{ padding: 12 }}>
                      {getOrderStatusBadge(order.orderStatus)}
                    </td>
                    <td style={{ padding: 12, fontSize: 13 }}>
                      {order.createdBy}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ padding: 40, textAlign: "center", color: "#5c5f62" }}>
            <p>No orders yet. Orders will appear here when created.</p>
          </div>
        )}
      </s-section>

      {/* Recent Transactions */}
      <s-section heading="Recent Credit Transactions">
        {data.recentTransactions.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e0e0e0" }}>
                  <th
                    style={{
                      padding: 12,
                      textAlign: "left",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    Date
                  </th>
                  <th
                    style={{
                      padding: 12,
                      textAlign: "left",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    Type
                  </th>
                  <th
                    style={{
                      padding: 12,
                      textAlign: "right",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    Amount
                  </th>
                  <th
                    style={{
                      padding: 12,
                      textAlign: "right",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    New Balance
                  </th>
                  <th
                    style={{
                      padding: 12,
                      textAlign: "left",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    Notes
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.recentTransactions.map((tx) => (
                  <tr key={tx.id} style={{ borderBottom: "1px solid #e0e0e0" }}>
                    <td style={{ padding: 12, fontSize: 13 }}>
                      {formatDate(tx.createdAt)}
                    </td>
                    <td style={{ padding: 12, fontSize: 13 }}>
                      {tx.transactionType.replace(/_/g, " ").toUpperCase()}
                    </td>
                    <td
                      style={{
                        padding: 12,
                        textAlign: "right",
                        fontSize: 13,
                        color: tx.creditAmount >= 0 ? "#008060" : "#d72c0d",
                        fontWeight: 500,
                      }}
                    >
                      {tx.creditAmount >= 0 ? "+" : ""}
                      {formatCurrency(tx.creditAmount)}
                    </td>
                    <td
                      style={{ padding: 12, textAlign: "right", fontSize: 13 }}
                    >
                      {formatCurrency(tx.newBalance)}
                    </td>
                    <td style={{ padding: 12, fontSize: 13 }}>
                      {tx.notes || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ padding: 40, textAlign: "center", color: "#5c5f62" }}>
            <p>No transactions yet. Credit transactions will appear here.</p>
          </div>
        )}
      </s-section>
    </s-page>
  );
}
