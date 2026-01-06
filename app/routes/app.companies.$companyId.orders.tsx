import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getCompanyOrders } from "../services/company.server";

type LoaderData = {
  company: {
    name: string;
    shopifyCompanyId: string | null;
  };
  orders: Array<{
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
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

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

  const data = await getCompanyOrders(companyId, store.id);

  if (!data) {
    throw new Response("Company not found", { status: 404 });
  }

  return Response.json({
    company: {
      name: data.company.name,
      shopifyCompanyId: data.company.shopifyCompanyId,
    },
    orders: data.orders.map((order) => ({
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
  } satisfies LoaderData);
};

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

export default function CompanyOrdersPage() {
  const data = useLoaderData<LoaderData>();

  return (
    <s-page heading={`${data.company.name} - Orders`}>
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

      <s-section>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 16,
          }}
        >
          <h3 style={{ margin: 0 }}>All Orders ({data.orders.length})</h3>
        </div>

        {data.orders.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                minWidth: 900,
              }}
            >
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
                    Shopify Order ID
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
                {data.orders.map((order) => (
                  <tr
                    key={order.id}
                    style={{ borderBottom: "1px solid #e0e0e0" }}
                  >
                    <td style={{ padding: 12, fontSize: 13, fontWeight: 500 }}>
                      {order.id.substring(0, 8)}
                    </td>
                    <td style={{ padding: 12, fontSize: 12, color: "#5c5f62" }}>
                      {order.shopifyOrderId || "—"}
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
            <p>No orders found for this company.</p>
          </div>
        )}
      </s-section>
    </s-page>
  );
}
