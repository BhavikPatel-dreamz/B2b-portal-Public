import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";
import prisma from "../db.server.js";
import { unauthenticated } from "../shopify.server.js";
import demoFeed from "../data/demo-orders.json";
import { extraFunction } from "./extra-function.server.js";
import { buildOrdersQuery, fetchNetsuiteOrders, targetedOrderIds, INVOICE_PAID_IN_FULL } from "./netsuite.server.js";
import { orderAttemptLimit, quarantinedOrders } from "./order-sync-log.server.js";
import { windowLabel, windowRange } from "./sync-windows.js";
import {
  acquireSyncLock,
  bumpSyncDone,
  clearSyncWindowResume,
  getLastSyncedAt,
  getSyncListOffset,
  getSyncWindowResume,
  isSyncStopRequested,
  isSyncStoppedError,
  releaseSyncLock,
  setLastSyncedAt,
  setSyncListOffset,
  setSyncTotal,
  setSyncWindowResume,
} from "./netsuite-oauth.server.js";

// ---------------------------------------------------------------------------
// NetSuite feed
// ---------------------------------------------------------------------------
// By default (NETSUITE_USE_DEMO=true) this returns the local demo JSON, shaped
// like a real SuiteTalk REST salesOrder response. Set NETSUITE_USE_DEMO=false
// and fill the NETSUITE_* creds in .env to hit the live NetSuite API.
// Either way the returned shape is { items: [ salesOrder, ... ] }.
export async function fetchExternalOrders(shop, opts = {}) {
  if (process.env.NETSUITE_USE_DEMO !== "false") {
    // opts.window is ignored here on purpose: the demo records carry no
    // lastModifiedDate, so every window would match none of them and a windowed
    // run in demo mode would look broken rather than like a demo.
    // A targeted call has to narrow the demo feed the same way it narrows a live
    // fetch, or re-syncing one order would run the whole feed. Both identifiers
    // resolveOrderId() accepts are matched: the internal id ("1504") and the
    // document number ("SO1504", or bare "1504").
    //
    // Both sources of a target are honoured, in the same precedence
    // fetchNetsuiteOrders uses: an explicit list (opts.ids — a manual re-sync)
    // wins, and NETSUITE_ORDER_IDS applies to every other run. That env var used
    // to be read only on the live path, so in demo mode it did nothing at all:
    // the banner on the log page said every run syncs only those orders while
    // the run happily processed the whole demo feed.
    const requested = (opts.ids || []).map((v) => String(v).trim()).filter(Boolean);
    const ids = requested.length ? requested : targetedOrderIds();
    if (!ids.length) return demoFeed;
    const source = requested.length ? "requested orders" : "NETSUITE_ORDER_IDS";
    console.log(`[order-sync] demo feed — ${source}, syncing only: ${ids.join(", ")}`);
    const key = (v) => String(v).trim().toUpperCase().replace(/^SO/, "");
    const wanted = new Set(ids.map(key));
    const items = (demoFeed.items || []).filter(
      (rec) => wanted.has(key(rec.id)) || (rec.tranId && wanted.has(key(rec.tranId))),
    );
    const found = new Set(items.flatMap((rec) => [key(rec.id), key(rec.tranId || "")]));
    return {
      items,
      errors: ids
        .filter((raw) => !found.has(key(raw)))
        .map((raw) => ({ id: raw, error: `${source}: "${raw}" is not in the demo feed` })),
    };
  }
  return fetchNetsuiteOrders(shop, opts);
}

// NetSuite statuses that mean the order is dead — these map to a delete in
// Shopify. Everything else is a create-or-update (upsert).
//
// These are the record's status *IDs* (single letters, see the status table
// below), NOT the display names. The set previously held names ("cancelled",
// "closed", "rejected") while mapNetsuiteOrder compares them against
// rec.status.id, so has() could never return true and the delete path was
// unreachable — a cancelled NetSuite order was upserted into Shopify instead.
// "rejected" was never a sales-order status at all; the account only ever
// returns A-H.
//
// Only C (Cancelled) qualifies. It is terminal, cannot be undone, and the
// cancelled orders on this account have no invoice behind them.
//
// H (Closed) is deliberately NOT here even though the status reference says a
// closed order "won't be fulfilled or billed": on this account closed sales
// orders do have invoices attached, including Paid In Full ones, so deleting
// them would erase a real, settled sale from Shopify. Closing a sales order
// means the remaining lines will not ship — not that the order was void.
//
// deleteOrder() is the guard on how far this reaches: it exempts
// Celigo-imported orders outright and otherwise only resolves orders carrying
// this sync's own ext:<netsuiteId> tag, so only an order this sync created can
// ever be deleted.
const DELETE_STATUSES = new Set(["C"]);

// Maps a raw NetSuite salesOrder record into the internal order shape the sync
// logic uses. NetSuite's `entity.refName` is a single display name; we split it
// into first/last on the first space (best-effort — NetSuite has no split name
// on the transaction record itself).
function mapNetsuiteOrder(rec) {
  const statusId = rec?.status?.id || "";
  const [firstName, ...rest] = (rec?.entity?.refName || "").trim().split(" ");
  const lastName = rest.join(" ");
  const customerName = { firstName: firstName || null, lastName: lastName || null };

  // Celigo stamps the source Shopify store onto the billing and/or shipping
  // address of every order it imports from Shopify. Detection is on the
  // PRESENCE of the field, not on being able to read an id out of it — a
  // store reference we can't parse still means "this order came from Shopify",
  // and treating it as NetSuite-native would create a duplicate.
  const celigoRefs = [
    rec?.billingAddress?.custrecord_celigo_shopify_store,
    rec?.shippingAddress?.custrecord_celigo_shopify_store,
  ].filter((v) => v != null);
  const celigoRef = celigoRefs.find((v) => refId(v)) || celigoRefs[0] || null;

  return {
    externalId: String(rec.id),
    reference: rec.tranId || null,
    action: DELETE_STATUSES.has(statusId) ? "delete" : "upsert",
    status: statusId,
    statusName: rec?.status?.refName || null,
    orderStatus: rec?.orderStatus?.refName || null,
    financialStatus: mapFinancialStatus(statusId, rec?.linkedInvoices),
    fulfillmentStatus: mapFulfillmentStatus(rec?.item?.items, statusId),
    // The invoices the financial status was derived from, so a synced order can
    // be traced back to the record that decided paid vs unpaid.
    invoices: (rec?.linkedInvoices || []).map((v) => ({
      tranId: v.tranId,
      statusId: v.statusId,
      statusLabel: v.statusLabel,
    })),
    tranDate: rec.tranDate || null,
    createdDate: rec.createdDate || null,
    lastModifiedDate: rec.lastModifiedDate || null,
    shipDate: rec.shipDate || null,
    shipComplete: rec.shipComplete ?? null,
    note: rec.memo || null,
    currency: currencyCode(rec?.currency),
    // linkedCustomerEmail is the customer record's address, attached by
    // fetchNetsuiteOrders only for orders whose own Email field is blank — some
    // sales order forms never fill it. Without it those orders map to a null
    // email, which fails a B2B order outright (see lookupCompanyLocation).
    customer: rec?.entity
      ? {
        email: process.env.TEST_EMAIL || rec.email || rec.linkedCustomerEmail || null,
        ...customerName,
      }
      : null,
    // The B2B company this order belongs to. Its PRESENCE is what switches the
    // order onto the company-location path in createOrder — an order without it
    // is created as a plain (non-B2B) order exactly as before.
    companyName: cleanCompanyName(rec?.custbody_ava_customercompanyname),
    shippingAddress: mapAddress(rec?.shippingAddress, customerName),
    billingAddress: mapAddress(rec?.billingAddress, customerName),
    shippingCost: numOrNull(rec?.shippingCost),
    shipMethod: rec?.shipMethod?.refName || null,
    subtotal: numOrNull(rec?.subtotal),
    taxTotal: numOrNull(rec?.taxTotal),
    total: numOrNull(rec?.total),
    discountTotal: numOrNull(rec?.discountTotal),
    tracking: cleanTracking(rec?.linkedTrackingNumbers),
    otherRefNum: rec.otherRefNum || null,
    // isCeligoOrder is what the sync branches on (see resolveShopifyOrder); the
    // id/name are informational.
    isCeligoOrder: celigoRef != null,
    celigoStoreId: refId(celigoRef),
    celigoStoreName: celigoRef?.refName || null,
    terms: rec?.terms?.refName || null,
    salesRep: rec?.salesRep?.refName || null,
    department: rec?.department?.refName || null,
    subsidiary: rec?.subsidiary?.refName || null,
    location: rec?.location?.refName || null,
    transactionNumber: rec.transactionNumber || null,
    salesEffectiveDate: rec.salesEffectiveDate || null,
    fax: rec.fax || null,
    opportunity: rec?.opportunity?.id ? String(rec.opportunity.id) : null,
    estGrossProfit: numOrNull(rec?.estGrossProfit),
    estGrossProfitPercent: numOrNull(rec?.estGrossProfitPercent),
    totalCostEstimate: numOrNull(rec?.totalCostEstimate),
    exchangeRate: numOrNull(rec?.exchangeRate),
    shipIsResidential: rec.shipIsResidential ?? null,
    isMultiShipTo: rec.isMultiShipTo ?? null,
    customForm: rec?.customForm?.refName || null,
    lineItems: (rec?.item?.items || []).map((li) => ({
      title: li?.item?.refName || `NetSuite item ${li?.item?.id || ""}`.trim(),
      quantity: li.quantity ?? 1,
      price: linePrice(li, rec?.id),
      // Recorded so the fulfillment status above can be traced back to the
      // quantities it was derived from. Not sent to Shopify.
      quantityFulfilled: numOrNull(li.quantityFulfilled),
    })),
  };
}

// NetSuite Sales Order status IDs and their documented meanings. Advanced
// Shipping is enabled on this account, which is what splits "Pending Billing"
// out from "Pending Fulfillment". The account returns exactly these eight and
// nothing else (confirmed by grouping every SalesOrd transaction by status):
//   A = Pending Approval                    — not approved yet
//   B = Pending Fulfillment                 — approved, nothing shipped, nothing billed
//   C = Cancelled                            — terminal, cannot be undone
//   D = Partially Fulfilled                 — partially shipped, regardless of billing
//   E = Pending Billing/Partially Fulfilled — partially shipped, awaiting invoice
//   F = Pending Billing                     — fully shipped, awaiting invoice
//                                             (includes partially billed orders)
//   G = Billed                              — fully shipped AND invoiced
//   H = Closed                              — will not be fulfilled or billed
// Ref: https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N1220604.html

// Maps to Shopify's OrderCreateFinancialStatus from the order's INVOICES, not
// from its status. The sales-order status cannot answer "was this paid" — it
// tracks shipping and whether an invoice was created. Measured on this account
// (2026 orders): 638 sales orders sitting in status G "Billed" have an OPEN,
// unpaid invoice, against 1718 with a Paid In Full one, and 29 have no invoice
// at all. Reading G as PAID was therefore wrong for about a quarter of them.
//
// linkedInvoices comes from fetchInvoicesForOrders (netsuite.server.js), whose
// invoice status ids are A = Open and B = Paid In Full. When it is absent (the
// lookup failed, or demo mode) we fall back to the status, which can only ever
// say "not paid yet" honestly — never PAID.
function mapFinancialStatus(nsStatusId, invoices) {
  if (Array.isArray(invoices) && invoices.length) {
    const paid = invoices.filter((v) => v.statusId === INVOICE_PAID_IN_FULL).length;
    if (paid === invoices.length) return "PAID";
    if (paid > 0) return "PARTIALLY_PAID";
    // Every invoice is still Open: it has been billed but no money has arrived.
    return "PENDING";
  }
  // No invoice exists, so nothing has been billed, let alone paid.
  switch (nsStatusId) {
    case "C": return "VOIDED";
    // H (Closed) is left as PENDING rather than VOIDED: closing a sales order
    // says the remaining lines will not ship, not that the order was void.
    default: return "PENDING";
  }
}

// Derives the fulfillment state from the quantities actually shipped rather
// than from the sales-order status. Measured on this account (2026 orders),
// comparing ordered against shipped quantity per order — counting real item
// lines only, since ShipItem/TaxItem lines never ship and would otherwise make
// every order with a shipping line look partially fulfilled:
//
//   status        nothing shipped   partially shipped   fully shipped
//   A                    5                  0                  0
//   B                  337                  0                  0
//   D                    0                 75                  0
//   E                    0                  5                  0
//   F                    0                  0                 23
//   G                    0                  0               2340
//   H                   13                  2                  0
//
// So unlike the financial status, the sales-order status does track shipping
// faithfully for A/B/D/E/F/G. The one status it gets wrong is H (Closed): 2 of
// its 15 orders are partially shipped, and a status-based rule calls all 15
// unfulfilled. Reading the quantities fixes that, is exact per order instead of
// inferred from a status bucket, and costs no extra API call — quantity and
// quantityFulfilled already come back on each sales-order item line.
//
// nsLines is rec.item.items, which holds only real item lines; shipping and tax
// arrive separately as shippingCost/taxTotal, so no filtering is needed here.
function mapFulfillmentStatus(nsLines, nsStatusId) {
  const lines = (nsLines || []).filter((li) => Number.isFinite(Number(li?.quantity)));
  const ordered = lines.reduce((sum, li) => sum + Math.abs(Number(li.quantity)), 0);
  if (ordered > 0) {
    const fulfilled = lines.reduce((sum, li) => {
      const q = Number(li?.quantityFulfilled);
      return sum + (Number.isFinite(q) ? Math.abs(q) : 0);
    }, 0);
    if (fulfilled <= 0) return "UNFULFILLED";
    if (fulfilled >= ordered) return "FULFILLED";
    return "PARTIALLY_FULFILLED";
  }
  // No usable quantities (the demo feed, or a service-only order). Fall back to
  // the status, which at least separates shipped from not-shipped.
  switch (nsStatusId) {
    case "F": case "G": return "FULFILLED";
    case "D": case "E": return "PARTIALLY_FULFILLED";
    default: return "UNFULFILLED";
  }
}

// Translates the internal fulfillment status above into Shopify's
// OrderCreateFulfillmentStatus enum, whose only members are FULFILLED,
// PARTIAL and RESTOCKED. There is no "unfulfilled" member — omitting the
// field is how an unfulfilled order is created, so that case returns null.
function createFulfillmentStatus(status) {
  switch (status) {
    case "FULFILLED": return "FULFILLED";
    case "PARTIALLY_FULFILLED": return "PARTIAL";
    default: return null;
  }
}

// Reads an ISO currency code out of NetSuite's currency reference, or null.
//
// The reference is { id, refName }, and refName is NOT reliably a currency code:
// on this account it is the internal id restated ({ id: "1", refName: "1" }).
// Taking refName verbatim put "netsuite_currency = 1" on every synced order and
// made createOrder's mismatch guard compare "1" against "USD", so it warned
// "NetSuite currency 1 != shop USD" on every single order — noise that would
// hide a real currency mismatch if one ever happened. Only a genuine 3-letter
// code is accepted; anything else means the account does not expose one.
function currencyCode(ref) {
  const name = ref?.refName;
  return typeof name === "string" && /^[A-Za-z]{3}$/.test(name) ? name.toUpperCase() : null;
}

