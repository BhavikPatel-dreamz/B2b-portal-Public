// Formatting and labelling for the order-sync log page. Shared, not .server:
// all of this ships to the browser with the page.

import { DEFAULT_TIME_ZONE, formatInZone } from "../timezone/index.js";

// Every timestamp on this page, rendered in the zone the SYNC thinks in — not the
// viewer's and not the server's.
//
// It has to be the sync's zone rather than a local one for two reasons. The
// From/To filters are date-only fields, which can't carry a zone, so they are
// read as days in the sync's zone (see parseCustomRange); a column rendered in a
// different zone would disagree with its own filter by the offset between them —
// at +05:30 against UTC, "today" would silently drop everything logged after
// 18:30. And toLocaleString() with no explicit zone renders in the server's during
// SSR and the browser's after hydration, which React reports as a mismatch.
//
// The zone is named in the output (IST, EDT, UTC…) because a bare timestamp with
// no zone is exactly what makes "why is this an hour out" unanswerable.
export function formatRunAt(iso, timeZone = DEFAULT_TIME_ZONE) {
  return formatInZone(iso, timeZone);
}

// A window as "<from> → <to>", in the same format as the table's Run time so the
// two can be read against each other. A missing `from` means the run started at
// the initial lookback rather than at a previous watermark — worth naming rather
// than printing an empty side.
export function windowText(from, to, timeZone = DEFAULT_TIME_ZONE) {
  return `${from ? formatRunAt(from, timeZone) : "initial lookback window"} → ${to ? formatRunAt(to, timeZone) : "now"}`;
}

// "N of M orders synced", the one sentence that describes a run's position. Used
// live while a run works, in the toast when it ends, and in the Schedule card
// afterwards — one function so all three agree on the wording and on the plural.
export function progressText({ done, total }) {
  return `${done} of ${total} order${total === 1 ? "" : "s"} synced`;
}

export function statusTone(status) {
  if (status === "failed") return "critical";
  if (status === "success") return "success";
  return "neutral";
}

// What a row's Sync button will do, named after the one order it will touch.
export function syncLabel(row) {
  return `Re-sync ${row.reference || row.externalId}`;
}

// Everything in the row's stored result, as label/value lines. The raw JSON is
// shown underneath for the fields this doesn't know about.
export function detailPairs(row, timeZone = DEFAULT_TIME_ZONE) {
  let detail = {};
  try {
    detail = row.detail ? JSON.parse(row.detail) : {};
  } catch {
    detail = {};
  }
  return [
    // The raw ISO alongside the rendered one: this is the modal someone opens to
    // work out why a timestamp looks wrong, and the UTC instant is the fact the
    // rendering is derived from.
    ["Run time", `${formatRunAt(row.runAt, timeZone)} (${row.runAt})`],
    ["Finished", row.finishedAt ? formatRunAt(row.finishedAt, timeZone) : null],
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
    ["Ship method (carrier)", detail.shipMethod],
    ["Shipped date", detail.shipmentDate],
    ["Shipment status", detail.shipmentStatus],
    ["Package weight", detail.packageWeight],
    ["Deleted id", detail.deletedId],
    // Set on an order that has failed every run for long enough to be let go of
    // by the watermark — see quarantinedOrders. It explains why a run can report
    // failures and still have moved on.
    ["Consecutive failed runs", detail.attempts],
    ["Quarantined", detail.quarantined ? "yes — no longer holding the watermark back" : null],
    ["Reason", detail.reason],
    ["Warning", detail.warning],
    ["Error", detail.error],
  ].filter(([, v]) => v !== null && v !== undefined && v !== "");
}
