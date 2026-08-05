import { INVOICE_PAID_IN_FULL } from "../netsuite/client.server.js";

const DELETE_STATUSES = new Set(["C"]);

// Maps a raw NetSuite salesOrder record into the internal order shape the sync
// logic uses. NetSuite's `entity.refName` is a single display name; we split it
// into first/last on the first space (best-effort — NetSuite has no split name
// on the transaction record itself).
export function mapNetsuiteOrder(rec) {
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
    tracking: cleanTracking(rec?.linkedTrackingNumbers?.numbers),
    // Ship date/status/weight only exist for a fulfillment that also carries a
    // tracking number (see fetchTrackingForOrders) — null otherwise, same as
    // `tracking` above.
    trackingShipDate: rec?.linkedTrackingNumbers?.shipDate || null,
    trackingStatus: rec?.linkedTrackingNumbers?.status || null,
    trackingPackageWeight: rec?.linkedTrackingNumbers?.packageWeight ?? null,
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
export function mapFinancialStatus(nsStatusId, invoices) {
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
export function createFulfillmentStatus(status) {
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
export function currencyCode(ref) {
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
export function companyNameKey(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

// Comparison key for a SKU. NetSuite item names arrive with the casing and inner
// spacing a human typed ("TPU for AMS", "TPU FOR AMS GRAY 53102"), and a Shopify
// SKU is not guaranteed to match either, so both sides are normalised before
// they're compared.
export function skuKey(v) {
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
export function code(v, min, max) {
  const s = String(v ?? "").trim().toUpperCase();
  return new RegExp(`^[A-Z]{${min},${max}}$`).test(s) ? s : null;
}

// Maps a NetSuite address sub-record to a Shopify MailingAddressInput, keeping
// only usable fields. Shopify's `country`/`province` are deprecated, so we emit
// `countryCode`/`provinceCode` from NetSuite's reference ids ("US", "CA").
// Returns null when there's nothing usable.
export function mapAddress(addr, customerName) {
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
export const extTag = (externalId) => `ext:${externalId}`;

