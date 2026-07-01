import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getCreditTransactionsByCompany } from "../services/company.server";

type LoaderData = {
  company: {
    name: string;
    shopifyCompanyId: string | null;
  };
  shop: string;
  currencyCode: string;
  creditTransactions: Array<{
    id: string;
    amount: number;
    orderName: string;
    transactionType: string;
    createdAt: string;
    createdByName: string;
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

  const company = await prisma.companyAccount.findUnique({
    where: { id: companyId },
    select: {
      id: true,
      name: true,
      shopifyCompanyId: true,
    },
  });

  if (!company) {
    throw new Response("Company not found", { status: 404 });
  }

  const creditTransactions = await getCreditTransactionsByCompany(companyId, {
    orderBy: { createdAt: "desc" },
    shop: session.shop,
    accessToken: store.accessToken,
  });

  return Response.json({
    company: {
      name: company.name,
      shopifyCompanyId: company.shopifyCompanyId,
    },
    shop: session.shop,
    currencyCode: store.currencyCode || "USD",
    creditTransactions: creditTransactions.map((tx: any) => {
      // Handle creditAmount - Prisma Decimal, number, or string
      let amount = 0;
      const rawAmount = tx.creditAmount ?? tx.amount; // Support both field names
      if (rawAmount) {
        if (typeof rawAmount.toNumber === "function") {
          amount = rawAmount.toNumber();
        } else if (typeof rawAmount === "number") {
          amount = rawAmount;
        } else if (typeof rawAmount === "string") {
          amount = parseFloat(rawAmount);
        }
      }

      return {
        id: tx.id,
        amount: amount,
        orderName: tx.orderName || tx.orderId || "Manual Adjustment",
        transactionType: tx.transactionType || "adjustment",
        createdAt: tx.createdAt ? tx.createdAt.toISOString() : new Date().toISOString(),
        createdByName: tx.createdByName || "System",
      };
    }),
  } satisfies LoaderData);
};

function formatCurrency(amount: number, currency: string = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency,
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

function getTransactionTypeBadge(type: string) {
  const typeMap: Record<string, string> = {
    usage: "critical",
    adjustment: "warning",
    return: "success",
    manual: "info",
  };

  const status = typeMap[type.toLowerCase()] || "info";
  const colors: Record<string, { bg: string; text: string }> = {
    critical: { bg: "#FEE5E7", text: "#DC3545" },
    warning: { bg: "#FFF3CD", text: "#856404" },
    success: { bg: "#D4EDDA", text: "#155724" },
    info: { bg: "#D1ECF1", text: "#0C5460" },
  };

  const color = colors[status];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "4px 8px",
        borderRadius: "4px",
        backgroundColor: color.bg,
        color: color.text,
        fontSize: 12,
        fontWeight: 500,
      }}
    >
      {type.charAt(0).toUpperCase() + type.slice(1)}
    </span>
  );
}

