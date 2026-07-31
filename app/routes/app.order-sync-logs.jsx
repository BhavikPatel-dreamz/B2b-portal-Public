import { useCallback, useEffect, useRef, useState } from "react";
import { useLoaderData, useNavigate, useRouteError, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server.js";
import { authenticate } from "../shopify.server";

// Order-sync run log, one row per order per cron run (see saveSyncLogRows in
// app/lib/order-sync.server.js). Filtering, counting and paging are all done in
// the query — the table only renders the page it was handed.

const PER_PAGE = 25;
const STATUSES = ["failed", "success", "skipped"];

// The date filters are date-only (that's what s-date-field gives), so "to" has to
// cover the whole day or a same-day from/to would match nothing.
function dayStart(value) {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dayEnd(value) {
  if (!value) return null;
  const d = new Date(`${value}T23:59:59.999Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const status = STATUSES.includes(url.searchParams.get("status")) ? url.searchParams.get("status") : "";
  const from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";
  const requestedPage = Math.max(1, Number(url.searchParams.get("page")) || 1);

  const runAt = {};
  if (dayStart(from)) runAt.gte = dayStart(from);
  if (dayEnd(to)) runAt.lte = dayEnd(to);

  const where = {
    shop: session.shop,
    ...(status ? { status } : {}),
    ...(Object.keys(runAt).length ? { runAt } : {}),
    // Free text hits everything an operator would search by: the NetSuite ids,
    // the Shopify order name, the company, and the error text itself.
    ...(q
      ? {
        OR: [
          { reference: { contains: q } },
          { externalId: { contains: q } },
          { orderName: { contains: q } },
          { company: { contains: q } },
          { message: { contains: q } },
          { action: { contains: q } },
        ],
      }
      : {}),
  };

  // The page number is clamped to what the filter actually holds: a bookmarked
  // ?page=9, or a filter narrowed while on page 4, would otherwise render an empty
  // table with no way to tell that it isn't simply "no results".
  const total = await prisma.orderSyncLog.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const page = Math.min(requestedPage, totalPages);

  const [rows, byStatus] = await Promise.all([
    prisma.orderSyncLog.findMany({
      where,
      // Newest run first, and within a run the failures first — the same order the
      // file log uses, for the same reason.
      orderBy: [{ runAt: "desc" }, { status: "asc" }, { id: "asc" }],
      skip: (page - 1) * PER_PAGE,
      take: PER_PAGE,
    }),
    // Counts for the current filter, minus the status filter itself — so the
    // "12 failed" badge stays readable while looking at only the successes.
    prisma.orderSyncLog.groupBy({
      by: ["status"],
      where: { ...where, status: undefined },
      _count: { _all: true },
    }),
  ]);

  const counts = { failed: 0, success: 0, skipped: 0 };
  for (const g of byStatus) counts[g.status] = g._count._all;

  return {
    rows: rows.map((r) => ({
      id: r.id,
      runAt: r.runAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() || null,
      mode: r.mode,
      externalId: r.externalId,
      reference: r.reference,
      action: r.action,
      status: r.status,
      orderName: r.orderName,
      orderId: r.orderId,
      company: r.company,
      message: r.message,
      detail: r.detail,
    })),
    counts,
    filters: { q, status, from, to },
    page,
    total,
    totalPages,
    hasPrev: page > 1,
    hasNext: page * PER_PAGE < total,
  };
};

// UTC, deliberately, for two reasons. The From/To filters below are UTC days (a
// date-only field can't carry a zone), so a local-time column would disagree with
// its own filter by the viewer's offset — at +05:30, "today" would silently drop
// everything logged after 18:30. And toLocaleString() renders in the server's zone
// during SSR and the browser's after hydration, which React reports as a mismatch.
// NetSuite and the .log file are both UTC too, so a timestamp here can be compared
// with either as-is.
function formatRunAt(iso) {
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

function statusTone(status) {
  if (status === "failed") return "critical";
  if (status === "success") return "success";
  return "neutral";
}

// Everything in the row's stored result, as label/value lines. The raw JSON is
// shown underneath for the fields this doesn't know about.
function detailPairs(row) {
  let detail = {};
  try {
    detail = row.detail ? JSON.parse(row.detail) : {};
  } catch {
    detail = {};
  }
  const pairs = [
    ["Run time", `${formatRunAt(row.runAt)} (${row.runAt})`],
    ["Finished", row.finishedAt ? formatRunAt(row.finishedAt) : null],
    ["Mode", row.mode === "export" ? "export (dry run — nothing written to Shopify)" : "live"],
    ["NetSuite id", row.externalId],
    ["NetSuite ref", row.reference],
    ["Action", row.action],
    ["Status", row.status],
    ["Shopify order", [row.orderName, row.orderId].filter(Boolean).join(" · ")],
    ["Matched by", detail.matchedBy],
    ["Financial status", detail.financialStatus],
    ["Fulfillment status", detail.fulfillmentStatus],
    ["Total", detail.total],
    ["Company", detail.company || detail.netsuiteCompany],
    ["Company location", detail.companyLocation],
    ["Created in Shopify", detail.companyCreated],
    ["Line items", detail.lines],
    ["Payment", (detail.transactions || []).join(" | ")],
    ["Tracking", detail.tracking],
    ["Deleted id", detail.deletedId],
    ["Reason", detail.reason],
    ["Warning", detail.warning],
    ["Error", detail.error],
  ];
  return pairs.filter(([, v]) => v !== null && v !== undefined && v !== "");
}

// React 18's synthetic onChange only covers native form elements, so it can't be
// relied on to fire for a Polaris web component — the listener is attached to the
// element itself instead. (onClick is fine: React's click delegation reaches any
// element, which is how the rest of this app's s-buttons work.) `change` also
// fires on commit rather than per keystroke, so the search field doesn't navigate
// on every character.
function useFieldChange(handler) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const onChange = (event) => handler(String(event.target?.value ?? ""));
    el.addEventListener("change", onChange);
    return () => el.removeEventListener("change", onChange);
  }, [handler]);
  return ref;
}

export default function OrderSyncLogs() {
  const { rows, counts, filters, page, total, totalPages, hasPrev, hasNext } = useLoaderData();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const [selected, setSelected] = useState(null);

  // Every filter change is a navigation, so the URL is the state: a filtered view
  // can be linked, and the browser's back button does what it looks like it does.
  const apply = useCallback((changes) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, String(value));
      else next.delete(key);
    }
    // Any filter change invalidates the page number.
    if (!("page" in changes)) next.delete("page");
    navigate(`?${next.toString()}`);
  }, [navigate, searchParams]);

  const searchRef = useFieldChange(useCallback((value) => apply({ q: value }), [apply]));
  const statusRef = useFieldChange(useCallback((value) => apply({ status: value }), [apply]));
  const fromRef = useFieldChange(useCallback((value) => apply({ from: value }), [apply]));
  const toRef = useFieldChange(useCallback((value) => apply({ to: value }), [apply]));

  const openDetail = (row) => {
    setSelected(row);
    shopify.modal.show("log-detail");
  };

  return (
    <s-page heading="Order sync logs">
      <s-section>
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-badge tone="critical">{counts.failed} failed</s-badge>
          <s-badge tone="success">{counts.success} success</s-badge>
          <s-badge tone="neutral">{counts.skipped} skipped</s-badge>
          <s-text tone="neutral">
            {total} entr{total === 1 ? "y" : "ies"} · page {page} of {totalPages}
          </s-text>
        </s-stack>
      </s-section>

      <s-section padding="none">
        <s-table
          paginate
          hasPreviousPage={hasPrev}
          hasNextPage={hasNext}
          onPreviousPage={() => apply({ page: String(page - 1) })}
          onNextPage={() => apply({ page: String(page + 1) })}
        >
          <s-grid slot="filters" gap="small-200" gridTemplateColumns="1fr auto auto auto auto">
            <s-search-field
              ref={searchRef}
              label="Search logs"
              labelAccessibilityVisibility="exclusive"
              placeholder="SO number, order name, company, error…"
              value={filters.q}
            ></s-search-field>
            <s-select
              ref={statusRef}
              label="Status"
              labelAccessibilityVisibility="exclusive"
              name="status"
              value={filters.status}
            >
              <s-option value="">All statuses</s-option>
              <s-option value="failed">Failed</s-option>
              <s-option value="success">Success</s-option>
              <s-option value="skipped">Skipped</s-option>
            </s-select>
            <s-date-field
              ref={fromRef}
              label="From (UTC)"
              labelAccessibilityVisibility="exclusive"
              placeholder="From (UTC)"
              value={filters.from}
            ></s-date-field>
            <s-date-field
              ref={toRef}
              label="To (UTC)"
              labelAccessibilityVisibility="exclusive"
              placeholder="To (UTC)"
              value={filters.to}
            ></s-date-field>
            <s-button
              variant="secondary"
              onClick={() => navigate("?")}
              {...(filters.q || filters.status || filters.from || filters.to ? {} : { disabled: true })}
            >
              Clear
            </s-button>
          </s-grid>

          <s-table-header-row>
            <s-table-header listSlot="primary">Run time</s-table-header>
            <s-table-header>NetSuite order</s-table-header>
            <s-table-header>Action</s-table-header>
            <s-table-header listSlot="secondary">Status</s-table-header>
            <s-table-header>Shopify order</s-table-header>
            <s-table-header>Reason / error</s-table-header>
            <s-table-header>Detail</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {rows.map((row) => (
              <s-table-row key={row.id}>
                <s-table-cell>{formatRunAt(row.runAt)}</s-table-cell>
                <s-table-cell>{row.reference || row.externalId || "—"}</s-table-cell>
                <s-table-cell>{row.action}</s-table-cell>
                <s-table-cell>
                  <s-badge tone={statusTone(row.status)}>{row.status}</s-badge>
                </s-table-cell>
                <s-table-cell>{row.orderName || "—"}</s-table-cell>
                <s-table-cell>
                  <s-text tone={row.status === "failed" ? "critical" : "neutral"}>
                    {row.message || "—"}
                  </s-text>
                </s-table-cell>
                <s-table-cell>
                  <s-button variant="tertiary" onClick={() => openDetail(row)}>
                    Details
                  </s-button>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        {rows.length === 0 && (
          <s-box padding="base">
            <s-paragraph tone="neutral">
              No log entries for this filter. Runs are logged by the cron sync
              (/api/cron/orders-sync).
            </s-paragraph>
          </s-box>
        )}
      </s-section>

      <s-modal id="log-detail" heading="Log entry">
        {selected && (
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-badge tone={statusTone(selected.status)}>{selected.status}</s-badge>
              <s-text type="strong">
                {selected.action} · {selected.reference || selected.externalId || "—"}
              </s-text>
            </s-stack>
            {detailPairs(selected).map(([label, value]) => (
              <s-stack key={label} direction="inline" gap="base">
                <s-box inlineSize="180px">
                  <s-text tone="neutral">{label}</s-text>
                </s-box>
                <s-text>{String(value)}</s-text>
              </s-stack>
            ))}
            <s-divider direction="inline"></s-divider>
            <s-text tone="neutral">Raw result</s-text>
            <s-box padding="base" background="subdued" borderRadius="base">
              <s-text>{selected.detail}</s-text>
            </s-box>
          </s-stack>
        )}
        <s-button slot="secondary-actions" commandFor="log-detail" command="--hide">
          Close
        </s-button>
      </s-modal>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