// Coerces a NetSuite numeric field to a number, or null when absent/invalid.
function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Normalizes NetSuite's tracking string (comma/space separated) to a single
// tidy "a, b, c" string, or null when there's nothing to show.
function cleanTracking(v) {
  if (!v || typeof v !== "string") return null;
  const t = v.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean).join(", ");
  return t || null;
}

// The unit price to send for a line. `rate` is the list price and is what the
// line normally works out to, but it is NOT what NetSuite bills: `amount` is the
// line total that feeds the record's subtotal and total, and a discounted line
// has an amount below rate x quantity (SO20742: rate 55.45, quantity 12, amount
// 524.04, i.e. 43.67 each). Deriving the price from `amount` in that case keeps
// the Shopify order total equal to NetSuite's — which matters twice over now that
// a PAID order also gets a payment transaction for that total (buildTransactions).
//
// `rate` is still used when the two agree, so the common line is unchanged and
// no rounding is introduced by the division.
function linePrice(li, recId) {
  const rate = numOrNull(li?.rate) ?? 0;
  const amount = numOrNull(li?.amount);
  const quantity = numOrNull(li?.quantity);
  if (amount === null || !quantity) return rate;
  if (Math.abs(rate * quantity - amount) <= 0.01) return rate;
  const derived = Math.round((amount / quantity) * 100) / 100;
  console.warn(
    `[order-sync] NetSuite order ${recId} line ${li?.line}: rate ${rate} x ${quantity} = ${(rate * quantity).toFixed(2)} but amount is ${amount} — using ${derived} each so the order total matches NetSuite.`,
  );
  return derived;
}

// Normalizes the NetSuite company-name field for use as a Shopify company
// location name. The account's values carry embedded newlines and runs of
// spaces ("BAE-Radford\n  Div"), which would otherwise become part of the
// location name and break name matching between runs.
function cleanCompanyName(v) {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s || null;
}