export default function CreditTransactionHistory() {
  const data = useLoaderData<typeof loader>();

  return (
    <div style={{ padding: "20px", backgroundColor: "#f5f5f5", minHeight: "100vh" }}>
      {/* Main Container */}
      <div style={{ maxWidth: "1200px", margin: "0 auto" }}>
        {/* Back to Companies Link */}
        <Link
          to="/app/companies"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            color: "#0066ff",
            textDecoration: "none",
            fontSize: "14px",
            fontWeight: 500,
            marginBottom: "24px",
            cursor: "pointer",
          }}
        >
          <span style={{ fontSize: "18px" }}>←</span> Back to Companies
        </Link>

        {/* Header Section */}
        <div style={{ marginBottom: "24px" }}>
          <h1 style={{ margin: "0 0 8px 0", fontSize: "24px", fontWeight: "600" }}>
            Credit Transaction History
          </h1>
          <p style={{ margin: 0, fontSize: "14px", color: "#5c5f62" }}>
            {data.company.name}
          </p>
        </div>
        {/* Summary Stats */}
        {data.creditTransactions.length > 0 && (
          <div style={{ marginTop: "24px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: "16px" }}>
            <div style={{ padding: "16px", backgroundColor: "#fff", borderRadius: "8px", border: "1px solid #e0e0e0" }}>
              <div style={{ fontSize: "12px", color: "#5c5f62", marginBottom: "8px", fontWeight: "600" }}>
                Total Deductions
              </div>
              <div style={{ fontSize: "20px", fontWeight: "600", color: "#d32f2f" }}>
                {formatCurrency(
                  Math.abs(
                    data.creditTransactions
                      .filter((tx) => tx.amount < 0)
                      .reduce((sum, tx) => sum + tx.amount, 0)
                  ),
                  data.currencyCode
                )}
              </div>
            </div>

            <div style={{ padding: "16px", backgroundColor: "#fff", borderRadius: "8px", border: "1px solid #e0e0e0" }}>
              <div style={{ fontSize: "12px", color: "#5c5f62", marginBottom: "8px", fontWeight: "600" }}>
                Total Credits Returned
              </div>
              <div style={{ fontSize: "20px", fontWeight: "600", color: "#2e7d32" }}>
                {formatCurrency(
                  Math.abs(
                    data.creditTransactions
                      .filter((tx) => tx.amount > 0)
                      .reduce((sum, tx) => sum + tx.amount, 0)
                  ),
                  data.currencyCode
                )}
              </div>
            </div>

            <div style={{ padding: "16px", backgroundColor: "#fff", borderRadius: "8px", border: "1px solid #e0e0e0" }}>
              <div style={{ fontSize: "12px", color: "#5c5f62", marginBottom: "8px", fontWeight: "600" }}>
                Total Transactions
              </div>
              <div style={{ fontSize: "20px", fontWeight: "600", color: "#1976d2" }}>
                {data.creditTransactions.length}
              </div>
            </div>
          </div>
        )}
        {/* Table Card */}
        <div style={{ backgroundColor: "#fff", borderRadius: "8px", overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.1)" }}>
          {data.creditTransactions.length > 0 ? (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid #e0e0e0", backgroundColor: "#f9f9f9" }}>
                    <th
                      style={{
                        padding: "16px 12px",
                        textAlign: "left",
                        fontSize: "12px",
                        fontWeight: "600",
                        color: "#5c5f62",
                        textTransform: "uppercase",
                        letterSpacing: "0.5px",
                      }}
                    >
                      Order / Description
                    </th>
                    <th
                      style={{
                        padding: "16px 12px",
                        textAlign: "left",
                        fontSize: "12px",
                        fontWeight: "600",
                        color: "#5c5f62",
                        textTransform: "uppercase",
                        letterSpacing: "0.5px",
                      }}
                    >
                      Type
                    </th>
                    <th
                      style={{
                        padding: "16px 12px",
                        textAlign: "right",
                        fontSize: "12px",
                        fontWeight: "600",
                        color: "#5c5f62",
                        textTransform: "uppercase",
                        letterSpacing: "0.5px",
                      }}
                    >
                      Amount
                    </th>
                    <th
                      style={{
                        padding: "16px 12px",
                        textAlign: "left",
                        fontSize: "12px",
                        fontWeight: "600",
                        color: "#5c5f62",
                        textTransform: "uppercase",
                        letterSpacing: "0.5px",
                      }}
                    >
                      Date
                    </th>
                    <th
                      style={{
                        padding: "16px 12px",
                        textAlign: "left",
                        fontSize: "12px",
                        fontWeight: "600",
                        color: "#5c5f62",
                        textTransform: "uppercase",
                        letterSpacing: "0.5px",
                      }}
                    >
                      Created By
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.creditTransactions.map((tx) => (
                    <tr
                      key={tx.id}
                      style={{
                        borderBottom: "1px solid #e0e0e0",
                        transition: "background-color 0.2s",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#f9f9f9")}
                      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                    >
                      <td style={{ padding: "12px", fontSize: "13px", color: "#000" }}>
                        {tx.orderName || "—"}
                      </td>
                      <td style={{ padding: "12px", fontSize: "13px" }}>
                        {getTransactionTypeBadge(tx.transactionType)}
                      </td>
                      <td
                        style={{
                          padding: "12px",
                          textAlign: "right",
                          fontSize: "13px",
                          fontWeight: "600",
                          color: tx.amount < 0 ? "#d32f2f" : "#2e7d32",
                        }}
                      >
                        {tx.amount < 0 ? "−" : "+"} {" "}
                        {formatCurrency(Math.abs(tx.amount), data.currencyCode)}
                      </td>
                      <td style={{ padding: "12px", fontSize: "13px", color: "#5c5f62" }}>
                        {formatDate(tx.createdAt)}
                      </td>
                      <td style={{ padding: "12px", fontSize: "13px", color: "#000" }}>
                        {tx.createdByName}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ padding: "60px 20px", textAlign: "center" }}>
              <div style={{ color: "#5c5f62", fontSize: "14px" }}>
                <p style={{ margin: "0 0 8px 0" }}>📊 No credit transactions yet.</p>
                <p style={{ margin: 0, fontSize: "12px" }}>
                  Credit transactions will appear here once orders are created or credit adjustments are made.
                </p>
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}