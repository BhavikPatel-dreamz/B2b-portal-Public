import {
  useLoaderData,
  Link,
  useSearchParams,
  useNavigation,
  Form,
  useRevalidator,
} from "react-router";
import { useEffect, useRef } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";

type SortField = "createdAt" | "totalAmount" | "status";
type SortDirection = "asc" | "desc";

function formatDisplayDate(value: string) {
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

function formatCurrency(amount: string, currency: string) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(Number(amount) || 0);
}

function downloadCsv(filename: string, rows: string[][]) {
  const csv = rows
    .map((row) =>
      row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(","),
    )
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

const STATUS_OPTIONS = [
  "draft",
  "sent",
  "viewed",
  "approved",
  "rejected",
  "expired",
  "converted",
  "cancelled",
];

const STATUS_COLORS: Record<string, string> = {
  draft: "#6b21a8",
  sent: "#0369a1",
  viewed: "#1d4ed8",
  approved: "#166534",
  rejected: "#991b1b",
  expired: "#92400e",
  converted: "#334155",
  cancelled: "#6b7280",
};

export default function QuotesPage() {
  const {
    quotes,
    totalCount,
    currentPage,
    totalPages,
    searchQuery,
    statusFilter,
    dateFrom,
    dateTo,
    sortField,
    sortDirection,
    statusCounts,
  } = useLoaderData<any>();

  const [searchParams, setSearchParams] = useSearchParams();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const intervalIdRef = useRef<NodeJS.Timeout | null>(null);

  const isSearching =
    navigation.state !== "idle" &&
    (navigation.location?.search?.includes("search=") ||
      Boolean(searchParams.get("search")));

  // Auto-refresh every 30 seconds
  useEffect(() => {
    intervalIdRef.current = setInterval(() => {
      revalidator.revalidate();
    }, 30 * 1000);
    return () => {
      if (intervalIdRef.current) clearInterval(intervalIdRef.current);
    };
  }, [revalidator]);

  const toggleSort = (field: SortField) => {
    const nextDirection: SortDirection =
      sortField === field && sortDirection === "asc" ? "desc" : "asc";
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("page", "1");
      next.set("sortField", field);
      next.set("sortDirection", nextDirection);
      return next;
    });
  };

  const renderSortArrow = (field: SortField) => {
    if (sortField !== field)
      return <span style={{ color: "#8c9196", fontSize: 12 }}>↕</span>;
    return (
      <span style={{ color: "#2c6ecb", fontSize: 12 }}>
        {sortDirection === "asc" ? "↑" : "↓"}
      </span>
    );
  };

  const buildQueryString = (overrides: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams);
    Object.entries(overrides).forEach(([k, v]) => {
      if (!v) params.delete(k);
      else params.set(k, v);
    });
    return `?${params.toString()}`;
  };

  const exportCsv = () => {
    downloadCsv("quotes.csv", [
      ["Quote #", "Title", "Company", "Customer", "Total", "Status", "Agent", "Created", "Expires"],
      ...quotes.map((q: any) => [
        q.quoteNumber,
        q.title || "",
        q.companyName,
        `${q.customerFirstName || ""} ${q.customerLastName || ""} <${q.customerEmail}>`,
        formatCurrency(q.totalAmount, q.currencyCode),
        q.status,
        q.salesAgentName,
        formatDisplayDate(q.createdAt),
        formatDisplayDate(q.expiresAt),
      ]),
    ]);
  };

  const pageShellStyle = {
    background: "#f1f2f4",
    minHeight: "100vh",
    padding: "24px",
    boxSizing: "border-box",
    fontFamily: '-apple-system, BlinkMacSystemFont, "San Francisco", "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
  } as const;

  const pageHeroStyle = {
    width: "100%",
    maxWidth: 1200,
    margin: "0 auto 18px",
    padding: "0px 0px 16px 0px",
    borderRadius: 14,
    border: "1px solid #dfe3e8",
    background: "linear-gradient(135deg, #ffffff 0%)",
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
  } as const;

  const pageHeroTitleStyle = {
    fontSize: "22px",
    lineHeight: 1.15,
    fontWeight: 650,
    color: "#202223",
    margin: "15px",
  } as const;

  const pageHeroTextStyle = {
    fontSize: "14px",
    color: "#5c5f62",
    margin: "0 15px 0",
  } as const;

  const contentPanelStyle = {
    width: "100%",
    maxWidth: 1200,
    margin: "0 auto",
    boxSizing: "border-box",
  } as const;

  const toolbarStyle = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap" as const,
    marginBottom: 16,
    padding: 14,
    border: "1px solid #dde3ea",
    borderRadius: 14,
    background: "linear-gradient(180deg, #ffffff 0%, #f8fbff 100%)",
  } as const;

  const tableCardStyle = {
    position: "relative" as const,
    overflowX: "auto" as const,
    overflowY: "hidden" as const,
    border: "1px solid #e3e7ec",
    borderRadius: 12,
    background: "#ffffff",
  } as const;

  const tableHeaderCellStyle = {
    textAlign: "left" as const,
    padding: "14px 16px",
    fontSize: 13,
    fontWeight: 650,
    color: "#202223",
    background: "#fbfbfc",
    borderBottom: "1px solid #e3e7ec",
    whiteSpace: "nowrap" as const,
  } as const;

  const sortableHeaderButtonStyle = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    border: "none",
    background: "transparent",
    padding: 0,
    font: "inherit",
    fontWeight: 650,
    color: "#202223",
    cursor: "pointer",
  } as const;

  const tableCellStyle = {
    padding: "14px 16px",
    verticalAlign: "top" as const,
    lineHeight: 1.45,
    color: "#202223",
    borderTop: "1px solid #eef1f4",
  } as const;

  return (
    <div style={pageShellStyle}>
      <div style={pageHeroStyle}>
        <Link
          to="/app"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            color: "#2c6ecb",
            textDecoration: "none",
            fontSize: "14px",
            fontWeight: 600,
            margin: "15px 15px 5px",
          }}
        >
          <svg viewBox="0 0 20 20" style={{ width: "16px", height: "16px" }} fill="currentColor">
            <path
              fillRule="evenodd"
              d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z"
              clipRule="evenodd"
            />
          </svg>
          Back to Dashboard
        </Link>
        <h3 style={pageHeroTitleStyle}>Quotes</h3>
        <p style={pageHeroTextStyle}>
          View, manage, and track all quotes across your B2B companies.
        </p>
      </div>

      <div style={contentPanelStyle}>
        {/* Status summary bar */}
        <div
          style={{
            display: "flex",
            gap: 8,
            marginBottom: 16,
            flexWrap: "wrap",
          }}
        >
          <Link
            to={buildQueryString({ status: null, page: "1" })}
            style={{
              padding: "8px 14px",
              borderRadius: 8,
              border: "1px solid #c9ccd0",
              textDecoration: "none",
              fontWeight: !statusFilter ? 600 : 400,
              color: !statusFilter ? "white" : "#202223",
              background: !statusFilter ? "#005bd3" : "white",
              fontSize: 13,
            }}
          >
            All ({totalCount})
          </Link>
          {STATUS_OPTIONS.map((s) => (
            <Link
              key={s}
              to={buildQueryString({ status: s, page: "1" })}
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                border: "1px solid #c9ccd0",
                textDecoration: "none",
                fontWeight: statusFilter === s ? 600 : 400,
                color: statusFilter === s ? "white" : STATUS_COLORS[s] || "#202223",
                background: statusFilter === s ? STATUS_COLORS[s] || "#005bd3" : "white",
                fontSize: 13,
                textTransform: "capitalize",
              }}
            >
              {s} ({statusCounts[s] || 0})
            </Link>
          ))}
        </div>

        {/* Toolbar */}
        <div style={toolbarStyle}>
          <div
            style={{
              position: "relative",
              flex: "1 1 420px",
              minWidth: 260,
              display: "flex",
              alignItems: "center",
            }}
          >
            <input
              type="text"
              placeholder="Search by quote #, company, customer..."
              defaultValue={searchQuery}
              key={searchQuery}
              onBlur={(e) => {
                const value = e.target.value;
                setSearchParams((prev) => {
                  const next = new URLSearchParams(prev);
                  next.set("page", "1");
                  if (value) next.set("search", value);
                  else next.delete("search");
                  return next;
                });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const value = (e.target as HTMLInputElement).value;
                  setSearchParams((prev) => {
                    const next = new URLSearchParams(prev);
                    next.set("page", "1");
                    if (value) next.set("search", value);
                    else next.delete("search");
                    return next;
                  });
                }
              }}
              style={{
                width: "100%",
                minHeight: 40,
                padding: "8px 36px 8px 12px",
                borderRadius: 10,
                border: "1px solid #c9ccd0",
                fontSize: 14,
                outline: "none",
              }}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => {
                  setSearchParams((prev) => {
                    const next = new URLSearchParams(prev);
                    next.set("page", "1");
                    next.delete("search");
                    return next;
                  });
                }}
                style={{
                  position: "absolute",
                  right: 8,
                  top: "50%",
                  transform: "translateY(-50%)",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: "4px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: "50%",
                  width: 24,
                  height: 24,
                  fontSize: 16,
                  color: "#5c5f62",
                  lineHeight: 1,
                }}
                title="Clear search"
              >
                ✕
              </button>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginLeft: "auto" }}>
            <input
              type="date"
              defaultValue={dateFrom}
              key={dateFrom}
              onBlur={(e) => {
                setSearchParams((prev) => {
                  const next = new URLSearchParams(prev);
                  next.set("page", "1");
                  if (e.target.value) next.set("dateFrom", e.target.value);
                  else next.delete("dateFrom");
                  return next;
                });
              }}
              style={{
                minHeight: 36,
                padding: "6px 10px",
                borderRadius: 8,
                border: "1px solid #c9ccd0",
                fontSize: 13,
              }}
            />
            <span style={{ color: "#5c5f62", fontSize: 13 }}>to</span>
            <input
              type="date"
              defaultValue={dateTo}
              key={dateTo}
              onBlur={(e) => {
                setSearchParams((prev) => {
                  const next = new URLSearchParams(prev);
                  next.set("page", "1");
                  if (e.target.value) next.set("dateTo", e.target.value);
                  else next.delete("dateTo");
                  return next;
                });
              }}
              style={{
                minHeight: 36,
                padding: "6px 10px",
                borderRadius: 8,
                border: "1px solid #c9ccd0",
                fontSize: 13,
              }}
            />
            <s-button type="button" variant="secondary" onClick={exportCsv}>
              Export CSV
            </s-button>
          </div>
        </div>

        {/* Table */}
        {quotes.length === 0 ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: "40px 20px",
              minHeight: "200px",
              textAlign: "center",
              border: "1px solid #e3e7ec",
              borderRadius: 12,
              background: "#ffffff",
            }}
          >
            <div style={{ fontSize: "16px", fontWeight: 600, color: "#202223", marginBottom: "8px" }}>
              {searchQuery || statusFilter || dateFrom || dateTo
                ? "No quotes match your filters"
                : "No quotes yet"}
            </div>
            <div style={{ fontSize: "14px", color: "#5c5f62" }}>
              {searchQuery || statusFilter || dateFrom || dateTo
                ? "Try adjusting your search or filters."
                : "Quotes created from the Sales Portal will appear here."}
            </div>
          </div>
        ) : (
          <div style={tableCardStyle}>
            {isSearching && (
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  backgroundColor: "rgba(255, 255, 255, 0.7)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  zIndex: 10,
                  borderRadius: 8,
                }}
              >
                <div style={{ textAlign: "center" }}>
                  <div
                    style={{
                      display: "inline-block",
                      width: 24,
                      height: 24,
                      border: "3px solid #e0e0e0",
                      borderTop: "3px solid #1a1b1d",
                      borderRadius: "50%",
                      animation: "spin 0.8s linear infinite",
                    }}
                  />
                  <p style={{ marginTop: 8, color: "#5c5f62", fontSize: 13 }}>Searching…</p>
                </div>
                <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
              </div>
            )}

            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                minWidth: 1000,
                fontSize: 13,
                opacity: isSearching ? 0.5 : 1,
                pointerEvents: isSearching ? "none" : "auto",
              }}
            >
              <thead>
                <tr>
                  <th style={{ ...tableHeaderCellStyle, minWidth: 150 }}>
                    <button type="button" onClick={() => toggleSort("createdAt")} style={sortableHeaderButtonStyle}>
                      Quote # {renderSortArrow("createdAt")}
                    </button>
                  </th>
                  <th style={{ ...tableHeaderCellStyle, minWidth: 140 }}>Company</th>
                  <th style={{ ...tableHeaderCellStyle, minWidth: 180 }}>Customer</th>
                  <th style={{ ...tableHeaderCellStyle, minWidth: 100 }}>
                    <button type="button" onClick={() => toggleSort("totalAmount")} style={sortableHeaderButtonStyle}>
                      Total {renderSortArrow("totalAmount")}
                    </button>
                  </th>
                  <th style={{ ...tableHeaderCellStyle, minWidth: 100 }}>
                    <button type="button" onClick={() => toggleSort("status")} style={sortableHeaderButtonStyle}>
                      Status {renderSortArrow("status")}
                    </button>
                  </th>
                  <th style={{ ...tableHeaderCellStyle, minWidth: 110 }}>Agent</th>
                  <th style={{ ...tableHeaderCellStyle, minWidth: 110 }}>Created</th>
                  <th style={{ ...tableHeaderCellStyle, minWidth: 110 }}>Expires</th>
                  <th style={{ ...tableHeaderCellStyle, minWidth: 100 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {quotes.map((quote: any) => (
                  <tr key={quote.id} style={{ borderTop: "1px solid #e3e3e3" }}>
                    <td style={tableCellStyle}>
                      <Link
                        to={`/app/quotes/${quote.id}`}
                        style={{ color: "#2c6ecb", fontWeight: 650, textDecoration: "none" }}
                      >
                        {quote.quoteNumber}
                      </Link>
                      <br />
                      <span style={{ fontSize: 12, color: "#5c5f62" }}>{quote.title || "–"}</span>
                    </td>
                    <td style={tableCellStyle}>
                      <Link
                        to={`/app/companies/${quote.companyId}`}
                        style={{ color: "#2c6ecb", textDecoration: "none", fontWeight: 500 }}
                      >
                        {quote.companyName}
                      </Link>
                    </td>
                    <td style={{ ...tableCellStyle, overflowWrap: "anywhere" }}>
                      {quote.customerFirstName || ""} {quote.customerLastName || ""}
                      <br />
                      <span style={{ fontSize: 12, color: "#5c5f62" }}>{quote.customerEmail}</span>
                    </td>
                    <td style={{ ...tableCellStyle, fontWeight: 600 }}>
                      {formatCurrency(quote.totalAmount, quote.currencyCode)}
                    </td>
                    <td style={tableCellStyle}>
                      <span
                        style={{
                          display: "inline-block",
                          padding: "4px 10px",
                          borderRadius: 8,
                          fontSize: 12,
                          fontWeight: 600,
                          background: "#f4f6f8",
                          color: STATUS_COLORS[quote.status] || "#374151",
                          textTransform: "capitalize",
                        }}
                      >
                        {quote.status}
                      </span>
                    </td>
                    <td style={tableCellStyle}>{quote.salesAgentName}</td>
                    <td style={tableCellStyle}>{formatDisplayDate(quote.createdAt)}</td>
                    <td style={tableCellStyle}>{formatDisplayDate(quote.expiresAt)}</td>
                    <td style={tableCellStyle}>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <Link
                          to={`/app/quotes/${quote.id}`}
                          style={{ color: "#2c6ecb", textDecoration: "none", fontWeight: 600, fontSize: 13 }}
                        >
                          View
                        </Link>
                        {quote.status === "draft" && (
                          <Form method="post" style={{ display: "inline" }}>
                            <input type="hidden" name="intent" value="cancel_quote" />
                            <input type="hidden" name="quoteId" value={quote.id} />
                            <button
                              style={{
                                border: "none",
                                background: "transparent",
                                cursor: "pointer",
                                fontWeight: 600,
                                padding: 0,
                                color: "#b91b1b",
                                fontSize: 13,
                              }}
                            >
                              Cancel
                            </button>
                          </Form>
                        )}
                        <Form method="post" style={{ display: "inline" }}>
                          <input type="hidden" name="intent" value="delete_quote" />
                          <input type="hidden" name="quoteId" value={quote.id} />
                          <button
                            onClick={(e) => {
                              if (!confirm("Delete this quote? This cannot be undone.")) {
                                e.preventDefault();
                              }
                            }}
                            style={{
                              border: "none",
                              background: "transparent",
                              cursor: "pointer",
                              fontWeight: 600,
                              padding: 0,
                              color: "#b91b1b",
                              fontSize: 13,
                            }}
                          >
                            Delete
                          </button>
                        </Form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
              marginTop: 24,
              paddingTop: 24,
              borderTop: "1px solid #e3e3e3",
            }}
          >
            <Link
              to={buildQueryString({ page: String(currentPage - 1) })}
              style={{
                padding: "8px 16px",
                borderRadius: 8,
                border: "1px solid #c9ccd0",
                textDecoration: "none",
                color: currentPage === 1 ? "#999" : "#202223",
                pointerEvents: currentPage === 1 ? "none" : "auto",
                opacity: currentPage === 1 ? 0.5 : 1,
              }}
            >
              Previous
            </Link>
            <div style={{ display: "flex", gap: 8 }}>
              {Array.from({ length: totalPages }, (_, i) => i + 1)
                .filter((p) => p === 1 || p === totalPages || Math.abs(p - currentPage) <= 1)
                .map((pageNum, idx, arr) => {
                  const showEllipsis = idx > 0 && pageNum - arr[idx - 1] > 1;
                  return (
                    <span key={pageNum} style={{ display: "contents" }}>
                      {showEllipsis && (
                        <span style={{ padding: "8px 12px", color: "#999" }}>…</span>
                      )}
                      <Link
                        to={buildQueryString({ page: String(pageNum) })}
                        style={{
                          padding: "8px 12px",
                          borderRadius: 8,
                          border: "1px solid #c9ccd0",
                          textDecoration: "none",
                          color: pageNum === currentPage ? "white" : "#202223",
                          background: pageNum === currentPage ? "#005bd3" : "white",
                          fontWeight: pageNum === currentPage ? 600 : 400,
                        }}
                      >
                        {pageNum}
                      </Link>
                    </span>
                  );
                })}
            </div>
            <Link
              to={buildQueryString({ page: String(currentPage + 1) })}
              style={{
                padding: "8px 16px",
                borderRadius: 8,
                border: "1px solid #c9ccd0",
                textDecoration: "none",
                color: currentPage === totalPages ? "#999" : "#202223",
                pointerEvents: currentPage === totalPages ? "none" : "auto",
                opacity: currentPage === totalPages ? 0.5 : 1,
              }}
            >
              Next
            </Link>
            <span style={{ marginLeft: 16, color: "#5c5f62", fontSize: 14 }}>
              Page {currentPage} of {totalPages} ({totalCount} quotes)
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