// Comparison key for company/location names: case- and punctuation-spacing
// insensitive, so "CPCCO - Central Plateau Cleanup Co" matches the location
// created from "CPCCO -  CENTRAL PLATEAU CLEANUP CO". Nothing else is
// stripped — "Amentum - Intel" and "Amentum - PAE" must stay distinct.
function companyNameKey(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

// Comparison key for a SKU. NetSuite item names arrive with the casing and inner
// spacing a human typed ("TPU for AMS", "TPU FOR AMS GRAY 53102"), and a Shopify
// SKU is not guaranteed to match either, so both sides are normalised before
// they're compared.
function skuKey(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

// Extracts the id/code from a NetSuite value that may be a plain scalar or a
// `{ id, refName }` reference object (country/state come back as references in
// SuiteTalk REST, e.g. { id: "US", refName: "United States" }).
function refId(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") return v.id ?? v.refName ?? null;
  return v;
}

// Returns an uppercased alpha code within the given length range, else null —
// so an unexpected value (a full name, an internal numeric id) is skipped
// rather than sent to Shopify as an invalid country/province code.
function code(v, min, max) {
  const s = String(v ?? "").trim().toUpperCase();
  return new RegExp(`^[A-Z]{${min},${max}}$`).test(s) ? s : null;
}

// Maps a NetSuite address sub-record to a Shopify MailingAddressInput, keeping
// only usable fields. Shopify's `country`/`province` are deprecated, so we emit
// `countryCode`/`provinceCode` from NetSuite's reference ids ("US", "CA").
// Returns null when there's nothing usable.
function mapAddress(addr, customerName) {
  if (!addr || typeof addr !== "object") return null;
  const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const out = {};
  const address1 = str(addr.addr1) || str(addr.address1);
  const address2 = str(addr.addr2) || str(addr.address2);
  if (address1) out.address1 = address1;
  if (address2) out.address2 = address2;
  if (str(addr.city)) out.city = str(addr.city);
  if (str(addr.zip)) out.zip = str(addr.zip);
  if (str(addr.addrPhone)) out.phone = str(addr.addrPhone);
  if (str(addr.addressee)) out.company = str(addr.addressee);
  const countryCode = code(refId(addr.country), 2, 2);
  if (countryCode) out.countryCode = countryCode;
  const provinceCode = code(refId(addr.state), 2, 3);
  if (provinceCode) out.provinceCode = provinceCode;
  if (customerName?.firstName) out.firstName = customerName.firstName;
  if (customerName?.lastName) out.lastName = customerName.lastName;
  return Object.keys(out).length ? out : null;
}

// Every order we create is tagged with its NetSuite id so later runs can find
// it again for update/delete without needing a local mapping table.
const extTag = (externalId) => `ext:${externalId}`;

function escapeCsvField(val) {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function ordersToCsv(orders) {
  const headers = [
    "externalId", "reference", "status", "statusName", "orderStatus", "action",
    "tranDate", "createdDate", "lastModifiedDate", "shipDate", "shipComplete",
    "note", "currency",
    "customerEmail", "customerFirstName", "customerLastName", "companyName",
    "shippingAddress1", "shippingCity", "shippingZip", "shippingCountry", "shippingProvince",
    "billingAddress1", "billingCity", "billingZip", "billingCountry", "billingProvince",
    "shippingCost", "shipMethod", "subtotal", "taxTotal", "total", "discountTotal",
    "tracking", "otherRefNum", "celigoStoreId", "celigoStoreName", "terms", "salesRep",
    "lineItems", "question",
  ];
  const rows = orders.map((o) => [
    o.externalId, o.reference, o.status, o.statusName, o.orderStatus, o.action,
    o.tranDate, o.createdDate, o.lastModifiedDate, o.shipDate, o.shipComplete,
    o.note, o.currency,
    o.customer?.email, o.customer?.firstName, o.customer?.lastName, o.companyName,
    o.shippingAddress?.address1, o.shippingAddress?.city, o.shippingAddress?.zip, o.shippingAddress?.countryCode, o.shippingAddress?.provinceCode,
    o.billingAddress?.address1, o.billingAddress?.city, o.billingAddress?.zip, o.billingAddress?.countryCode, o.billingAddress?.provinceCode,
    o.shippingCost, o.shipMethod, o.subtotal, o.taxTotal, o.total, o.discountTotal,
    o.tracking, o.otherRefNum, o.celigoStoreId, o.celigoStoreName, o.terms, o.salesRep,
    (o.lineItems || []).map((li) => `${li.title} x${li.quantity} @${li.price}`).join(" | "),
    "",
  ].map(escapeCsvField));
  return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
}

function ordersToExcel(orders) {
  const rows = orders.map((o) => ({
    externalId: o.externalId,
    reference: o.reference,
    status: o.status,
    statusName: o.statusName,
    orderStatus: o.orderStatus,
    action: o.action,
    tranDate: o.tranDate,
    createdDate: o.createdDate,
    lastModifiedDate: o.lastModifiedDate,
    shipDate: o.shipDate,
    shipComplete: o.shipComplete,
    note: o.note,
    currency: o.currency,
    customerEmail: o.customer?.email,
    customerFirstName: o.customer?.firstName,
    customerLastName: o.customer?.lastName,
    companyName: o.companyName,
    shippingAddress1: o.shippingAddress?.address1,
    shippingCity: o.shippingAddress?.city,
    shippingZip: o.shippingAddress?.zip,
    shippingCountry: o.shippingAddress?.countryCode,
    shippingProvince: o.shippingAddress?.provinceCode,
    billingAddress1: o.billingAddress?.address1,
    billingCity: o.billingAddress?.city,
    billingZip: o.billingAddress?.zip,
    billingCountry: o.billingAddress?.countryCode,
    billingProvince: o.billingAddress?.provinceCode,
    shippingCost: o.shippingCost,
    shipMethod: o.shipMethod,
    subtotal: o.subtotal,
    taxTotal: o.taxTotal,
    total: o.total,
    discountTotal: o.discountTotal,
    tracking: o.tracking,
    otherRefNum: o.otherRefNum,
    celigoStoreId: o.celigoStoreId,
    celigoStoreName: o.celigoStoreName,
    terms: o.terms,
    salesRep: o.salesRep,
    lineItems: (o.lineItems || []).map((li) => `${li.title} x${li.quantity} @${li.price}`).join(" | "),
    question: "",
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Orders");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

// ---------------------------------------------------------------------------
// Run log — storage/logs/order-sync-<shop>-<date>.log
// ---------------------------------------------------------------------------
// One appended block per cron run, so "what did the 09:15 run do, and why did
// those three orders fail" is answerable after the fact — the console output of a
// cron process is usually gone. The file is per day (per shop), which keeps it
// findable by date and stops a single file growing without bound.
//
// Writing the log must never be what breaks a sync, so every failure here is
// swallowed with a warning.
const LOG_DIR = "storage/logs";

// The run mode a manual re-sync logs under (see startResync). It reads as a
// normal live run to saveSyncLogRows — only "export…" modes are dry runs — but the
// file log words a few lines differently for it.
const MANUAL_MODE = "manual re-sync";

function syncLogPath(shop, startedAt) {
  const day = startedAt.toISOString().slice(0, 10);
  return path.join(path.resolve(LOG_DIR), `order-sync-${shop}-${day}.log`);
}

// One line per order, plus indented detail lines for anything worth reading:
// the reason it was skipped, the error that failed it, the company chain that
// was built for it, the payment that was recorded.
function syncLogOrderLines(r) {
  const state = !r.ok ? "FAIL" : r.skipped ? "SKIP" : "OK  ";
  const ref = [r.externalId, r.reference].filter(Boolean).join(" ");
  const head = `  ${state} ${String(r.action || "?").padEnd(9)} ${ref}`;
  const lines = [];

  if (r.name || r.id) {
    lines.push(`${head} -> ${[r.name, r.id].filter(Boolean).join(" ")}`);
  } else {
    lines.push(head);
  }
  if (r.matchedBy) lines.push(`         matched by: ${r.matchedBy}${r.via && r.via !== r.matchedBy ? ` (${r.via})` : ""}`);
  if (r.financialStatus || r.fulfillmentStatus) {
    lines.push(`         status: ${r.financialStatus || "-"} / ${r.fulfillmentStatus || "-"}${r.total ? ` | total ${r.total}` : ""}`);
  }
  if (r.netsuiteCompany || r.company) {
    lines.push(`         company: ${r.company || "?"} / ${r.companyLocation || "?"}${r.companyCreated ? ` (created: ${r.companyCreated})` : ""}`);
  }
  if (r.lines) lines.push(`         items: ${r.lines}`);
  if (r.transactions?.length) lines.push(`         payment: ${r.transactions.join(" | ")}`);
  if (r.tracking) lines.push(`         tracking: ${r.tracking}`);
  if (r.deletedId) lines.push(`         deleted: ${r.deletedId}`);
  if (r.reason) lines.push(`         reason: ${r.reason}`);
  if (r.warning) lines.push(`         warning: ${r.warning}`);
  if (r.error) lines.push(`         error: ${r.error}`);
  return lines;
}

function syncLogBlock(run) {
  const { shop, startedAt, finishedAt, since, window, targeted, mode, summary, results, error, files, extra } = run;
  const seconds = ((new Date(finishedAt) - new Date(startedAt)) / 1000).toFixed(1);
  const manual = mode === MANUAL_MODE;
  const lines = [
    "=".repeat(78),
    `[${startedAt}] order-sync ${shop}${mode ? ` (${mode})` : ""} — finished in ${seconds}s`,
  ];
  // A manual re-sync has no date window to report — the order list *is* the scope.
  if (window) {
    // Both ends, not just "since": this run was asked for a stretch that has
    // already ended, so what it did NOT look at is as much of the story as what
    // it did. The watermark note is here because a windowed run leaves it alone,
    // which is what stops "I synced the last hour" from skipping yesterday.
    lines.push(`  window: modified between ${window.from.toISOString()} and ${window.to.toISOString()} (${window.label}) — watermark not moved`);
    // NetSuite can only be asked for whole days (its q filter is date-granular),
    // so a short window always pulls more than it needs and drops the surplus.
    // Said out loud, because otherwise "the last hour matched 40 orders and synced
    // 3" reads like orders went missing.
    if (run.outsideWindow) {
      lines.push(`  ${run.outsideWindow} fetched order(s) fell outside the window (NetSuite filters by day) and were not synced`);
    }
  } else if (!manual) {
    lines.push(`  window: ${since ? `modified since ${since}` : "first run (initial lookback window)"}`);
  }
  if (targeted?.length) {
    const how = manual ? "requested" : "NETSUITE_ORDER_IDS";
    lines.push(`  targeted (${how}): ${targeted.join(", ")} (date window and watermark ignored)`);
  }
  if (run.stoppedEarly) lines.push(`  STOPPED EARLY: ${run.stoppedEarly}`);

  if (error) {
    // The run died before it could process anything — a NetSuite auth failure, a
    // Shopify connection error. This is the case the console would have lost.
    lines.push(`  RUN FAILED: ${error}`);
    return `${lines.join("\n")}\n`;
  }

  if (summary) {
    const byAction = {};
    for (const r of results || []) {
      const key = `${r.action || "?"}${!r.ok ? " failed" : r.skipped ? " skipped" : ""}`;
      byAction[key] = (byAction[key] || 0) + 1;
    }
    const breakdown = Object.entries(byAction).map(([k, n]) => `${k}: ${n}`).join(", ");
    lines.push(`  orders: ${summary.total} | success: ${summary.ok} | failed: ${summary.failed}`);
    if (breakdown) lines.push(`  breakdown: ${breakdown}`);
    // Failures first: the reason anyone opens this file.
    const ordered = [...(results || [])].sort((a, b) => Number(Boolean(a.ok)) - Number(Boolean(b.ok)));
    for (const r of ordered) lines.push(...syncLogOrderLines(r));
    // Quarantined orders are the reason a run can show failures AND still move
    // the watermark, so they have to be named — otherwise the two lines below
    // look like they contradict each other.
    if (run.quarantined?.length) {
      const list = run.quarantined.map((q) => `${q.order} (${q.attempts} runs)`).join(", ");
      lines.push(`  quarantined (SYNC_MAX_ORDER_ATTEMPTS=${orderAttemptLimit()}): ${list}`);
      lines.push("  ^ these keep failing and no longer hold the watermark back. They are still in the failed list and can be re-synced by hand.");
    }
    // A windowed run never moves the watermark in the first place, and its window
    // line has already said so.
    const holding = summary.failed - (run.quarantined?.length || 0);
    if (!manual && !window && (holding > 0 || run.stoppedEarly)) {
      const why = holding > 0 ? `${holding} failed` : "stopped early";
      lines.push(`  watermark NOT advanced (${why}) — the next run re-pulls this window and continues.`);
    }
  }
  // Only worth a line when it did something or broke — an empty slot saying
  // "nothing to do" on every single run would be noise.
  if (extra?.failed) lines.push(`  extra work FAILED: ${extra.error}`);
  else if (extra && !extra.skipped) lines.push(`  extra work: ${JSON.stringify(extra)}`);
  for (const [label, file] of Object.entries(files || {})) lines.push(`  ${label}: ${file}`);
  return `${lines.join("\n")}\n`;
}

function writeSyncLog(run) {
  try {
    fs.mkdirSync(path.resolve(LOG_DIR), { recursive: true });
    const file = syncLogPath(run.shop, new Date(run.startedAt));
    fs.appendFileSync(file, syncLogBlock(run));
    return file;
  } catch (err) {
    console.warn(`[order-sync] could not write the run log: ${err?.message || err}`);
    return null;
  }
}

// The same run, as OrderSyncLog rows — this is what the log page queries (see
// app/routes/app.order-sync-logs.jsx). One row per order, plus a single "run" row
// when the run died before it could process any.
//
// Like the file log, a failure here is never allowed to fail the sync: the orders
// are already in Shopify by this point, and losing the log of that is not a reason
// to report the run as broken.
async function saveSyncLogRows(run) {
  const runAt = new Date(run.startedAt);
  const finishedAt = run.finishedAt ? new Date(run.finishedAt) : null;
  const base = {
    shop: run.shop,
    runAt,
    finishedAt,
    mode: run.mode?.startsWith("export") ? "export" : "live",
  };

  const rows = run.error
    ? [{ ...base, action: "run", status: "failed", message: run.error, detail: JSON.stringify({ error: run.error }) }]
    : (run.results || []).map((r) => ({
      ...base,
      externalId: r.externalId ? String(r.externalId) : null,
      reference: r.reference || null,
      action: r.action || "unknown",
      status: !r.ok ? "failed" : r.skipped ? "skipped" : "success",
      orderName: r.name || null,
      orderId: r.id || null,
      company: r.company || r.netsuiteCompany || null,
      message: r.error || r.reason || r.warning || null,
      detail: JSON.stringify(r),
    }));
  // A run that stopped before it reached a single order has no per-order rows, so
  // without this it would leave nothing at all in the table — the one place
  // anyone looks after pressing Stop sync, and the last place that should stay
  // silent about it. Same shape as the crash row: one "run" row, carrying the
  // reason.
  if (!rows.length && run.stoppedEarly) {
    rows.push({
      ...base,
      action: "run",
      status: "skipped",
      message: run.stoppedEarly,
      detail: JSON.stringify({ reason: run.stoppedEarly }),
    });
  } else if (!rows.length) {
    // A run that finished cleanly and simply had nothing to do — a narrow window
    // ("last 1 hour") with no orders modified in it, most often. Without a row
    // here the table looks EXACTLY the same after this run as it did after one
    // that never ran at all, and there is no way from the page alone to tell
    // "nothing happened" from "nothing to do" — which is precisely the question
    // someone is asking when they picked a short window and the table stayed
    // empty. outsideWindow, when this was a windowed run, is the difference
    // between "0 orders exist in this window" (outsideWindow: 0, nothing to see)
    // and "N orders exist nearby but none fall inside this exact window" (a
    // real count, proof the window is doing its job rather than matching
    // nothing because something upstream is broken).
    // Targeted mode (NETSUITE_ORDER_IDS or a manual re-sync) resolves a hand-picked
    // id list and ignores the window entirely (see fetchNetsuiteOrders), so it has
    // to be checked before run.window here — otherwise a targeted run that also
    // carried a dropdown window would blame the window for zero matches, when the
    // window was never looked at.
    const scope = run.targeted?.length
      ? `${run.targeted.length} targeted order(s)`
      : run.window
        ? `${run.window.label} (${run.window.from.toISOString()} → ${run.window.to.toISOString()})`
        : run.since
          ? `orders modified since ${run.since}`
          : "this run's scope";
    const outside = run.outsideWindow
      ? ` — ${run.outsideWindow} order(s) nearby were modified outside it`
      : "";
    rows.push({
      ...base,
      action: "run",
      status: "skipped",
      message: `No matching orders for ${scope}${outside}.`,
      detail: JSON.stringify({
        reason: "no matching orders",
        window: run.window ? { from: run.window.from.toISOString(), to: run.window.to.toISOString(), label: run.window.label } : null,
        outsideWindow: run.outsideWindow || 0,
        since: run.since || null,
        targeted: run.targeted || [],
      }),
    });
  } else if (run.stoppedEarly) {
    // The run DID find and process orders, but stoppedEarly is also set here for
    // a reason that isn't about any one of them — most often NETSUITE_ORDER_LIMIT
    // capping the run, which is exactly the situation that makes a window pick
    // ("last 1 hour" vs "last 3 hours") look like it did nothing: every window
    // wide enough to contain more than the limit reports the same capped count,
    // and until now nothing said why — this reason lived only in the server's
    // own file log (storage/logs), never in the table anyone actually looks at.
    // A second row, not a replacement for the per-order ones: those are still
    // the record of what happened to each order, this is the record of what
    // happened to the RUN.
    rows.push({
      ...base,
      action: "run",
      status: "skipped",
      message: run.stoppedEarly,
      detail: JSON.stringify({ reason: run.stoppedEarly }),
    });
  }
  if (!rows.length) return 0;

  try {
    await prisma.orderSyncLog.createMany({ data: rows });
    return rows.length;
  } catch (err) {
    console.warn(`[order-sync] could not save the run log to the database: ${err?.message || err}`);
    return 0;
  }
}

// Retention. Without this both logs grow for the life of the app — a cron running
// every 15 minutes over 50 orders writes ~5k rows a day. Nothing here is allowed
// to fail the sync either; an unprunable log is not a broken run.
const DEFAULT_RETENTION_DAYS = 90;

function retentionDays() {
  const n = Number(process.env.SYNC_LOG_RETENTION_DAYS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RETENTION_DAYS;
}

async function pruneSyncLogs(shop) {
  const days = retentionDays();
  // 0 turns retention off rather than deleting everything.
  if (!days) return;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  try {
    const { count } = await prisma.orderSyncLog.deleteMany({
      where: { shop, runAt: { lt: cutoff } },
    });
    if (count) console.log(`[order-sync] pruned ${count} log row(s) older than ${days} day(s).`);
  } catch (err) {
    console.warn(`[order-sync] could not prune old log rows: ${err?.message || err}`);
  }

  // The daily files are named order-sync-<shop>-<YYYY-MM-DD>.log, so the date in
  // the name is what decides — no need to stat anything.
  try {
    const dir = path.resolve(LOG_DIR);
    if (!fs.existsSync(dir)) return;
    const prefix = `order-sync-${shop}-`;
    const cutoffDay = cutoff.toISOString().slice(0, 10);
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith(".log")) continue;
      const day = name.slice(prefix.length, -4);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoffDay) {
        fs.unlinkSync(path.join(dir, name));
        console.log(`[order-sync] pruned old log file ${name}.`);
      }
    }
  } catch (err) {
    console.warn(`[order-sync] could not prune old log files: ${err?.message || err}`);
  }
}

// For the cron route: a run that threw before syncOrdersFromFeed could return
// leaves no summary, and that is exactly the run worth keeping.
export async function logSyncCrash(shop, startedAt, error) {
  const run = {
    shop,
    startedAt: (startedAt instanceof Date ? startedAt : new Date(startedAt)).toISOString(),
    finishedAt: new Date().toISOString(),
    error: error?.message || String(error),
  };
  const logFile = writeSyncLog(run);
  await saveSyncLogRows(run);
  return logFile;
}

// ---------------------------------------------------------------------------
// Main entry — called by the scheduled run
// ---------------------------------------------------------------------------
// Two runs for the same shop must never overlap (see acquireSyncLock), so the
// lock is held for the whole run and released however the run ends. A call that
// arrives while the previous one is still working is reported as skipped rather
// than queued — the next tick will pick the window up anyway.
//
// `options.window` ({ from, to, hours }) narrows the run to the NetSuite orders
// modified in that stretch instead of the watermark's — see buildSyncWindow.
//
// `options.lock` is a lock the CALLER already holds (startCronJobs takes it for
// the whole job list, so a run that is started in the background is visibly
// running before its route returns). When it is passed, this function neither
// acquires nor releases — whoever took it owns it.
export async function syncOrdersFromFeed(shop, options = {}) {
  const runStartedAt = new Date();
  if (options.lock) return runOrderSync(shop, runStartedAt, options);

  const lock = await acquireSyncLock(shop, runStartedAt);
  if (!lock.acquired) {
    const heldSince = lock.heldSince?.toISOString() || "unknown";
    console.warn(`[order-sync] ${shop}: a sync started at ${heldSince} is still running — skipping this run.`);
    return {
      shop,
      skipped: true,
      reason: `another sync run (started ${heldSince}) is still in progress`,
    };
  }
  try {
    return await runOrderSync(shop, runStartedAt, options);
  } finally {
    await releaseSyncLock(shop, lock.token);
  }
}

// An explicit stretch of NetSuite modification time, ending now — "everything
// that changed in the last 2 hours", as picked from the log page's range
// dropdown. Handed to syncOrdersFromFeed as `options.window`, which makes the run
// the scheduled one with its window supplied by hand instead of by the watermark:
// same lock (it must not run alongside the cron and fight it over an order), same
// per-order path, same logging.
//
// Such a run never moves the watermark, for the same reason a targeted re-sync
// doesn't: it answered a question about one stretch of time, and advancing the
// watermark to now would permanently skip everything the scheduled run still owes
// from before that stretch.
export function buildSyncWindow(hours) {
  const n = Number(hours);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`invalid sync window: ${hours}`);
  }
  // windowRange, not the arithmetic written out again: the log page shows the
  // same pair under the dropdown before the button is pressed, and a preview
  // that drifted from the run it previews would be worse than no preview.
  return { ...windowRange(n), hours: n, label: windowLabel(n) };
}

// How long a single run may spend processing orders. Cron intervals are short and
// hosts kill long requests, so the run stops cleanly at the budget instead of
// being cut off mid-order: what it finished is logged, the watermark is left where
// it was, and the next run picks up the rest.
const DEFAULT_MAX_RUN_MS = 10 * 60 * 1000;

function maxRunMs() {
  const n = Number(process.env.SYNC_MAX_RUN_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_RUN_MS;
}

// The per-order sync itself, over whatever set of NetSuite records it was handed.
// Shared by the scheduled run and by a manual re-sync of hand-picked orders
// (runResync), so both take exactly the same path per order.
//
// `results` is appended to in place — the caller has usually already put the
// fetch failures in it, and the stopped-early message counts them as work done.
// Returns the stopped-early reason, or null if it got through every record.
async function processOrderRecords({ admin, shop, records, currencyCode, caches, deadline, results }) {
  for (const rec of records) {
    const entry = mapNetsuiteOrder(rec);
    const { externalId, action } = entry;
    // Checked between orders, never inside one: an order is created, tagged and
    // linked to its company across several calls, and abandoning it half way is
    // worse than running a minute over.
    if (Date.now() > deadline) {
      const stoppedEarly = `run time budget reached after ${results.length} of ${records.length} order(s) — the rest are left for the next run`;
      console.warn(`[order-sync] ${shop}: ${stoppedEarly}`);
      return stoppedEarly;
    }
    // Stop sync, pressed on the log page. Checked in the same place and for the
    // same reason as the budget above: an order is created, tagged and linked to
    // its company across several calls, so the only safe place to stop is
    // between two of them. What is already done stays done, the watermark is
    // left where it was (a stopped-early run never advances it), and the next
    // run picks the rest up.
    if (await isSyncStopRequested(shop)) {
      const stoppedEarly = `stopped by hand after ${results.length} of ${records.length} order(s) — the rest are left for the next run`;
      console.warn(`[order-sync] ${shop}: ${stoppedEarly}`);
      return stoppedEarly;
    }
    try {
      let outcome;
      if (action === "delete") {
        outcome = await deleteOrder(admin, entry);
      } else {
        // upsert: work out which Shopify order (if any) this NetSuite order
        // belongs to. A match is a tracking-only update — never a full
        // overwrite. Only an unmatched NetSuite-native order is created.
        const match = await resolveShopifyOrder(admin, entry);
        if (match.id) {
          outcome = await syncTracking(admin, entry, match.id, match.via);
        } else if (match.allowCreate) {
          outcome = await createOrder(admin, entry, currencyCode, caches);
        } else {
          outcome = { ok: true, action: "skip", skipped: true, matchedBy: match.via, reason: match.reason };
        }
      }
      // `reference` (the SO number) rides along so the run log and the API
      // response name orders the way NetSuite users do, not just by internal id.
      results.push({ externalId, reference: entry.reference, action: outcome.action || action, ...outcome });
    } catch (err) {
      // A NetSuite call that gave up because the run was stopped is not this
      // order failing — recording it as one would leave a red row in the log
      // blaming the order for a button someone pressed. The order is simply not
      // done: the watermark stays put and the next run picks it up.
      if (isSyncStoppedError(err)) {
        const stoppedEarly = `stopped by hand after ${results.length} of ${records.length} order(s) — the rest are left for the next run`;
        console.warn(`[order-sync] ${shop}: ${stoppedEarly}`);
        return stoppedEarly;
      }
      results.push({ externalId, reference: entry.reference, action, ok: false, error: err?.message || String(err) });
    }
    // Counted here, outside the try, because "done" means "this run is finished
    // with this order" — a failed one is as done as a successful one, and a
    // progress count that stalled on failures would read as a hung sync.
    await bumpSyncDone(shop);
  }
  return null;
}

function summarise(results) {
  return {
    total: results.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  };
}

// ---------------------------------------------------------------------------
// Manual re-sync — called by the log page's Sync buttons
// ---------------------------------------------------------------------------
// Re-runs specific NetSuite orders, given as internal ids or SO numbers. It is
// the scheduled run narrowed to a hand-picked set: same lock (a re-sync must not
// run alongside the cron and fight it over the same order), same per-order path,
// same file/database logging — so the retry shows up in the log table as its own
// run, next to the failure it was retrying.
//
// The watermark is never moved. Like a targeted run, this looked at only the
// orders it was asked about, so advancing it would permanently skip everything
// else modified in the meantime. SYNC_ORDER_EXPORT is ignored too: a re-sync is
// an explicit "write this order to Shopify now", not a preview.
//
// Started, NOT awaited — same trick as startCronJobs, and for the same reason:
// this used to hold the browser's request open for the whole re-sync (a fetch
// from NetSuite plus a second of rate-limit sleep per order), and the log
// page's syncRunning — the thing that shows progress and the Stop button — is
// read from the LOADER. The loader only learns a re-sync is happening once this
// request returns, so while it stayed open for the full run, Sync selected and
// the per-row Sync button both looked, from the page's side, like nothing was
// running at all: no progress, no way to stop. Returning as soon as the lock is
// held fixes that the same way it already worked for Sync now.
// `knownInternalIds`, if given, is the subset of `ids` the caller already knows
// to be NetSuite internal ids rather than SO numbers a human typed — a re-sync
// row's own externalId, for instance. It buys those a direct lookup instead of
// resolveOrderId's tranId-search-first ambiguity handling — see
// resolveKnownInternalId in netsuite.server.js for why that matters for how long
// a re-sync of one or two known rows takes.
export async function startResync(shop, ids, { knownInternalIds } = {}) {
  const requested = [...new Set((ids || []).map((v) => String(v).trim()).filter(Boolean))];
  if (!requested.length) {
    return { started: false, requested, reason: "nothing to sync" };
  }

  const runStartedAt = new Date();
  const lock = await acquireSyncLock(shop, runStartedAt);
  if (!lock.acquired) {
    return { started: false, requested, heldSince: lock.heldSince ?? null };
  }

  const promise = (async () => {
    try {
      return await runResync(shop, requested, runStartedAt, knownInternalIds);
    } catch (err) {
      // Died before it produced a summary — a NetSuite auth failure, a Shopify
      // connection error. There is no request left to report this to, so it is
      // logged the way a crashed cron job is, leaving a trace in the table
      // instead of only in a console nobody is watching.
      await logSyncCrash(shop, runStartedAt, err);
      throw err;
    } finally {
      await releaseSyncLock(shop, lock.token);
    }
  })();
  // Nothing may reject out of here unobserved — see startCronJobs for why.
  promise.catch((err) => {
    console.error(`[order-sync] ${shop}: re-sync failed outside its own handling: ${err?.message || err}`);
  });

  return { started: true, requested, promise };
}

// The actual work of a re-sync, once startResync is holding the lock.
async function runResync(shop, requested, runStartedAt, knownInternalIds) {
  const feed = await fetchExternalOrders(shop, { ids: requested, knownInternalIds });
  const records = Array.isArray(feed?.items) ? feed.items : [];
  // Orders that could not be fetched (or resolved to a sales order at all) are
  // failures of this re-sync, not silent no-ops.
  const results = (feed?.errors || []).map(({ id, error }) => ({
    externalId: String(id),
    action: "fetch",
    ok: false,
    error: `NetSuite fetch failed: ${error}`,
  }));

  const { admin } = await unauthenticated.admin(shop);
  const currencyCode = await getShopCurrency(admin);
  const caches = { company: new Map(), variant: new Map() };
  // Stopped while the ids were still being resolved, or straight after. A
  // re-sync moves no watermark, so unlike the scheduled run there is nothing to
  // protect here — it simply does none of the orders rather than an arbitrary
  // prefix of the ones that were ticked.
  //
  // Checked BEFORE setSyncTotal below, same as runOrderSync: fetchNetsuiteOrders
  // already left "fetching" progress behind (how many of the requested ids it
  // got through), and a stopped run should keep reporting that rather than
  // being overwritten with a "syncing" total that never moves off 0.
  const stopped = feed?.stopped || (await isSyncStopRequested(shop));
  let stoppedEarly;
  if (stopped) {
    stoppedEarly = `stopped by hand before any of the ${records.length} re-synced order(s) were written`;
    console.warn(`[order-sync] ${shop}: ${stoppedEarly}`);
  } else {
    // A hand-picked re-sync holds the same lock and shows up in the same place
    // on the page, so it reports progress the same way a scheduled run does.
    await setSyncTotal(shop, records.length);
    stoppedEarly = await processOrderRecords({
      admin,
      shop,
      records,
      currencyCode,
      caches,
      deadline: runStartedAt.getTime() + maxRunMs(),
      results,
    });
  }

  const summary = summarise(results);

  // The extra work runs after a re-sync too, so this path doesn't quietly do
  // less than the others. The cron and Sync now reach it through CRON_JOBS; a
  // re-sync never touches that list — it is deliberately narrowed to the orders
  // that were ticked — so the one job that is about the SHOP rather than about
  // this run's orders is called here directly.
  //
  // Best effort, because by this point the orders are already in Shopify:
  // failing to do the extra work is not a reason to report the re-sync as
  // broken. It is reported instead.
  let extra;
  try {
    extra = await extraFunction(shop);
  } catch (err) {
    extra = { failed: true, error: err?.message || String(err) };
    console.warn(`[order-sync] ${shop}: extraFunction failed after the re-sync: ${extra.error}`);
  }

  const run = {
    shop,
    mode: MANUAL_MODE,
    startedAt: runStartedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    targeted: requested,
    summary,
    results,
    stoppedEarly,
    extra,
  };
  const logFile = writeSyncLog(run);
  await saveSyncLogRows(run);
  return {
    shop,
    requested,
    summary,
    results,
    logFile,
    extra,
    ...(stoppedEarly ? { stoppedEarly } : {}),
  };
}

async function runOrderSync(shop, runStartedAt, { window } = {}) {
  // Targeted mode (NETSUITE_ORDER_IDS) fetches a hand-picked set of orders and
  // ignores the date window, so such a run must never move the watermark.
  const targeted = targetedOrderIds();
  // A windowed run doesn't read the watermark at all — its window was given to it.
  // `since` still stands for "the oldest modification time this run looked at", so
  // the log lines below read the same either way.
  const since = window ? window.from : await getLastSyncedAt(shop);
  // Where a previous run's NETSUITE_ORDER_LIMIT cap left off, so this run
  // resumes further into the backlog instead of re-listing from the top and
  // capping on the exact same candidates every time — see setSyncListOffset
  // (scheduled) and setSyncWindowResume (windowed). Meaningless for a
  // targeted run: a hand-picked id list has no "period" or "session" to
  // resume, it just asks about exactly what it was given.
  //
  // A windowed run's query is recomputed here (not just derived from the
  // window) because THIS is the exact q the run is about to send — the same
  // string a resumed session is checked against below, so "does this request
  // match the saved session" can never silently disagree with "what did the
  // saved session actually run".
  const windowQuery = window ? buildOrdersQuery(since, window) : null;
  let startOffset = 0;
  if (targeted.length) {
    startOffset = 0;
  } else if (window) {
    const resume = await getSyncWindowResume(shop);
    // Both the hours choice AND the exact day-granular query have to match —
    // see the schema comment on syncWindowOffset for the hazard two different
    // hours choices sharing one query would create if only the query were
    // checked.
    if (resume.hours === window.hours && resume.query === windowQuery) {
      startOffset = resume.offset;
    }
  } else {
    startOffset = await getSyncListOffset(shop);
  }
  const feed = await fetchExternalOrders(shop, window ? { window, startOffset } : { since, startOffset });
  const records = Array.isArray(feed?.items) ? feed.items : [];

  // Stop sync, pressed while the fetch was in flight. Fetching is the longest
  // stretch of a big run — NetSuite is paged and then each order is expanded
  // with a second of rate-limit sleep between — so the fetch stops itself part
  // way through and says so in `feed.stopped`, and this is where that lands:
  // before anything is written to Shopify, exported, or logged as synced.
  //
  // Both conditions are asked, because they are different facts. `feed.stopped`
  // means the fetch broke off and the records in hand are an arbitrary prefix of
  // the run's real scope — syncing them and advancing the watermark would skip
  // the rest for good. The flag means the press landed after the fetch finished.
  // Note this is checked BEFORE the export branch too, so a stopped dry run
  // doesn't leave a set of export files behind describing work that was called off.
  if (feed?.stopped || (await isSyncStopRequested(shop))) {
    const stoppedEarly = feed?.stopped
      ? `stopped by hand while fetching — ${records.length} order(s) had been read and none were synced`
      : `stopped by hand before any of the ${records.length} fetched order(s) were synced`;
    console.warn(`[order-sync] ${shop}: ${stoppedEarly}`);
    const run = {
      shop,
      mode: window ? `window sync (${window.label})` : undefined,
      startedAt: runStartedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      since: since?.toISOString() || null,
      window,
      targeted,
      summary: { total: 0, ok: 0, failed: 0 },
      results: [],
      stoppedEarly,
    };
    const logFile = writeSyncLog(run);
    await saveSyncLogRows(run);
    return { shop, stopped: true, stoppedEarly, summary: run.summary, results: [], logFile };
  }

  // What this run has to get through. Set before any of it is done, so the page
  // can show "0 of 50" rather than nothing at all — the log rows do not arrive
  // until the run ends, and on a 50-order run that is minutes of silence.
  await setSyncTotal(shop, records.length);

  if (process.env.SYNC_ORDER_EXPORT === "true") {
    const exportDir = path.resolve("storage/exports");
    fs.mkdirSync(exportDir, { recursive: true });
    const timestamp = runStartedAt.toISOString().replace(/[:.]/g, "-");
    const mapped = records.map(mapNetsuiteOrder);

    // Raw NetSuite records
    const jsonPath = path.join(exportDir, `orders-${shop}-${timestamp}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify({ shop, exportedAt: runStartedAt.toISOString(), since: since?.toISOString() || null, raw: records, mapped }, null, 2));

    const csvPath = path.join(exportDir, `orders-${shop}-${timestamp}.csv`);
    fs.writeFileSync(csvPath, ordersToCsv(mapped));

    const xlsxPath = path.join(exportDir, `orders-${shop}-${timestamp}.xlsx`);
    fs.writeFileSync(xlsxPath, ordersToExcel(mapped));

    // Shopify orderCreate input preview — exact objects that would be sent
    const currencyCode = "USD";
    const shopifyInputs = mapped.map((entry) => ({
      netsuiteId: entry.externalId,
      netsuiteRef: entry.reference,
      action: entry.action,
      // The company whose Shopify location the real create would resolve and
      // attach (companyLocationId) — it can't be looked up here, this block runs
      // before an admin client exists.
      netsuiteCompany: entry.companyName,
      shopifyOrderInput: buildOrderInput(entry, currencyCode),
      options: { sendReceipt: false, sendFulfillmentReceipt: false },
    }));
    const previewPath = path.join(exportDir, `shopify-preview-${shop}-${timestamp}.json`);
    fs.writeFileSync(previewPath, JSON.stringify({ shop, currencyCode, exportedAt: runStartedAt.toISOString(), orders: shopifyInputs }, null, 2));

    if (process.env.NETSUITE_USE_DEMO === "false" && !targeted.length && !window) {
      await setLastSyncedAt(shop, runStartedAt, since);
    }
    // A dry run handled every record it fetched, in one step — see setSyncTotal.
    await setSyncTotal(shop, mapped.length, mapped.length);
    const exportRun = {
      shop,
      mode: "export (dry run — nothing written to Shopify)",
      startedAt: runStartedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      since: since?.toISOString() || null,
      window,
      targeted,
      summary: { total: mapped.length, ok: mapped.length, failed: (feed?.errors || []).length },
      results: (feed?.errors || []).map(({ id, error }) => ({
        externalId: String(id), action: "fetch", ok: false, error: `NetSuite fetch failed: ${error}`,
      })),
      files: { json: jsonPath, csv: csvPath, xlsx: xlsxPath, preview: previewPath },
    };
    const logFile = writeSyncLog(exportRun);
    await saveSyncLogRows(exportRun);
    return { shop, mode: "export", jsonFile: jsonPath, csvFile: csvPath, xlsxFile: xlsxPath, previewFile: previewPath, logFile, total: mapped.length, since: since?.toISOString() || null };
  }

  const { admin } = await unauthenticated.admin(shop);
  const currencyCode = await getShopCurrency(admin);

  // Orders NetSuite listed but whose detail fetch failed never became records
  // above — surface them as failed results instead of dropping them silently.
  const results = (feed?.errors || []).map(({ id, error }) => ({
    externalId: String(id),
    action: "fetch",
    ok: false,
    error: `NetSuite fetch failed: ${error}`,
  }));
  // Company-location and sku->variant lookups, shared across the whole run: a
  // window normally holds many orders for the same handful of companies and
  // repeats the same items across orders.
  const caches = { company: new Map(), variant: new Map() };
  const deadline = runStartedAt.getTime() + maxRunMs();
  // A capped fetch means the same thing to the watermark as running out of time:
  // orders inside this window were never looked at, so it must not move past them.
  //
  // Worded differently for the two cases, because they behave differently now.
  // A SCHEDULED run's list-offset cursor advances past whatever it did process
  // (see setSyncListOffset below) — the next tick continues further into this
  // same backlog on its own, no action needed. A WINDOWED run has no such
  // cursor — it is a one-time question about one stretch of time, and pressing
  // Sync now again just re-asks the same question and gets capped at the same
  // place, so raising the limit or narrowing the window are the only ways
  // forward for it.
  const capped = feed?.capped
    ? window
      ? `NETSUITE_ORDER_LIMIT=${feed.capped.limit} capped this run — ${feed.capped.skipped} of ${feed.capped.matched} matching order(s) were not fetched. A windowed run does not continue automatically: raise the limit or narrow the window to reach the rest.`
      : `NETSUITE_ORDER_LIMIT=${feed.capped.limit} capped this run — ${feed.capped.skipped} of ${feed.capped.matched} matching order(s) not yet reached. The next scheduled run continues automatically from here; raise the limit to cover more per run.`
    : null;
  const stoppedEarly =
    (await processOrderRecords({ admin, shop, records, currencyCode, caches, deadline, results })) || capped;

  const summary = summarise(results);

  // Orders that have failed so many runs in a row that they are no longer allowed
  // to hold the watermark back (see quarantinedOrders). Marked on the result
  // itself so the log row and its detail dialog say so — a quarantined order is
  // still failed, still listed, still re-syncable by hand; the only thing that
  // changed is that the rest of the sync gets to move past it.
  const failures = results.filter((r) => !r.ok);
  const quarantined = failures.length ? await quarantinedOrders(shop, failures) : new Map();
  for (const failure of failures) {
    const attempts = quarantined.get(String(failure.externalId || "") || failure.reference);
    if (attempts) {
      failure.attempts = attempts;
      failure.quarantined = true;
    }
  }
  // A failure that is NOT quarantined is what parks the watermark.
  const blocking = failures.length - quarantined.size;

  // Advance the watermark only on a fully clean run that ALSO reached the end
  // of this period's candidate list. If anything failed (a NetSuite fetch
  // error or a Shopify create/update error), we leave it where it was so the
  // next run re-pulls the same window and retries — the sync is idempotent, so
  // re-processing succeeded orders is harmless. A run that stopped at its time
  // budget is in the same position: orders in the window were never looked at,
  // and moving the watermark past them would skip them for good. Demo mode
  // never advances the watermark (there's no real modified-date to track), and
  // neither does a targeted run — it only looked at a hand-picked set of
  // orders, so moving the watermark would permanently skip everything else
  // modified in the meantime.
  // …and neither does a windowed run: it was asked about one stretch of
  // modification time, so moving the watermark to now would skip everything the
  // scheduled run still owes from before it.
  if (process.env.NETSUITE_USE_DEMO === "false" && !targeted.length && !window) {
    if (blocking === 0 && !stoppedEarly) {
      // Fully clean AND the day-granular candidate list for this period was
      // exhausted (not capped) — this period is completely drained.
      // `since` rides along so the schedule card can say what this run
      // covered, not only when it ran. setLastSyncedAt also resets the
      // list-offset cursor, so the fresh period that starts next lists from
      // the top rather than resuming a position that no longer means anything.
      await setLastSyncedAt(shop, runStartedAt, since);
    } else if (blocking === 0 && feed?.capped) {
      // Capped by NETSUITE_ORDER_LIMIT, but everything this run DID process
      // succeeded — safe to walk the list cursor forward past it, so the NEXT
      // run resumes further into this SAME period instead of the cap landing
      // on the exact same first N candidates every time, forever, which is
      // the bug this whole mechanism exists to fix: a backlog bigger than the
      // limit now drains across successive runs instead of never finishing.
      // The watermark itself stays put on purpose — this period is not done,
      // and moving it would let a later run believe it was.
      await setSyncListOffset(shop, startOffset + feed.capped.fetched);
    }
    // Any other case — a genuine failure blocked progress, capped or not —
    // leaves both the watermark and the list-offset exactly where they were,
    // so the same starting point (and so the same failed orders) comes up
    // again next run. This is the existing retry behavior, unchanged.
  }

  // The windowed equivalent of the block above — a windowed run has no
  // watermark, so "done with this period" is tracked as its own session (see
  // setSyncWindowResume) instead. Same shape, same reasoning: a capped-but-
  // clean run advances the cursor so the SAME hours choice, pressed again,
  // continues past what this run covered; a fully-drained clean run clears
  // the session because there is nothing left to resume; anything with a
  // genuine failure leaves the session exactly where it was, so the failure
  // stays reachable at the same position rather than the cursor stepping
  // over it.
  //
  // `feed.scanned`, not feed.capped.fetched — see the comment on that field in
  // fetchNetsuiteOrders. items.length (what capped.fetched counts) is how many
  // landed IN the window; scanned is how many were looked at, in or out, which
  // is the number that has to be skipped on resume or an out-of-window
  // candidate this run already ruled out could get missed by a narrower
  // window that still needed its own look at it.
  if (window) {
    if (blocking === 0 && feed?.capped) {
      await setSyncWindowResume(shop, {
        offset: startOffset + (feed.scanned ?? 0),
        query: windowQuery,
        hours: window.hours,
      });
    } else if (blocking === 0 && !stoppedEarly) {
      await clearSyncWindowResume(shop);
    }
  }

  const run = {
    shop,
    mode: window ? `window sync (${window.label})` : undefined,
    startedAt: runStartedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    since: since?.toISOString() || null,
    window,
    outsideWindow: feed?.outsideWindow || 0,
    quarantined: [...quarantined.entries()].map(([order, attempts]) => ({ order, attempts })),
    targeted,
    summary,
    results,
    stoppedEarly,
  };
  const logFile = writeSyncLog(run);
  await saveSyncLogRows(run);
  await pruneSyncLogs(shop);
  return {
    shop,
    summary,
    results,
    logFile,
    ...(stoppedEarly ? { stoppedEarly } : {}),
    since: since?.toISOString() || null,
    ...(window
      ? { window: { hours: window.hours, label: window.label, from: window.from.toISOString(), to: window.to.toISOString() } }
      : {}),
    ...(targeted.length ? { targetedOrderIds: targeted } : {}),
  };
}

// ---------------------------------------------------------------------------
// GraphQL helpers
// ---------------------------------------------------------------------------
async function getShopCurrency(admin) {
  const resp = await admin.graphql(`#graphql
    query ShopCurrency { shop { currencyCode } }`);
  const body = await resp.json();
  return body?.data?.shop?.currencyCode || "USD";
}

// Finds the Shopify order previously created for this externalId (by tag).
// Returns the order gid or null.
//
// The returned tags are re-checked rather than trusting the search result: this
// gid is what gets tracking written to it and, on a cancellation, what gets
// DELETED, so a loose search match must never be mistaken for a hit. More than
// one match means the store already holds duplicates — that is surfaced as an
// error instead of silently picking one of them to update or delete.
async function findOrderIdByExternalId(admin, externalId) {
  const tag = extTag(externalId);
  const resp = await admin.graphql(
    `#graphql
    query FindOrderByTag($query: String!) {
      orders(first: 10, query: $query) {
        nodes { id name tags }
      }
    }`,
    { variables: { query: `tag:'${tag}'` } },
  );
  const body = await resp.json();
  const hits = (body?.data?.orders?.nodes || []).filter((n) => (n.tags || []).includes(tag));
  if (hits.length > 1) {
    throw new Error(`NetSuite id ${externalId} matches ${hits.length} Shopify orders (${hits.map((h) => h.name).join(", ")}) — refusing to guess`);
  }
  return hits[0]?.id || null;
}

// ---------------------------------------------------------------------------
// Matching — which Shopify order does this NetSuite order belong to?
// ---------------------------------------------------------------------------
// Two very different kinds of sales order come out of NetSuite:
//
//  1. Celigo-imported orders. These ORIGINATED in Shopify; the Celigo connector
//     pushed them into NetSuite and stamped the source store onto the billing
//     and/or shipping address (custrecord_celigo_shopify_store), with the
//     Shopify order reference in otherRefNum. BOTH must be present to take this
//     route — the store marker says "Shopify owns this order", otherRefNum is
//     the only thing that says WHICH order, and one without the other is not
//     enough to act on. Shopify is the system of record for everything except
//     fulfillment, so these are never created here (that would duplicate the
//     merchant's own order) and never field-overwritten — the only thing pushed
//     back is tracking, and only when otherRefNum resolves to a real order.
//
//  2. Everything else. Found by the ext:<netsuiteId> tag written at create time:
//     found → tracking-only update, not found → create.
//
// Returns { id, via, allowCreate, reason }.
async function resolveShopifyOrder(admin, entry) {
  if (entry.isCeligoOrder && entry.otherRefNum) {
    const id = await findOrderByShopifyRef(admin, entry.otherRefNum);
    return {
      id,
      via: "otherRefNum",
      allowCreate: false,
      reason: id ? null : `otherRefNum "${entry.otherRefNum}" did not match any Shopify order — not creating (Celigo order)`,
    };
  }
  return {
    id: await findOrderIdByExternalId(admin, entry.externalId),
    via: "netsuite_id",
    allowCreate: true,
    reason: null,
  };
}

const ORDER_GID = /^gid:\/\/shopify\/Order\/\d+$/;

// Resolves a NetSuite otherRefNum to a Shopify order gid, or null. Celigo
// writes one of three shapes into that field depending on how the connector is
// configured, so all three are tried: a full gid, the numeric Shopify order id
// ("5123456789012"), or the order number/name ("1030" / "#1030").
async function findOrderByShopifyRef(admin, ref) {
  const raw = String(ref).trim();
  if (!raw) return null;
  if (ORDER_GID.test(raw)) return (await orderExists(admin, raw)) ? raw : null;

  const number = raw.replace(/^#/, "").trim();
  if (!number) return null;
  // otherRefNum is a free-text NetSuite field, so on a non-Celigo-shaped value
  // ("ANA PO23911", "n/a") the lookup is abandoned rather than fed into the
  // order search as-is. Nothing matches -> nothing is updated.
  if (!/^[A-Za-z0-9-]+$/.test(number)) return null;

  // Shopify order ids are long (13+ digits); order numbers are short. Only try
  // the id lookup when the value is plausibly an id, so a 4-digit order number
  // doesn't cost an extra round trip.
  if (/^\d{10,}$/.test(number)) {
    const gid = `gid://shopify/Order/${number}`;
    if (await orderExists(admin, gid)) return gid;
  }
  return findOrderByName(admin, number);
}

async function orderExists(admin, gid) {
  const resp = await admin.graphql(
    `#graphql
    query OrderById($id: ID!) {
      order(id: $id) { id name }
    }`,
    { variables: { id: gid } },
  );
  const body = await resp.json();
  return Boolean(body?.data?.order?.id);
}

// Looks the order up by its number/name. `name:` search is fuzzy enough to
// return neighbours (e.g. "1030" can surface "#10300"), so the results are
// filtered down to an exact name match and an ambiguous hit is treated as an
// error rather than guessed at.
async function findOrderByName(admin, number) {
  const wanted = new Set([`#${number}`.toLowerCase(), number.toLowerCase()]);
  for (const q of [`name:#${number}`, `name:${number}`]) {
    const resp = await admin.graphql(
      `#graphql
      query FindOrderByName($query: String!) {
        orders(first: 10, query: $query) {
          nodes { id name legacyResourceId }
        }
      }`,
      { variables: { query: q } },
    );
    const body = await resp.json();
    const hits = (body?.data?.orders?.nodes || []).filter(
      (n) => wanted.has(String(n.name || "").toLowerCase()) || String(n.legacyResourceId) === number,
    );
    if (hits.length === 1) return hits[0].id;
    if (hits.length > 1) {
      throw new Error(`otherRefNum "${number}" matched ${hits.length} Shopify orders (${hits.map((h) => h.name).join(", ")}) — refusing to guess`);
    }
  }
  return null;
}

// The Shopify order name = configurable prefix + the NetSuite reference
// (tranId, e.g. "SO1504") when present, otherwise the raw NetSuite id.
function orderName(entry) {
  const prefix = process.env.NETSUITE_ORDER_PREFIX || "";
  return `${prefix}${entry.reference || entry.externalId}`;
}

// ---------------------------------------------------------------------------
// Line items — NetSuite item name -> Shopify variant
// ---------------------------------------------------------------------------
// The NetSuite item name IS the SKU on this account ("3DXTECH-WHITE",
// "500-196-30", "8-00147"), so it's what a Shopify variant is looked up by. A hit
// links the order line to the real product — its image, its analytics, the
// customer seeing a product rather than a line of text. A miss leaves the line as
// what it already was, a custom line item, and never holds the order back: plenty
// of NetSuite lines are not products at all ("Certificate of Conformance"), and an
// order refused over one of those would be an order that never reaches Shopify.
//
// Batched and cached per run because a 50-order window carries ~140 distinct
// items, and one round trip each is 140 round trips.
const VARIANT_SKU_BATCH = 25;

// Fills `cache` (skuKey -> variant gid, or null for "looked up, not found") for
// every sku it hasn't already resolved.
async function resolveVariantsBySku(admin, skus, cache) {
  const wanted = new Map();
  for (const sku of skus) {
    const key = skuKey(sku);
    // Embedded quotes and backslashes would break out of the search term. A sku
    // carrying them is left unresolved rather than half-escaped into a query that
    // matches something else.
    if (!key || cache.has(key) || /["\\]/.test(sku)) continue;
    wanted.set(key, sku);
  }
  if (!wanted.size) return cache;

  const entries = [...wanted.entries()];
  for (let i = 0; i < entries.length; i += VARIANT_SKU_BATCH) {
    const batch = entries.slice(i, i + VARIANT_SKU_BATCH);
    // Recorded as "not found" up front so a sku that the search doesn't return is
    // never looked up twice in the same run.
    for (const [key] of batch) cache.set(key, null);

    const query = batch.map(([, sku]) => `sku:"${sku}"`).join(" OR ");
    let nodes = [];
    try {
      const resp = await admin.graphql(
        `#graphql
        query VariantsBySku($query: String!) {
          productVariants(first: 250, query: $query) {
            nodes { id sku }
          }
        }`,
        { variables: { query } },
      );
      const body = await resp.json();
      if (body?.errors?.length) throw new Error(gqlError(body));
      nodes = body?.data?.productVariants?.nodes || [];
    } catch (err) {
      // A failed lookup must not fail the order — the lines simply stay custom.
      console.warn(`[order-sync] variant lookup by sku failed (${err?.message || err}); those lines stay unlinked.`);
      continue;
    }

    // Shopify's search is fuzzy, so the decision is an exact sku match on the
    // results. Two variants sharing a sku is ambiguous: linking the order to the
    // wrong product is worse than leaving the line custom, so it's left alone.
    const bySku = new Map();
    for (const node of nodes) {
      const key = skuKey(node.sku);
      if (!wanted.has(key)) continue;
      if (bySku.has(key)) bySku.set(key, "ambiguous");
      else bySku.set(key, node.id);
    }
    for (const [key, value] of bySku) {
      if (value === "ambiguous") {
        console.warn(`[order-sync] sku "${wanted.get(key)}" matches more than one Shopify variant — leaving that line unlinked.`);
        continue;
      }
      cache.set(key, value);
    }
  }
  return cache;
}

// ---------------------------------------------------------------------------
// B2B company location resolution
// ---------------------------------------------------------------------------
// A NetSuite order that carries custbody_ava_customercompanyname belongs to a
// B2B company, and the Shopify order has to be attached to that company's
// location (orderCreate's companyLocationId) for the buyer to see it in their
// company account and for company pricing/terms to apply.
//
// The chain is: NetSuite company name + customer email
//   -> Shopify customer (by email)
//   -> the company named after the NetSuite company    (created if missing)
//   -> the customer as a contact of that company       (created if missing)
//   -> that company's location of the same name        (created if missing)
//   -> a role for the contact at that location         (assigned if missing)
//
// The last two links are not optional decoration: orderCreate rejects a company
// order outright with "no customer_id was provided" unless the customer is named
// by id, and with "the customer has no role in this company" unless that customer
// holds a role at the location.
//
// One Shopify rule shapes the whole thing: a customer can be the contact of
// exactly ONE company. So a customer already attached to a different company is
// where this stops — it cannot be shared or moved, and the order says so instead
// of creating a company nobody can be a contact of.
//
// Otherwise nothing along the way is a dead end: a missing company, contact,
// location or role is created and the chain carries on. The NetSuite company NAME is the authority
// throughout — the customer's other companies are never substituted for it,
// because attaching an order to the wrong company would show one buyer another
// company's order. What does stop the create is a name that can't be resolved to
// exactly one company (an unusable email, or duplicate companies already sharing
// the name); the caller then reports the order as failed rather than dropping the
// company link, since a B2B order created without one is invisible to the buyer
// and impossible to spot afterwards.
//
// Results are cached per run (keyed on email + company name) because a sync
// window normally holds many orders for the same handful of companies, and
// without it two orders for a new company would each create it.
async function resolveCompanyLocationId(admin, entry, cache) {
  const key = `${companyNameKey(entry.customer?.email)}|${companyNameKey(entry.companyName)}`;
  if (cache?.has(key)) return cache.get(key);
  const resolved = await lookupCompanyLocation(admin, entry);
  // Failures are cached too: the chain is deterministic within a run, so the
  // remaining orders for the same company fail fast instead of re-asking Shopify
  // the same question. `created` is emptied on the cached copy — it describes
  // what THIS order's lookup made, and the orders behind it made nothing.
  cache?.set(key, resolved.companyLocationId ? { ...resolved, created: [] } : resolved);
  return resolved;
}

// Returns { companyId, companyName, companyLocationId, locationName, customerId,
// created } on success — `created` lists whatever this call had to make
// ("company", "contact", "location", "role") — or { error } describing what
// stopped it.
async function lookupCompanyLocation(admin, entry) {
  const wantedName = entry.companyName;
  const wantedKey = companyNameKey(wantedName);
  // Note: this is the same email the order is created with, so TEST_EMAIL
  // redirects the company lookup to the test customer too (see mapNetsuiteOrder).
  const email = entry.customer?.email;
  // The email is the one thing that can't be conjured: it's how the buyer is
  // identified as this company's contact.
  if (!email) {
    return { error: "the NetSuite order has no customer email, so no company contact can be identified" };
  }

  // The customer may not exist yet, in which case the contact mutations below
  // create one from these details.
  const customer = await fetchCustomerCompanyContacts(admin, email);
  const profiles = (customer?.companyContactProfiles || []).filter((p) => p?.company?.id);
  const created = [];
  let customerId = customer?.id || null;
  let contactId = null;
  let company = null;
  let locations = null;

  // 1. Already a contact of a company with this name — the common case, no writes.
  const profile = profiles.find((p) => companyNameKey(p.company.name) === wantedKey);
  if (profile) {
    company = profile.company;
    contactId = profile.id;
  } else if (profiles.length) {
    // Shopify allows a customer exactly ONE company: companyAssignCustomerAsContact
    // and companyContactCreate both refuse with "Customer is already associated with
    // a company contact". So a customer attached to a different company cannot be
    // used for this order, and checking here rather than after the create is what
    // matters — creating the company first left an orphan company (with a location,
    // and no contact) behind on every attempt.
    const held = profiles.map((p) => `"${p.company.name}"`).join(", ");
    return {
      error: `Shopify customer ${email} is already the contact of ${held}, and Shopify allows a customer only one company — this order names "${wantedName}". Point the order at that company's own contact email, or fix the customer's company in Shopify.`,
    };
  }

  // 2. The company exists on the shop but this customer isn't one of its contacts
  //    yet (a first order from a new buyer at a company we already know).
  if (!company) {
    const found = await findCompanyByName(admin, wantedName);
    if (found.error) return { error: found.error };
    if (found.company) {
      company = found.company;
      locations = company.locations?.nodes || null;
      const contact = customerId
        ? await assignCustomerAsContact(admin, company.id, customerId)
        : await createCompanyContact(admin, company.id, entry, email);
      if (contact.error) {
        return { error: `adding ${email} as a contact of company "${company.name}" failed: ${contact.error}` };
      }
      contactId = contact.companyContactId;
      customerId = customerId || contact.customerId;
      created.push("contact");
    }
  }

  // 3. No such company anywhere — create it, with its location and (when the
  //    customer doesn't exist yet) its contact in the same call.
  if (!company) {
    const made = await createCompanyWithLocation(admin, entry, customerId ? null : email);
    if (made.error) return { error: `companyCreate for "${wantedName}" failed: ${made.error}` };
    created.push("company", "location", "contact");
    // companyCreate only takes contact DETAILS, not an existing customer id, so
    // an existing customer is attached afterwards. A brand-new one was created by
    // companyCreate itself from the details passed above.
    if (customerId) {
      const assigned = await assignCustomerAsContact(admin, made.companyId, customerId);
      if (assigned.error) {
        return { error: `assigning ${email} as a contact of new company "${wantedName}" failed: ${assigned.error}` };
      }
      contactId = assigned.companyContactId;
    } else {
      contactId = made.companyContactId;
      customerId = made.customerId;
    }
    console.log(
      `[order-sync] created company "${wantedName}" (${made.companyId}) with location ${made.locationId} for ${email}.`,
    );
    const role = await ensureContactRole(admin, made.companyId, contactId, made.locationId);
    if (role.error) return { error: role.error };
    if (role.assigned) created.push("role");
    return {
      companyId: made.companyId,
      companyName: wantedName,
      companyLocationId: made.locationId,
      locationName: made.locationName,
      customerId,
      companyContactId: contactId,
      created,
    };
  }

  // The company was already there; find or add the location named after it.
  if (!locations) locations = await fetchCompanyLocations(admin, company.id);
  let location = locations.find((l) => companyNameKey(l.name) === wantedKey) || null;
  if (!location) {
    const made = await createCompanyLocation(admin, company.id, entry);
    if (made.error) {
      return { error: `companyLocationCreate on company "${company.name}" failed: ${made.error}` };
    }
    location = made;
    created.push("location");
    console.log(
      `[order-sync] created company location "${made.name}" (${made.id}) on company "${company.name}".`,
    );
  }

  const role = await ensureContactRole(admin, company.id, contactId, location.id);
  if (role.error) return { error: role.error };
  if (role.assigned) created.push("role");

  return {
    companyId: company.id,
    companyName: company.name,
    companyLocationId: location.id,
    locationName: location.name,
    customerId,
    companyContactId: contactId,
    created,
  };
}

// Gives the contact a role at the location when it doesn't have one. Shopify
// rejects a company order from a contact with no role there, so this is part of
// the chain rather than a nicety. Already-assigned is the normal case and costs
// one read.
async function ensureContactRole(admin, companyId, companyContactId, companyLocationId) {
  if (!companyContactId) {
    return { error: `no company contact to give a role at location ${companyLocationId}` };
  }
  const resp = await admin.graphql(
    `#graphql
    query CompanyContactRoles($companyId: ID!, $companyContactId: ID!) {
      company(id: $companyId) {
        contactRoles(first: 10) { nodes { id name } }
      }
      companyContact(id: $companyContactId) {
        roleAssignments(first: 250) {
          nodes { id companyLocation { id } role { id name } }
          pageInfo { hasNextPage }
        }
      }
    }`,
    { variables: { companyId, companyContactId } },
  );
  const body = await resp.json();
  if (body?.errors?.length) throw new Error(gqlError(body));
  const roleAssignments = body?.data?.companyContact?.roleAssignments;
  const assignments = roleAssignments?.nodes || [];
  const existing = assignments.find((a) => a?.companyLocation?.id === companyLocationId);
  if (existing) return { assigned: false, role: existing.role?.name || null };
  // An existing assignment past the first page would look missing here and be
  // assigned again, which Shopify rejects — and that would block the order. A
  // contact with 250+ locations is not a shape this account has, so it's reported
  // rather than paged.
  if (roleAssignments?.pageInfo?.hasNextPage) {
    console.warn(
      `[order-sync] contact ${companyContactId} has more than 250 role assignments — the check for an existing role at ${companyLocationId} used a partial list.`,
    );
  }

  // Ordering is the whole point of the assignment, so the ordering role is
  // preferred over the admin one when the shop has both; a shop that has renamed
  // its roles still gets the first one rather than no role at all.
  const roles = body?.data?.company?.contactRoles?.nodes || [];
  const role = roles.find((r) => /ordering/i.test(r.name)) || roles.find((r) => /admin/i.test(r.name)) || roles[0];
  if (!role?.id) return { error: `company ${companyId} has no contact roles to assign` };

  const assignResp = await admin.graphql(
    `#graphql
    mutation CompanyContactAssignRole($companyContactId: ID!, $companyContactRoleId: ID!, $companyLocationId: ID!) {
      companyContactAssignRole(companyContactId: $companyContactId, companyContactRoleId: $companyContactRoleId, companyLocationId: $companyLocationId) {
        companyContactRoleAssignment { id role { name } }
        userErrors { field message }
      }
    }`,
    { variables: { companyContactId, companyContactRoleId: role.id, companyLocationId } },
  );
  const assignBody = await assignResp.json();
  const payload = assignBody?.data?.companyContactAssignRole;
  const errors = payload?.userErrors || [];
  if (errors.length || !payload?.companyContactRoleAssignment?.id) {
    return { error: `assigning the "${role.name}" role at location ${companyLocationId} failed: ${gqlError(assignBody, errors)}` };
  }
  console.log(`[order-sync] assigned role "${role.name}" to contact ${companyContactId} at location ${companyLocationId}.`);
  return { assigned: true, role: role.name };
}

// Creates the contact (and its customer) on a company that already exists.
// Returns { companyContactId, customerId } or { error }.
async function createCompanyContact(admin, companyId, entry, email) {
  const resp = await admin.graphql(
    `#graphql
    mutation CompanyContactCreate($companyId: ID!, $input: CompanyContactInput!) {
      companyContactCreate(companyId: $companyId, input: $input) {
        companyContact { id customer { id } }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        companyId,
        input: {
          email,
          ...(entry.customer?.firstName ? { firstName: entry.customer.firstName } : {}),
          ...(entry.customer?.lastName ? { lastName: entry.customer.lastName } : {}),
        },
      },
    },
  );
  const body = await resp.json();
  const payload = body?.data?.companyContactCreate;
  const errors = payload?.userErrors || [];
  if (errors.length || !payload?.companyContact?.id) return { error: gqlError(body, errors) };
  return {
    companyContactId: payload.companyContact.id,
    customerId: payload.companyContact.customer?.id || null,
  };
}

// Finds the shop's company of this exact name. Search is only used to narrow the
// list — the decision is an exact name match on the results, because Shopify's
// search is fuzzy enough to return neighbours ("Amentum - Intel" for "Amentum -
// PAE") and those are different companies. Returns { company } (null when there
// is none) or { error }.
//
// A name Shopify's search can't be asked about cleanly (embedded quotes) is
// dropped from the term rather than escaped, so the worst case is a miss —
// which creates a company instead of reusing one.
async function findCompanyByName(admin, name) {
  const term = String(name).replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
  if (!term) return { company: null };
  const resp = await admin.graphql(
    `#graphql
    query CompaniesByName($query: String!) {
      companies(first: 50, query: $query) {
        nodes {
          id
          name
          locations(first: 250) {
            nodes { id name }
            pageInfo { hasNextPage }
          }
        }
      }
    }`,
    { variables: { query: `name:"${term}"` } },
  );
  const body = await resp.json();
  if (body?.errors?.length) throw new Error(gqlError(body));
  const wantedKey = companyNameKey(name);
  const exact = (body?.data?.companies?.nodes || []).filter((c) => companyNameKey(c.name) === wantedKey);
  if (exact.length > 1) {
    return { error: `the shop has ${exact.length} companies named "${name}" — refusing to guess which one the order belongs to` };
  }
  // Only the first page of locations came back with the search. Dropping the
  // list makes the caller re-fetch it properly (paged) rather than match against
  // a truncated one.
  const company = exact[0] || null;
  if (company?.locations?.pageInfo?.hasNextPage) delete company.locations;
  return { company };
}

// Creates the company, its first location (named after the company, so the
// location match downstream is satisfied) and — when `contactEmail` is given,
// i.e. no Shopify customer exists yet — the contact and its customer record.
// Returns { companyId, locationId, locationName } or { error }.
async function createCompanyWithLocation(admin, entry, contactEmail) {
  const input = {
    company: { name: entry.companyName },
    companyLocation: companyLocationInput(entry),
  };
  if (contactEmail) {
    input.companyContact = {
      email: contactEmail,
      ...(entry.customer?.firstName ? { firstName: entry.customer.firstName } : {}),
      ...(entry.customer?.lastName ? { lastName: entry.customer.lastName } : {}),
    };
  }

  const resp = await admin.graphql(
    `#graphql
    mutation CompanyCreate($input: CompanyCreateInput!) {
      companyCreate(input: $input) {
        company {
          id
          name
          mainContact { id customer { id } }
          contacts(first: 5) { nodes { id customer { id defaultEmailAddress { emailAddress } } } }
          locations(first: 5) { nodes { id name } }
        }
        userErrors { field message }
      }
    }`,
    { variables: { input } },
  );
  const body = await resp.json();
  const payload = body?.data?.companyCreate;
  const errors = payload?.userErrors || [];
  const company = payload?.company;
  if (errors.length || !company?.id) return { error: gqlError(body, errors) };

  const wantedKey = companyNameKey(entry.companyName);
  const nodes = company.locations?.nodes || [];
  const location = nodes.find((l) => companyNameKey(l.name) === wantedKey) || nodes[0];
  if (!location?.id) {
    return { error: `company ${company.id} was created without a location` };
  }
  // The contact companyCreate made from the contact details, when it was given
  // any. orderCreate needs its customer id (see buildOrderInput) and the contact
  // needs a role at the location (see ensureContactRole), so it is read back from
  // the contact list as well as mainContact — a company whose new contact didn't
  // become the main one would otherwise stall the chain here.
  const contact = contactEmail
    ? company.mainContact
    || (company.contacts?.nodes || []).find(
      (c) => companyNameKey(c?.customer?.defaultEmailAddress?.emailAddress) === companyNameKey(contactEmail),
    )
    : null;
  return {
    companyId: company.id,
    locationId: location.id,
    locationName: location.name,
    companyContactId: contact?.id || null,
    customerId: contact?.customer?.id || null,
  };
}

async function assignCustomerAsContact(admin, companyId, customerId) {
  const resp = await admin.graphql(
    `#graphql
    mutation CompanyAssignCustomerAsContact($companyId: ID!, $customerId: ID!) {
      companyAssignCustomerAsContact(companyId: $companyId, customerId: $customerId) {
        companyContact { id }
        userErrors { field message }
      }
    }`,
    { variables: { companyId, customerId } },
  );
  const body = await resp.json();
  const payload = body?.data?.companyAssignCustomerAsContact;
  const errors = payload?.userErrors || [];
  if (errors.length || !payload?.companyContact?.id) return { error: gqlError(body, errors) };
  return { companyContactId: payload.companyContact.id };
}

async function fetchCustomerCompanyContacts(admin, email) {
  const resp = await admin.graphql(
    `#graphql
    query CustomerCompanyContacts($identifier: CustomerIdentifierInput!) {
      customerByIdentifier(identifier: $identifier) {
        id
        companyContactProfiles {
          id
          company { id name }
        }
      }
    }`,
    { variables: { identifier: { emailAddress: email } } },
  );
  const body = await resp.json();
  if (body?.errors?.length) throw new Error(gqlError(body));
  return body?.data?.customerByIdentifier || null;
}

const LOCATION_PAGE_SIZE = 250;
const MAX_LOCATION_PAGES = 4;

// Every location on the company, paged. The full list is pulled and matched
// locally rather than searched with `query:` — company names come from a
// free-text NetSuite field ("Amentum Services Inc./KPLSS II", "CPCCO - CENTRAL
// PLATEAU CLEANUP CO") and feeding those into search syntax makes the match
// fuzzy, which here would mean attaching an order to the wrong location.
async function fetchCompanyLocations(admin, companyId) {
  const out = [];
  let after = null;
  for (let page = 0; page < MAX_LOCATION_PAGES; page++) {
    const resp = await admin.graphql(
      `#graphql
      query CompanyLocations($companyId: ID!, $first: Int!, $after: String) {
        company(id: $companyId) {
          locations(first: $first, after: $after) {
            nodes { id name }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { variables: { companyId, first: LOCATION_PAGE_SIZE, after } },
    );
    const body = await resp.json();
    if (body?.errors?.length) throw new Error(gqlError(body));
    const conn = body?.data?.company?.locations;
    if (!conn) break;
    out.push(...(conn.nodes || []));
    if (!conn.pageInfo?.hasNextPage) return out;
    after = conn.pageInfo.endCursor;
  }
  // Hitting the page cap means the match above ran against a partial list, so an
  // existing location can be missed and duplicated. Loud rather than silent.
  console.warn(
    `[order-sync] company ${companyId} has more than ${MAX_LOCATION_PAGES * LOCATION_PAGE_SIZE} locations — location matching used a partial list.`,
  );
  return out;
}

// The CompanyLocationInput for this order's company: named after the NetSuite
// company and seeded with the order's addresses, so the buyer's company account
// isn't left address-less. Shared by companyCreate and companyLocationCreate.
function companyLocationInput(entry) {
  const input = { name: entry.companyName };
  const shippingAddress = toCompanyAddress(entry.shippingAddress, entry.companyName);
  const billingAddress = toCompanyAddress(entry.billingAddress, entry.companyName);
  if (shippingAddress) input.shippingAddress = shippingAddress;
  if (billingAddress) input.billingAddress = billingAddress;
  else if (shippingAddress) input.billingSameAsShipping = true;
  return input;
}

// Adds the location to an existing company. Returns { id, name } or { error }.
async function createCompanyLocation(admin, companyId, entry) {
  const input = companyLocationInput(entry);

  const resp = await admin.graphql(
    `#graphql
    mutation CompanyLocationCreate($companyId: ID!, $input: CompanyLocationInput!) {
      companyLocationCreate(companyId: $companyId, input: $input) {
        companyLocation { id name }
        userErrors { field message }
      }
    }`,
    { variables: { companyId, input } },
  );
  const body = await resp.json();
  const payload = body?.data?.companyLocationCreate;
  const errors = payload?.userErrors || [];
  if (errors.length || !payload?.companyLocation?.id) {
    return { error: gqlError(body, errors) };
  }
  return { id: payload.companyLocation.id, name: payload.companyLocation.name };
}

// MailingAddressInput (what mapAddress produces) -> CompanyAddressInput. The
// two differ: province is `zoneCode` here, and the company/attention line is
// `recipient`. address1 and countryCode are non-null on the stored address, so
// an address missing either is dropped instead of being half-created.
//
// Two fields on the mailing address are deliberately dropped. The phone, because
// company addresses require E.164 while NetSuite stores free-form numbers
// ("(806) 555-1212") — a rejected address would block the order. And the
// first/last name, because they're a best-effort split of the NetSuite customer
// display name (see mapNetsuiteOrder), which on these records is the company
// itself; `recipient` already carries that.
function toCompanyAddress(addr, companyName) {
  if (!addr?.address1 || !addr?.countryCode) return null;
  const out = {
    address1: addr.address1,
    countryCode: addr.countryCode,
    recipient: companyName,
  };
  if (addr.address2) out.address2 = addr.address2;
  if (addr.city) out.city = addr.city;
  if (addr.zip) out.zip = addr.zip;
  if (addr.provinceCode) out.zoneCode = addr.provinceCode;
  return out;
}

// Builds the Shopify OrderCreateOrderInput object from a mapped entry.
// Used by createOrder for the actual mutation and by the export block for
// preview/test JSON files. `company` is the resolved B2B link (see
// resolveCompanyLocationId) and is absent for non-company orders and in the
// export preview, which runs before an admin client exists.
//
// The same is true of `variantIds` (skuKey -> variant gid, see
// resolveVariantsBySku): without it every line is a custom line item, which is
// what this sync produced before variants were matched at all.
function buildOrderInput(entry, currencyCode, company, variantIds) {
  // Resolved once and handed to buildTransactions below: read separately, the two
  // could disagree — a mapped status of null became PAID here while
  // buildTransactions saw "not PAID" and attached no payment, leaving exactly the
  // paid-but-no-payment-record order the transaction exists to prevent.
  //
  // PENDING, not PAID, when the mapping produced nothing: mapFinancialStatus
  // deliberately treats an unrecognised NetSuite status as PENDING rather than
  // claim money was collected, and this fallback used to contradict it.
  const financialStatus = entry.financialStatus || "PENDING";
  const order = {
    currency: currencyCode,
    name: orderName(entry),
    poNumber: entry.reference || entry.externalId,
    financialStatus,
    customAttributes: buildCustomAttributes(entry),
    tags: buildTags(entry),
    // A line linked to a real variant sends only the variant and the price:
    // Shopify takes the title, image and SKU from the product itself, and
    // NetSuite's price still wins over the variant's. An unlinked line carries the
    // NetSuite item name as both title and sku, so the code is on the order line
    // as a SKU and not only inside its title.
    lineItems: (entry.lineItems || []).map((li) => {
      const line = {
        quantity: li.quantity ?? 1,
        priceSet: {
          shopMoney: { amount: String(li.price ?? "0"), currencyCode },
        },
      };
      const variantId = variantIds?.get(skuKey(li.title));
      if (variantId) line.variantId = variantId;
      else Object.assign(line, { title: li.title, sku: li.title });
      return line;
    }),
  };
  // NetSuite's fulfillment state has to be set at create time: orderCreate
  // defaults the order to unfulfilled, and the sync never touches an order's
  // fulfillment state afterwards. FULFILLED/PARTIAL are sent; "unfulfilled"
  // has no enum member, so createFulfillmentStatus returns null and the field
  // is left off (which is what gives an unfulfilled order).
  const fulfillmentStatus = createFulfillmentStatus(entry.fulfillmentStatus);
  if (fulfillmentStatus) order.fulfillmentStatus = fulfillmentStatus;
  if (entry.note) order.note = entry.note;
  if (entry.shippingAddress) order.shippingAddress = entry.shippingAddress;
  if (entry.billingAddress) order.billingAddress = entry.billingAddress;
  if (entry.shippingCost > 0) {
    order.shippingLines = [{
      title: entry.shipMethod || "Shipping",
      priceSet: { shopMoney: { amount: String(entry.shippingCost), currencyCode } },
    }];
  }
  if (entry.taxTotal > 0) {
    const subtotal = (entry.lineItems || []).reduce(
      (sum, li) => sum + Number(li.price ?? 0) * Number(li.quantity ?? 1),
      0,
    );
    const rate = subtotal > 0 ? entry.taxTotal / subtotal : 0;
    order.taxLines = [{
      title: "Tax",
      rate: Number(rate.toFixed(6)),
      priceSet: { shopMoney: { amount: String(entry.taxTotal), currencyCode } },
    }];
  }
  const c = entry.customer;
  if (c?.email) {
    order.customer = {
      toUpsert: {
        email: c.email,
        ...(c.firstName ? { firstName: c.firstName } : {}),
        ...(c.lastName ? { lastName: c.lastName } : {}),
        // A B2B order is rejected outright ("no customer_id was provided") unless
        // the customer is identified by id — an email to upsert isn't enough,
        // because the customer has to be the company's contact. It's the same
        // customer either way: the id came from looking this email up.
        ...(company?.customerId ? { id: company.customerId } : {}),
      },
    };
  }
  // Attaches the order to the buyer's company location, which is what makes it a
  // B2B order in Shopify.
  if (company?.companyLocationId) order.companyLocationId = company.companyLocationId;
  // Last — the transaction amount is derived from the money set above.
  const transactions = buildTransactions(order, financialStatus, entry, currencyCode);
  if (transactions) order.transactions = transactions;
  return order;
}

// The payment record for the order. PAID means every invoice linked to the sales
// order is Paid In Full (see mapFinancialStatus) — the one state where the money
// is known to have arrived, so the one state that gets a transaction.
// PARTIALLY_PAID deliberately gets none: entry.invoices carries each invoice's
// status but not its amount, and inventing an amount would invent a payment.
//
// Without a transaction an order created as PAID has no payment behind it, which
// leaves it out of payment/payout reporting and blocks refunds. Set
// SYNC_ORDER_TRANSACTIONS=false to go back to the status-only behaviour.
function buildTransactions(order, financialStatus, entry, currencyCode) {
  if (process.env.SYNC_ORDER_TRANSACTIONS === "false") return null;
  if (financialStatus !== "PAID") return null;
  const amount = orderInputTotal(order);
  if (!(amount > 0)) return null;
  const tx = {
    kind: "SALE",
    status: "SUCCESS",
    // "manual" is Shopify's own gateway for money taken outside a payment
    // provider, which is what a NetSuite invoice is.
    gateway: process.env.NETSUITE_PAYMENT_GATEWAY || "manual",
    amountSet: { shopMoney: { amount: amount.toFixed(2), currencyCode } },
  };
  // The order date, so a backfilled order isn't recorded as paid today.
  const processedAt = isoDateTime(entry.tranDate);
  if (processedAt) tx.processedAt = processedAt;
  return [tx];
}

// The total Shopify will compute for this order input (line items + shipping +
// tax). Summed in cents: a float sum can land a cent off, which would leave a
// "paid" order showing an outstanding balance.
function orderInputTotal(order) {
  const cents = (v) => Math.round(Number(v || 0) * 100);
  let total = 0;
  for (const li of order.lineItems || []) {
    total += cents(li.priceSet?.shopMoney?.amount) * Number(li.quantity ?? 1);
  }
  for (const sl of order.shippingLines || []) total += cents(sl.priceSet?.shopMoney?.amount);
  for (const tl of order.taxLines || []) total += cents(tl.priceSet?.shopMoney?.amount);
  return total / 100;
}

// NetSuite sends date-only strings ("2025-12-31"); Shopify's DateTime wants a
// full ISO 8601 timestamp.
function isoDateTime(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function createOrder(admin, entry, currencyCode, caches) {
  // A create needs an email, and it is worth failing over rather than working
  // around. Shopify will happily accept an order with no customer at all, but
  // that order belongs to nobody: the buyer can't see it in their account, and
  // nothing afterwards can attach it to one. On a company order it is fatal
  // anyway (see lookupCompanyLocation) — this check only makes the same
  // requirement explicit for an order with no company name, which would
  // otherwise be created silently and look like a success in the log.
  //
  // Two sources have already been tried by this point: the sales order's own
  // Email field and, when that is blank, the customer record's
  // (linkedCustomerEmail — see fetchCustomerEmails in netsuite.server.js). So
  // reaching here means NetSuite holds no address for this buyer anywhere, and
  // the fix is in NetSuite, not here. The message says exactly that, because
  // "no customer email" alone reads like a bug in the sync.
  //
  // Only creates are affected. An order already in Shopify takes the
  // tracking-only update path and never comes through here.
  if (!entry.customer?.email) {
    return {
      ok: false,
      action: "create",
      error: "no customer email: the NetSuite order's Email field is blank and so is its customer record — an order cannot be created without one",
    };
  }

  // An order naming a company is a B2B order and MUST carry its company
  // location, so an unresolvable company blocks the create instead of quietly
  // producing an order the buyer's company can't see. The company, its contact
  // and its location are all created when missing, so "unresolvable" means the
  // NetSuite data or the shop is ambiguous, not merely that this is the
  // company's first order. Orders with no company name skip this entirely and
  // are created exactly as before.
  let link = null;
  if (entry.companyName) {
    link = await resolveCompanyLocationId(admin, entry, caches.company);
    if (!link.companyLocationId) {
      return {
        ok: false,
        action: "create",
        error: `company "${entry.companyName}": ${link.error}`,
      };
    }
  }

  // Which of this order's items exist in Shopify. Looked up before the create so
  // the lines can be linked to their variants; a miss is not an error (see
  // resolveVariantsBySku).
  const variantIds = await resolveVariantsBySku(
    admin,
    (entry.lineItems || []).map((li) => li.title),
    caches.variant,
  );

  const order = buildOrderInput(entry, currencyCode, link, variantIds);
  if (entry.currency && entry.currency !== currencyCode) {
    console.warn(
      `[order-sync] ${entry.externalId}: NetSuite currency ${entry.currency} != shop ${currencyCode}; amounts created as ${currencyCode}.`,
    );
  }

  // Shopify only emails the customer on order create (update/delete don't
  // trigger notifications) — always suppressed, unconditionally, so synced
  // NetSuite orders never email a real customer.
  //
  // BYPASS is also the default, but it is stated because it matters now that
  // lines carry real variants: these orders were already fulfilled and billed in
  // NetSuite, and claiming their stock again in Shopify would double-count every
  // unit. It also keeps a re-synced order from drawing the same stock twice.
  const options = {
    sendReceipt: false,
    sendFulfillmentReceipt: false,
    inventoryBehaviour: "BYPASS",
  };

  const resp = await admin.graphql(
    `#graphql
    mutation OrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
      orderCreate(order: $order, options: $options) {
        order {
          id
          name
          poNumber
          displayFinancialStatus
          displayFulfillmentStatus
          shippingAddress { address1 city provinceCode zip countryCodeV2 }
          billingAddress { address1 city provinceCode zip countryCodeV2 }
          totalShippingPriceSet { shopMoney { amount currencyCode } }
          totalTaxSet { shopMoney { amount currencyCode } }
          totalPriceSet { shopMoney { amount currencyCode } }
          customer { id firstName lastName defaultEmailAddress { emailAddress } }
          purchasingEntity {
            ... on PurchasingCompany {
              company { id name }
              location { id name }
            }
          }
          transactions { id kind status amountSet { shopMoney { amount currencyCode } } }
        }
        userErrors { field message }
      }
    }`,
    { variables: { order, options } },
  );
  const body = await resp.json();
  const payload = body?.data?.orderCreate;
  const errors = payload?.userErrors || [];
  if (errors.length || !payload?.order) {
    return { ok: false, action: "create", error: gqlError(body, errors) };
  }
  const o = payload.order;
  const purchasing = o.purchasingEntity;
  // How many lines found their product and how many stayed as text, so an item
  // that isn't in Shopify is visible in the log instead of only in the order.
  const linked = order.lineItems.filter((li) => li.variantId).length;
  return {
    ok: true,
    action: "create",
    lines: `${order.lineItems.length} line(s): ${linked} linked to a variant, ${order.lineItems.length - linked} custom`,
    id: o.id,
    name: o.name,
    poNumber: o.poNumber,
    financialStatus: o.displayFinancialStatus,
    fulfillmentStatus: o.displayFulfillmentStatus,
    customer: o.customer?.defaultEmailAddress?.emailAddress || null,
    shipping: o.totalShippingPriceSet?.shopMoney?.amount || null,
    tax: o.totalTaxSet?.shopMoney?.amount || null,
    total: o.totalPriceSet?.shopMoney?.amount || null,
    shippedTo: o.shippingAddress?.city || null,
    ...(entry.companyName
      ? {
        netsuiteCompany: entry.companyName,
        company: purchasing?.company?.name || null,
        companyLocation: purchasing?.location?.name || null,
        companyLocationId: purchasing?.location?.id || null,
        // What the B2B chain had to create for this order, if anything.
        ...(link?.created?.length ? { companyCreated: link.created.join(", ") } : {}),
      }
      : {}),
    transactions: (o.transactions || []).map(
      (t) => `${t.kind}/${t.status} ${t.amountSet?.shopMoney?.amount || "?"}`,
    ),
  };
}

// ---------------------------------------------------------------------------
// Fulfillment + tracking update for an already-matched order
// ---------------------------------------------------------------------------
// The only things an existing Shopify order ever receives from this sync: its
// tracking numbers, and a fulfillment when NetSuite has shipped the goods but
// Shopify still shows the order unfulfilled. No poNumber, address, note, tag,
// line-item or money field is touched.
//
// The financial status is deliberately absent from that list because it CANNOT
// be corrected after the fact — Shopify only accepts financialStatus at create
// time ("Can only be set when the order is created"). An order created with the
// wrong financial status has to be deleted and re-created to fix it.
//
// Where the numbers land, in order of preference:
//   1. an existing (non-cancelled) fulfillment  -> fulfillmentTrackingInfoUpdate
//   2. an open fulfillment order                -> fulfillmentCreate
//   3. neither (nothing shipped/shippable yet)  -> netsuite_tracking custom
//      attribute, merged into the order's existing attributes
// (3) is also the fallback when the fulfillment write is rejected, e.g. because
// the app hasn't been granted the *_fulfillment_orders scopes yet.
async function syncTracking(admin, entry, orderId, via) {
  const base = { action: "tracking", id: orderId, matchedBy: via, netsuiteId: entry.externalId };
  const numbers = trackingNumbers(entry.tracking);

  // An order can need work with no tracking at all: NetSuite reports it as
  // shipped while Shopify still shows it unfulfilled. That is the common case
  // here, not an edge case — this account records tracking numbers on only
  // 1442 of its 25815 fulfillments. Bail out only when there is neither
  // tracking to write nor a fulfillment state to correct.
  const shipped = entry.fulfillmentStatus === "FULFILLED"
    || entry.fulfillmentStatus === "PARTIALLY_FULFILLED";
  if (!numbers.length && !shipped) {
    return { ...base, ok: true, skipped: true, reason: "no tracking numbers, and nothing shipped in NetSuite" };
  }

  const ctx = await fetchTrackingContext(admin, orderId);
  if (!ctx) return { ...base, ok: false, error: "order disappeared between match and update" };

  const fulfillments = (ctx.fulfillments || []).filter((f) => f.status !== "CANCELLED");
  try {
    if (fulfillments.length) {
      // Already fulfilled in Shopify and NetSuite has no numbers to add.
      if (!numbers.length) {
        return { ...base, ok: true, skipped: true, name: ctx.name, reason: "already fulfilled in Shopify; no tracking numbers in NetSuite" };
      }
      const updated = [];
      const buckets = distribute(numbers, fulfillments.length);
      for (let i = 0; i < fulfillments.length; i++) {
        const f = fulfillments[i];
        if (!buckets[i].length) continue;
        if (sameTracking(f.trackingInfo, buckets[i])) continue;
        updated.push(await updateFulfillmentTracking(admin, f.id, buckets[i]));
      }
      if (!updated.length) {
        return { ...base, ok: true, skipped: true, name: ctx.name, tracking: numbers.join(", "), reason: "tracking already up to date" };
      }
      return { ...base, ok: true, name: ctx.name, via: "fulfillmentTrackingInfoUpdate", fulfillments: updated, tracking: numbers.join(", ") };
    }

    // Creating a fulfillment is the only way tracking can reach an order that
    // Shopify still considers unfulfilled — but unlike a tracking update it is a
    // real state change (items become fulfilled, stock is drawn from the
    // location). SYNC_FULFILLMENT_CREATE=false restricts the sync to orders
    // Shopify has already fulfilled, and everything else falls through to the
    // netsuite_tracking attribute.
    const groups = process.env.SYNC_FULFILLMENT_CREATE === "false"
      ? []
      : openFulfillmentOrderGroups(ctx.fulfillmentOrders?.nodes || []);
    if (groups.length) {
      const created = [];
      const buckets = distribute(numbers, groups.length);
      for (let i = 0; i < groups.length; i++) {
        created.push(await createFulfillmentWithTracking(admin, groups[i], buckets[i]));
      }
      return {
        ...base,
        ok: true,
        name: ctx.name,
        via: "fulfillmentCreate",
        fulfillments: created,
        tracking: numbers.join(", ") || null,
        // Says why the fulfillment was created when there was no tracking to
        // carry: NetSuite had shipped it and Shopify had not caught up.
        ...(numbers.length ? {} : { reason: `NetSuite reports ${entry.fulfillmentStatus}; fulfilled in Shopify without tracking` }),
      };
    }

    // Nothing shipped in Shopify, no open fulfillment order to fulfil, and no
    // tracking to fall back on writing.
    if (!numbers.length) {
      return { ...base, ok: true, skipped: true, name: ctx.name, reason: "no open fulfillment order to fulfil, and no tracking numbers" };
    }
  } catch (err) {
    const message = err?.message || String(err);
    // With no tracking numbers there is nothing to fall back to writing — the
    // fulfillment itself was the whole point, so report the failure instead of
    // silently stamping an empty attribute.
    if (!numbers.length) {
      return { ...base, ok: false, name: ctx.name, error: `could not fulfil order (NetSuite reports ${entry.fulfillmentStatus}): ${message}` };
    }
    console.warn(`[order-sync] ${entry.externalId}: fulfillment tracking write failed (${message}); falling back to the netsuite_tracking attribute.`);
    const attr = await writeTrackingAttribute(admin, orderId, ctx.customAttributes, numbers.join(", "));
    return { ...attr, ...base, ok: attr.ok, name: ctx.name, via: "customAttribute", tracking: numbers.join(", "), warning: message };
  }

  const attr = await writeTrackingAttribute(admin, orderId, ctx.customAttributes, numbers.join(", "));
  return {
    ...attr,
    ...base,
    ok: attr.ok,
    name: ctx.name,
    via: "customAttribute",
    tracking: numbers.join(", "),
    reason: "no fulfillment or open fulfillment order on the Shopify order",
  };
}

// Splits the NetSuite tracking numbers across N targets: one number per target
// in order, with any surplus piled onto the last one. With a single target
// (the common case) every number lands on it.
function distribute(numbers, count) {
  const buckets = Array.from({ length: count }, () => []);
  numbers.forEach((n, i) => buckets[Math.min(i, count - 1)].push(n));
  return buckets;
}

function trackingNumbers(tracking) {
  if (!tracking) return [];
  return [...new Set(String(tracking).split(/[,\s]+/).map((s) => s.trim()).filter(Boolean))];
}

function sameTracking(existing, wanted) {
  const have = new Set((existing || []).map((t) => t?.number).filter(Boolean));
  return wanted.length === have.size && wanted.every((n) => have.has(n));
}

async function fetchTrackingContext(admin, orderId) {
  const resp = await admin.graphql(
    `#graphql
    query OrderTrackingContext($id: ID!) {
      order(id: $id) {
        id
        name
        customAttributes { key value }
        fulfillments(first: 20) { id status trackingInfo { company number url } }
        fulfillmentOrders(first: 20) {
          nodes {
            id
            status
            lineItems(first: 100) { nodes { id remainingQuantity } }
          }
        }
      }
    }`,
    { variables: { id: orderId } },
  );
  const body = await resp.json();
  if (body?.errors?.length) throw new Error(gqlError(body, []));
  return body?.data?.order || null;
}

// Open fulfillment orders with something left to ship, one group per
// fulfillment order.
//
// fulfillmentCreate can only span fulfillment orders that share a location, so
// this used to group by assignedLocation.location.id — but reading that field
// needs the read_locations scope, which this app is not granted:
// "Access denied for location field. Required access: `read_locations` access
// scope, `read_inventory` access scope or `read_markets_home` access scope."
// One fulfillment order per group satisfies the same-location rule trivially
// and needs no extra scope. The only cost is that an order split across several
// fulfillment orders at one location produces one fulfillment each rather than
// a single combined one.
function openFulfillmentOrderGroups(nodes) {
  const groups = [];
  for (const fo of nodes) {
    if (!["OPEN", "IN_PROGRESS", "SCHEDULED"].includes(fo.status)) continue;
    const lineItems = (fo.lineItems?.nodes || [])
      .filter((li) => (li.remainingQuantity ?? 0) > 0)
      .map((li) => ({ id: li.id, quantity: li.remainingQuantity }));
    if (!lineItems.length) continue;
    groups.push([{ fulfillmentOrderId: fo.id, fulfillmentOrderLineItems: lineItems }]);
  }
  return groups;
}

async function updateFulfillmentTracking(admin, fulfillmentId, numbers) {
  const resp = await admin.graphql(
    `#graphql
    mutation FulfillmentTrackingUpdate($fulfillmentId: ID!, $trackingInfoInput: FulfillmentTrackingInput!, $notifyCustomer: Boolean) {
      fulfillmentTrackingInfoUpdate(fulfillmentId: $fulfillmentId, trackingInfoInput: $trackingInfoInput, notifyCustomer: $notifyCustomer) {
        fulfillment { id status trackingInfo { company number url } }
        userErrors { field message }
      }
    }`,
    { variables: { fulfillmentId, trackingInfoInput: trackingInput(numbers), notifyCustomer: false } },
  );
  const body = await resp.json();
  const payload = body?.data?.fulfillmentTrackingInfoUpdate;
  const errors = payload?.userErrors || [];
  if (errors.length || !payload?.fulfillment) throw new Error(gqlError(body, errors));
  return { id: payload.fulfillment.id, numbers };
}

async function createFulfillmentWithTracking(admin, lineItemsByFulfillmentOrder, numbers) {
  const resp = await admin.graphql(
    `#graphql
    mutation FulfillmentCreate($fulfillment: FulfillmentInput!) {
      fulfillmentCreate(fulfillment: $fulfillment) {
        fulfillment { id status trackingInfo { company number url } }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        fulfillment: {
          lineItemsByFulfillmentOrder,
          ...(trackingInput(numbers) ? { trackingInfo: trackingInput(numbers) } : {}),
          notifyCustomer: false,
        },
      },
    },
  );
  const body = await resp.json();
  const payload = body?.data?.fulfillmentCreate;
  const errors = payload?.userErrors || [];
  if (errors.length || !payload?.fulfillment) throw new Error(gqlError(body, errors));
  return { id: payload.fulfillment.id, numbers, created: true };
}

// No `company` is sent: NetSuite's shipMethod ("UPS Ground 3rd Party") is not a
// carrier name Shopify recognises, and an unrecognised company suppresses the
// auto-generated tracking URL. Shopify infers the carrier from the number.
// null when there is nothing to send, so fulfillmentCreate is not handed an
// empty trackingInfo when the fulfillment exists only to correct the state.
function trackingInput(numbers) {
  if (!numbers.length) return null;
  return numbers.length === 1 ? { number: numbers[0] } : { numbers };
}

// Fallback path: park the numbers on the order's netsuite_tracking custom
// attribute. orderUpdate replaces the whole attribute set, so the existing
// attributes are read back and re-sent with only that one key changed.
async function writeTrackingAttribute(admin, orderId, existing, value) {
  const customAttributes = (existing || [])
    .filter((a) => a.key !== "netsuite_tracking")
    .map((a) => ({ key: a.key, value: a.value }));
  customAttributes.push({ key: "netsuite_tracking", value });

  const resp = await admin.graphql(
    `#graphql
    mutation OrderUpdate($input: OrderInput!) {
      orderUpdate(input: $input) {
        order { id name }
        userErrors { field message }
      }
    }`,
    { variables: { input: { id: orderId, customAttributes } } },
  );
  const body = await resp.json();
  const payload = body?.data?.orderUpdate;
  const errors = payload?.userErrors || [];
  if (errors.length || !payload?.order) {
    return { ok: false, error: gqlError(body, errors) };
  }
  return { ok: true };
}

async function deleteOrder(admin, entry) {
  // Only orders this sync created are deletable. Same pairing as
  // resolveShopifyOrder: store marker + otherRefNum means the order belongs to
  // the merchant, and cancelling it in NetSuite must never wipe the original
  // Shopify order. Anything else is matched on our own ext:<netsuiteId> tag
  // below, so an order we did not create is never reached.
  if (entry.isCeligoOrder && entry.otherRefNum) {
    return {
      ok: true,
      action: "delete",
      skipped: true,
      reason: `Celigo order (store ${entry.celigoStoreName || entry.celigoStoreId}) — Shopify order not deleted`,
    };
  }
  const id = await findOrderIdByExternalId(admin, entry.externalId);
  if (!id) {
    return { ok: true, action: "delete", skipped: true, reason: "order not found (already deleted?)" };
  }

  const resp = await admin.graphql(
    `#graphql
    mutation OrderDelete($orderId: ID!) {
      orderDelete(orderId: $orderId) {
        deletedId
        userErrors { field message }
      }
    }`,
    { variables: { orderId: id } },
  );
  const body = await resp.json();
  const payload = body?.data?.orderDelete;
  const errors = payload?.userErrors || [];
  if (errors.length || !payload?.deletedId) {
    return { ok: false, action: "delete", error: gqlError(body, errors) };
  }
  return { ok: true, action: "delete", deletedId: payload.deletedId };
}

// The custom-attribute set written on every create/update. netsuite_currency
// is recorded because the order money is created in the SHOP currency (see the
// note in createOrder); netsuite_tracking surfaces the tracking number(s) on
// the order without changing its fulfillment state.
function buildCustomAttributes(entry) {
  const pairs = [
    ["netsuite_id", entry.externalId],
    ["netsuite_ref", entry.reference],
    ["netsuite_currency", entry.currency],
    ["netsuite_tracking", entry.tracking],
    ["netsuite_status", entry.statusName],
    ["netsuite_order_status", entry.orderStatus],
    ["netsuite_financial_status", entry.financialStatus],
    ["netsuite_fulfillment_status", entry.fulfillmentStatus],
    ["netsuite_po", entry.otherRefNum],
    ["netsuite_company", entry.companyName],
    ["netsuite_terms", entry.terms],
    ["netsuite_sales_rep", entry.salesRep],
    ["netsuite_department", entry.department],
    ["netsuite_subsidiary", entry.subsidiary],
    ["netsuite_location", entry.location],
    ["netsuite_order_date", entry.tranDate],
    ["netsuite_created_date", entry.createdDate],
    ["netsuite_modified_date", entry.lastModifiedDate],
    ["netsuite_ship_date", entry.shipDate],
    ["netsuite_ship_complete", entry.shipComplete != null ? String(entry.shipComplete) : null],
    ["netsuite_subtotal", entry.subtotal != null ? String(entry.subtotal) : null],
    ["netsuite_total", entry.total != null ? String(entry.total) : null],
    ["netsuite_discount", entry.discountTotal != null ? String(entry.discountTotal) : null],
    ["netsuite_transaction_number", entry.transactionNumber],
    ["netsuite_sales_effective_date", entry.salesEffectiveDate],
    ["netsuite_fax", entry.fax],
    ["netsuite_opportunity", entry.opportunity],
    ["netsuite_gross_profit", entry.estGrossProfit != null ? String(entry.estGrossProfit) : null],
    ["netsuite_gross_profit_pct", entry.estGrossProfitPercent != null ? String(entry.estGrossProfitPercent) : null],
    ["netsuite_cost_estimate", entry.totalCostEstimate != null ? String(entry.totalCostEstimate) : null],
    ["netsuite_exchange_rate", entry.exchangeRate != null ? String(entry.exchangeRate) : null],
    ["netsuite_residential", entry.shipIsResidential != null ? String(entry.shipIsResidential) : null],
    ["netsuite_multi_ship", entry.isMultiShipTo != null ? String(entry.isMultiShipTo) : null],
    ["netsuite_custom_form", entry.customForm],
  ];
  return pairs
    .filter(([, v]) => v != null && v !== "")
    .map(([key, value]) => ({ key, value: String(value) }));
}

// The tag set written on every create/update: the ext link (for re-finding the
// order), the NetSuite reference (SO number), and the current status.
function buildTags(entry) {
  return [
    extTag(entry.externalId),
    ...(entry.reference ? [`ref:${entry.reference}`] : []),
    ...(entry.status ? [`status:${entry.status}`] : []),
    ...(entry.statusName ? [`ns:${entry.statusName}`] : []),
    ...(entry.otherRefNum ? [`po:${entry.otherRefNum}`] : []),
  ];
}

// Surfaces either GraphQL top-level errors (e.g. access denied) or userErrors.
function gqlError(body, userErrors) {
  if (body?.errors?.length) {
    return body.errors.map((e) => e.message).join("; ");
  }
  if (userErrors?.length) {
    return userErrors.map((e) => `${(e.field || []).join(".")} ${e.message}`.trim()).join("; ");
  }
  return "unknown GraphQL error";
}
