import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { Link, useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getCreditSummary } from "../services/creditService";
import { getCompanyDashboardData } from "../services/company.server";
import {parseForm, parseCredit, syncShopifyUsers } from "../utils/company.server";
import { useState } from "react";

type LoaderData = {
  company: {
    id: string;
    name: string;
    contactName: string | null;
    contactEmail: string | null;
    shopifyCompanyId: string | null;
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
  users: Array<{
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    role: string;
    companyRole: string | null;
    status: string;
    createdAt: string;
  }>;
  totalUsers: number;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!store) {
    return Response.json(
      { intent: "unknown", success: false, errors: ["Store not found"] },
      { status: 404 },
    );
  }

  const form = await parseForm(request);
  const intent = (form.intent as string) || "";

  switch (intent) {
    case "updateCredit": {
      const id = (form.id as string)?.trim();
      const creditRaw = (form.creditLimit as string) || "0";
      const credit = parseCredit(creditRaw);

      if (!id) {
        return Response.json({
          intent,
          success: false,
          errors: ["Company id is required"],
        });
      }
      if (!credit) {
        return Response.json({
          intent,
          success: false,
          errors: ["Credit must be a number"],
        });
      }

      await prisma.companyAccount.update({
        where: { id },
        data: { creditLimit: credit },
      });

      return Response.json({
        intent,
        success: true,
        message: "Credit updated",
      });
    }

    case "createCompany": {
      const name = (form.name as string)?.trim();
      const shopifyCompanyId =
        (form.shopifyCompanyId as string)?.trim() || null;
      const contactName = (form.contactName as string)?.trim() || null;
      const contactEmail = (form.contactEmail as string)?.trim() || null;
      const credit = parseCredit((form.creditLimit as string) || undefined);

      if (!name) {
        return Response.json({
          intent,
          success: false,
          errors: ["Company name is required"],
        });
      }
      if (!credit) {
        return Response.json({
          intent,
          success: false,
          errors: ["Credit must be a number"],
        });
      }

      if (shopifyCompanyId) {
        await prisma.companyAccount.upsert({
          where: {
            shopId_shopifyCompanyId: {
              shopId: store.id,
              shopifyCompanyId,
            },
          },
          update: {
            name,
            contactName,
            contactEmail,
            creditLimit: credit,
          },
          create: {
            shopId: store.id,
            shopifyCompanyId,
            name,
            contactName,
            contactEmail,
            creditLimit: credit,
          },
        });
      } else {
        await prisma.companyAccount.create({
          data: {
            shopId: store.id,
            shopifyCompanyId: null,
            name,
            contactName,
            contactEmail,
            creditLimit: credit,
          },
        });
      }

      return Response.json({ intent, success: true, message: "Company saved" });
    }

    case "syncUsers": {
      try {
        const result = await syncShopifyUsers(admin, store);
        return Response.json({
          intent,
          success: result.success,
          message: result.message,
          syncedCount: result.syncedCount,
          errors: result.errors,
        });
      } catch (error) {
        return Response.json({
          intent,
          success: false,
          message: "Failed to sync users",
          errors: [error instanceof Error ? error.message : "Unknown error"],
        }, { status: 500 });
      }
    }

    default:
      return Response.json({
        intent,
        success: false,
        errors: ["Unknown intent"],
      });
  }
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

  // Get company dashboard data from service
  const dashboardData = await getCompanyDashboardData(companyId, store.id);

  if (!dashboardData) {
    throw new Response("Company not found", { status: 404 });
  }

  // Get credit summary
  const creditSummary = await getCreditSummary(companyId);

  if (!creditSummary) {
    throw new Response("Unable to fetch credit summary", { status: 500 });
  }

  const creditPercentageUsed =
    creditSummary.creditLimit.toNumber() > 0
      ? ((creditSummary.usedCredit.toNumber() +
          creditSummary.pendingCredit.toNumber()) /
          creditSummary.creditLimit.toNumber()) *
        100
      : 0;

  return Response.json({
    company: {
      id: dashboardData.company.id,
      name: dashboardData.company.name,
      contactName: dashboardData.company.contactName,
      contactEmail: dashboardData.company.contactEmail,
      shopifyCompanyId: dashboardData.company.shopifyCompanyId,
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
    recentOrders: dashboardData.recentOrders.map((order) => ({
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
    orderStats: dashboardData.orderStats,
    users: dashboardData.users.map((user) => ({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      companyRole: user.companyRole,
      status: user.status,
      createdAt: user.createdAt.toISOString(),
    })),
    totalUsers: dashboardData.totalUsers,
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
  const fetcher = useFetcher();
  const [isEditingCredit, setIsEditingCredit] = useState(false);
  const [creditLimitValue, setCreditLimitValue] = useState(
    data.creditLimit.toString()
  );

  const creditStatus = getCreditStatusColor(data.creditPercentageUsed);
  const creditStatusColor =
    creditStatus === "success"
      ? "#008060"
      : creditStatus === "warning"
        ? "#b98900"
        : "#d72c0d";

  const handleCreditUpdate = () => {
    const formData = new FormData();
    formData.append("intent", "updateCredit");
    formData.append("id", data.company.id);
    formData.append("creditLimit", creditLimitValue);

    fetcher.submit(formData, { method: "POST" });
    setIsEditingCredit(false);
  };

  const handleCancelEdit = () => {
    setCreditLimitValue(data.creditLimit.toString());
    setIsEditingCredit(false);
  };

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
              gridTemplateColumns: "2fr 1.5fr 2fr 1.5fr",
              gap: 24,
              alignItems: "start",
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

            {/* Credit Limit - Editable */}
            <div>
              <div
                style={{
                  fontSize: 12,
                  color: "#5c5f62",
                  marginBottom: 6,
                  fontWeight: 500,
                }}
              >
                Credit Limit
              </div>
              {isEditingCredit ? (
                <div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input
                      type="number"
                      value={creditLimitValue}
                      onChange={(e) => setCreditLimitValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          handleCreditUpdate();
                        } else if (e.key === "Escape") {
                          handleCancelEdit();
                        }
                      }}
                      autoFocus
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        padding: "4px 8px",
                        border: "1px solid #c9ccd0",
                        borderRadius: 4,
                        width: "100px",
                      }}
                      step="0.01"
                      min="0"
                    />
                    <button
                      onClick={handleCreditUpdate}
                      disabled={fetcher.state === "submitting"}
                      style={{
                        padding: "4px 8px",
                        fontSize: 11,
                        fontWeight: 500,
                        backgroundColor: "#008060",
                        color: "white",
                        border: "none",
                        borderRadius: 4,
                        cursor: fetcher.state === "submitting" ? "not-allowed" : "pointer",
                        opacity: fetcher.state === "submitting" ? 0.6 : 1,
                      }}
                    >
                      {fetcher.state === "submitting" ? "..." : "✓"}
                    </button>
                  </div>
                  {fetcher.data?.intent === "updateCredit" && fetcher.data?.success && (
                    <div
                      style={{
                        fontSize: 11,
                        color: "#008060",
                        marginTop: 4,
                      }}
                    >
                      ✓ Updated successfully
                    </div>
                  )}
                  {fetcher.data?.intent === "updateCredit" && !fetcher.data?.success && (
                    <div
                      style={{
                        fontSize: 11,
                        color: "#d72c0d",
                        marginTop: 4,
                      }}
                    >
                      {fetcher.data?.errors?.[0] || "Failed to update"}
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "#202223",
                    }}
                  >
                    {formatCurrency(data.creditLimit)}
                  </div>
                  <s-button
                    onClick={() => setIsEditingCredit(true)}
                    variant="primary"
                  >
                    Edit
                  </s-button>
                </div>
              )}
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
        <s-section>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Users</h3>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => {
                  const formData = new FormData();
                  formData.append("intent", "syncUsers");
                  fetcher.submit(formData, { method: "POST" });
                }}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "1px solid #c9ccd0",
                  color: "#202223",
                  fontSize: 12,
                  fontWeight: 500,
                  backgroundColor: "white",
                  cursor: "pointer",
                  textAlign: "center",
                }}
                disabled={fetcher.state === "submitting"}
              >
                {fetcher.state === "submitting" ? "Syncing..." : "Sync Users"}
              </button>
              <Link
                to={`/app/companies/${data.company.id}/users`}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "1px solid #c9ccd0",
                  textDecoration: "none",
                  color: "#202223",
                  fontSize: 12,
                  fontWeight: 500,
                  backgroundColor: "white",
                  cursor: "pointer",
                  textAlign: "center",
                }}
              >
                View All User
              </Link>
            </div>
          </div>
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Total Users:</span>
              <strong>{data.totalUsers}</strong>
            </div>
            <div style={{ borderTop: "1px solid #e0e0e0" }} />
            {data.users.slice(0, 3).map((user) => (
              <div
                key={user.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  fontSize: 13,
                }}
              >
                <div>
                  <div style={{ fontWeight: 500 }}>
                    {[user.firstName, user.lastName].filter(Boolean).join(" ") ||
                      user.email}
                  </div>
                  <div style={{ fontSize: 11, color: "#5c5f62" }}>
                    {user.companyRole || user.role}
                  </div>
                </div>
                <span
                  style={{
                    padding: "2px 6px",
                    borderRadius: 4,
                    fontSize: 11,
                    backgroundColor: user.status === "ACTIVE" ? "#d4f3e6" : "#e0e0e0",
                    color: user.status === "ACTIVE" ? "#008060" : "#5c5f62",
                  }}
                >
                  {user.status}
                </span>
              </div>
            ))}
          </div>
        </s-section>

      {/* Recent Orders */}
     <s-section>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Recent Orders</h3>
          <Link
            to={`/app/companies/${data.company.id}/orders`}
            style={{
              padding: "6px 12px",
              borderRadius: 6,
              border: "1px solid #c9ccd0",
              textDecoration: "none",
              color: "#202223",
              fontSize: 12,
              fontWeight: 500,
              backgroundColor: "white",
              cursor: "pointer",
            }}
          >
            View All Orders
          </Link>
        </div>
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
