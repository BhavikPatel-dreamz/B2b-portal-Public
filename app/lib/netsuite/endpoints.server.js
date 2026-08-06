// ---------------------------------------------------------------------------
// Every NetSuite URL this app calls
// ---------------------------------------------------------------------------
// One file, so that "which NetSuite endpoints does this app touch" is answered by
// reading it rather than by grepping for string concatenation, and so that a
// change to an account's hostname or an API version happens in one place.
//
// Nothing here performs a request — these functions only build URLs. The request
// itself is nsRequest (client.server.js) for the REST APIs and tokenRequest
// (oauth.server.js) for the OAuth ones, both of which take a URL from here.
//
// Split into three layers, in the order a URL is assembled:
//
//   1. the hosts     — which NetSuite account, and which of its three hostnames
//   2. the services  — record / SuiteQL / OAuth, each with its API version
//   3. the paths     — the specific records this app reads
//
// A note before changing anything here: NetSuite serves each account from THREE
// different hostnames, and using the wrong one fails in ways that don't say so.
// `<account>.suitetalk.api.netsuite.com` serves the REST APIs, and
// `<account>.app.netsuite.com` serves the browser-facing login and authorize
// pages. They are not interchangeable — the authorize page on the suitetalk host
// 404s, and a REST call to the app host redirects to a login page whose HTML
// then fails to parse as JSON.

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`NetSuite: missing ${name} env var`);
  return v;
}

// ---------------------------------------------------------------------------
// 1. The hosts
// ---------------------------------------------------------------------------

export function accountId() {
  return required("NETSUITE_ACCOUNT_ID");
}

// The account id in a NetSuite hostname is lowercase with underscores written as
// hyphens: account 5895946_SB1 lives at 5895946-sb1.app.netsuite.com. Copying the
// id straight out of the NetSuite UI gives the underscore form, which resolves to
// no host at all (or, worse, to the wrong account's login page).
export function accountHost() {
  return accountId().trim().toLowerCase().replace(/_/g, "-");
}

// Where the REST APIs live. Taken from NETSUITE_ACCOUNT_URL rather than built
// from the account id, because a sandbox or a custom domain can put them
// somewhere the id alone doesn't predict.
//
// It must point at the SAME account NETSUITE_ACCOUNT_ID names — the REST calls
// use this and the OAuth calls use that, so if the two disagree the app
// authenticates against one account and reads from another. Nothing can check
// that automatically (the id isn't always a substring of the URL), which is
// exactly why both are derived here where the pair is visible together.
export function restBase() {
  return required("NETSUITE_ACCOUNT_URL").replace(/\/$/, "");
}

// The browser-facing host: the login and authorize pages, not the APIs.
export function appBase() {
  return `https://${accountHost()}.app.netsuite.com`;
}

// The API host, built from the account id. Used only for the OAuth token
// endpoint — everything else goes through restBase().
export function suitetalkBase() {
  return `https://${accountHost()}.suitetalk.api.netsuite.com`;
}

// ---------------------------------------------------------------------------
// 2. The services
// ---------------------------------------------------------------------------
// The API version segments, named rather than inlined: a NetSuite account can be
// moved to a newer REST version independently per service, and when that happens
// it should be a one-line change here.
const RECORD_API = "/services/rest/record/v1";
const QUERY_API = "/services/rest/query/v1";
const OAUTH_API = "/services/rest/auth/oauth2/v1";

// A SuiteTalk REST record URL for a record path (e.g. "/salesorder/1504").
export function recordUrl(path) {
  return `${restBase()}${RECORD_API}${path}`;
}

// The SuiteQL endpoint. Paging is the caller's (nsSuiteQl walks offsets until
// hasMore goes false), so limit/offset are parameters rather than fixed.
export function suiteqlUrl({ limit, offset }) {
  return `${restBase()}${QUERY_API}/suiteql?limit=${limit}&offset=${offset}`;
}

// Where the browser is sent to log in and approve the integration. On the app
// host, not the API host — see the note at the top.
export function oauthAuthorizeUrl(params) {
  return `${appBase()}/app/login/oauth2/authorize.nl?${params.toString()}`;
}

// Where the authorization code is exchanged for tokens, and where a refresh
// token is redeemed. On the API host.
export function oauthTokenUrl() {
  return `${suitetalkBase()}${OAUTH_API}/token`;
}

// ---------------------------------------------------------------------------
// 3. The record paths
// ---------------------------------------------------------------------------
// Every NetSuite record this app reads, as the path passed to recordUrl(). Kept
// as functions rather than templates so the one thing that varies — whether
// sublists come back inline — is named instead of repeated.
//
// `expandSubResources` is what makes a record carry its sublists (an order's
// line items, a fulfillment's packages) inline. Without it SuiteTalk returns a
// bare link reference instead, which is how mapNetsuiteOrder once ended up with
// an empty lineItems array on every order.
const EXPANDED = "?expandSubResources=true";

export const recordPath = {
  // One sales order. `expand` for the full record with its line items; without
  // it, just enough to confirm the id resolves.
  salesOrder: (id, { expand = false } = {}) => `/salesorder/${id}${expand ? EXPANDED : ""}`,

  // The sales-order collection, filtered by a `q` expression. Returns ids only
  // (plus hasMore/offset/totalResults) — each id is then expanded through
  // salesOrder() above.
  salesOrderList: ({ limit, offset, q }) => {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (q) params.set("q", q);
    return `/salesorder?${params.toString()}`;
  },

  // Finding an order by its document number rather than its internal id. A
  // handful of matches is plenty: a tranId is unique, and asking for more only
  // makes NetSuite work harder to prove it.
  salesOrderByTranId: (tranId, limit = 5) =>
    `/salesorder?q=${encodeURIComponent(`tranId IS "${tranId}"`)}&limit=${limit}`,

  // How the integration user's account is configured — the only endpoint here
  // that reads a SETTING rather than a record:
  //
  //   { "timeZone": { "id": "America/New_York", "refName": "(GMT-05:00) …" },
  //     "dateFormat": "M/d/YYYY",
  //     "timeFormat": "h:mm a" }
  //
  // Those three answer the question a sales-order filter cannot answer for
  // itself: how a date literal in a `q` expression has to be written, and which
  // zone it will be compared in. See ORDER_DATE_FORMATS.
  //
  // Singular and un-parameterised — it is the preference of whoever the OAuth
  // token belongs to, which is the integration user the sync runs as, which is
  // also who the q filter is parsed on behalf of. That identity is what makes
  // it the right thing to ask.
  userPreference: () => "/preference/userPreference",
};

// ---------------------------------------------------------------------------
// 4. The SuiteQL queries
// ---------------------------------------------------------------------------
// The other half of this app's NetSuite API surface. These reach the account
// through suiteqlUrl() rather than recordUrl(), which is why they are queries
// here and not entries in recordPath above — but they are API calls all the
// same, and they belong in this file for the same reason the URLs do.
//
// Each one is here rather than in a record path because the REST record
// endpoints cannot answer it:
//
//   • invoices — the sales-order -> invoice link is only reachable through
//     transactionline.createdfrom. There is no field on either record that
//     names the other.
//   • tracking — `/itemfulfillment?q=createdFrom IS <id>` is rejected outright
//     ("Unknown field name 'createdFrom'"), so the sales order -> fulfillment
//     link has to be resolved through transactionline.createdfrom. The tracking
//     numbers are not on the REST record either: they live in
//     trackingnumbermap/trackingnumber. Package weight IS on the REST record,
//     but only under a carrier-specific sublist name (packageUps, packageFedex
//     or plain package, one per carrier, each with its own weight field) — the
//     itemfulfillmentpackage table exposes all three uniformly, and in the same
//     batched query rather than one GET per fulfillment.
//   • customer emails — `/customer/<id>` would work, but costs one round trip
//     and a rate-limit pause PER customer. One batched query answers a whole
//     run, and a window normally holds several orders for the same few
//     customers.
//
// Every one takes a batch of ids that the caller has already chunked (see
// chunkIds — Oracle caps an IN list at 1000 expressions).

// The ids go into the SQL as a bare IN list, so they are re-checked here as
// digits-only. The callers filter already; this is the guard that cannot be
// forgotten, and it lives next to the string being built rather than three
// functions away from it.
function idList(batch) {
  const ids = batch.map((id) => String(id).trim());
  const bad = ids.filter((id) => !/^\d+$/.test(id));
  if (bad.length) {
    throw new Error(`NetSuite SuiteQL: refusing to build a query with non-numeric id(s): ${bad.join(", ")}`);
  }
  if (!ids.length) throw new Error("NetSuite SuiteQL: refusing to build a query with an empty id list");
  return ids.join(",");
}

export const suiteqlQuery = {
  // Which invoices each sales order produced, and whether they were settled.
  // A Sales Order's own status says nothing about payment — it tracks shipping
  // and whether an invoice was CREATED, not whether it was paid. Measured on
  // this account: of the orders in status G "Billed", 1718 have a Paid In Full
  // invoice, 638 have an OPEN one and 29 have none, so "Billed" is not "paid"
  // for roughly a quarter of them.
  invoicesForOrders: (batch) =>
    `SELECT DISTINCT tl.createdfrom AS orderid, inv.id, inv.tranid, inv.status,
              BUILTIN.DF(inv.status) AS statuslabel
         FROM transactionline tl
         JOIN transaction inv ON inv.id = tl.transaction
        WHERE tl.createdfrom IN (${idList(batch)}) AND inv.type = 'CustInvc'`,

  // The address to fall back on when a sales order carries no email of its own.
  // Worth asking for: a B2B order without an email is failed outright, because
  // the buyer can't be matched to the company's contact — so this is the
  // difference between the order syncing and not syncing at all.
  customerEmails: (batch) =>
    `SELECT id, email FROM customer WHERE id IN (${idList(batch)}) AND email IS NOT NULL`,

  // Everything the sync knows about an order's shipments: the fulfillments, the
  // tracking numbers on them, when they shipped, the carrier service, and the
  // package weight.
  //
  // The tracking tables are LEFT JOINed, not JOINed. An inner join here answered
  // only for fulfillments that happen to carry a tracking number, which on this
  // account is a small minority: 17920 sales orders have an ItemShip record and
  // just 1212 of them have a TRACKED one. So an inner join threw away the ship
  // date, status, carrier and weight of ~93% of shipped orders — not because
  // NetSuite lacked them, but because the row had no tracking number to hang
  // them off. Those fields are per-FULFILLMENT facts and are read as such.
  //
  // packageweight comes from itemfulfillmentpackage, pre-aggregated in a
  // subquery. It has to be pre-aggregated: joining the package rows directly
  // would multiply against the tracking rows (fulfillment 3538 has 9 packages
  // and 9 tracking numbers, so a direct join reports 9x its real weight). The
  // subquery is deliberately left unbounded — bounding it to this batch's
  // fulfillments measured 3x slower on this account (2116ms vs 751ms), because
  // the extra transactionline pass costs more than aggregating the package
  // table outright.
  //
  // trandate is rendered as YYYY-MM-DD rather than returned raw: SuiteQL hands
  // dates back in the ACCOUNT's display format ("8/5/2026"), which is ambiguous
  // between US and rest-of-world spelling and is not what anything downstream
  // wants to store or compare.
  //
  // transactionline holds one row per fulfillment LINE, so every fulfillment's
  // details repeat per line — DISTINCT plus the caller's per-order grouping
  // collapse that.
  // Both carrier fields ride along on this query because both live on the same
  // fulfillment record the tracking numbers hang off, and Shopify is shown one
  // of them verbatim (see carrierName):
  //
  //   • shipmethod  — the service it went by, "FedEx Ground®" / "UPS® Ground
  //     Customer Account". Set on 3136 of this account's 25978 fulfillments,
  //     but on 1447 of the 1452 that actually carry a tracking number.
  //   • shipcarrier — the coarser field, "UPS" / "FedEx/USPS/More" / empty. Set
  //     on all 1452 tracked fulfillments, so it is the fallback for the handful
  //     whose service is blank.
  //
  // The 20000-odd fulfillments with neither are the untracked ones: nothing to
  // link a carrier to, and nothing lost by having none.
  trackingForOrders: (batch) =>
    `SELECT DISTINCT tl.createdfrom AS orderid, f.id AS fulfillmentid,
              n.trackingnumber,
              TO_CHAR(f.trandate, 'YYYY-MM-DD') AS shipdate,
              BUILTIN.DF(f.status) AS statuslabel,
              BUILTIN.DF(f.shipmethod) AS shipmethod,
              f.shipmethod AS shipmethodid,
              f.shipcarrier,
              w.packageweight
         FROM transactionline tl
         JOIN transaction f ON f.id = tl.transaction AND f.type = 'ItemShip'
         LEFT JOIN trackingnumbermap m ON m.transaction = f.id
         LEFT JOIN trackingnumber n ON n.id = m.trackingnumber
         LEFT JOIN (SELECT itemfulfillment, SUM(packageweight) AS packageweight
                      FROM itemfulfillmentpackage
                     GROUP BY itemfulfillment) w ON w.itemfulfillment = f.id
        WHERE tl.createdfrom IN (${idList(batch)})`,

  // What each individual shipment actually contained, which is what makes the
  // tracking numbers item-wise rather than a comma-joined string on the order:
  // SO 300777 shipped in four fulfillments, and only this says that
  // 875373500692 carried the 3x TSK4A and 875374098216 the single 721520LEC.
  //
  // Deliberately NOT folded into trackingForOrders above. That query already
  // returns one row per fulfillment x tracking number; adding the item lines
  // would multiply the two together (a 6-line, 9-number fulfillment goes from 9
  // rows to 54) for data that repeats identically down every tracking number.
  //
  // No join back to the sales order is needed: a fulfillment's own lines each
  // carry createdfrom pointing at the SO they were fulfilled from (verified on
  // this account: 1105 of 1105 ItemShip lines in a recent month have it set), so
  // this reads the lines directly and lets the caller group them.
  //
  // An item fulfillment is written in one of two shapes on this account, and
  // both have to be read or almost every shipment comes back empty:
  //
  //   • mainline only (3821 of 4108 fulfillments in 2026) — a single row,
  //     mainline = 'T', carrying the item and the shipped quantity NEGATED.
  //   • mainline + detail lines (the other 287) — the same mainline row plus
  //     one positive line per item, each mirrored by a negative line for the
  //     inventory movement, plus a ShipItem line for the freight charge.
  //
  // So the filter keeps the mainline row and the positive detail lines, and the
  // caller prefers the detail lines per fulfillment where it has them: they name
  // every item, where the mainline row names only the first (checked across 2026
  // — the mainline item is one of the detail items every single time, so
  // preferring detail never loses an item).
  //
  // ABS() because the mainline quantity is negative and the detail quantity is
  // positive, and both mean "this many shipped". ShipItem is excluded outright:
  // the carrier's charge line ("FedEx Ground®") is a cost, not something that
  // ships, and fulfilling it in Shopify would be fulfilling a line that is not
  // there. SUM+GROUP BY collapses an item split across several lines of the same
  // fulfillment into one quantity.
  // The shipping methods a run's fulfillments went by, whole, so the tracking
  // URL can be picked out of them.
  //
  // NetSuite ships no tracking URL of its own — checked on this account: the
  // trackingnumber record is an id and a number, the fulfillment record has no
  // URL field, and neither does the shipping item ("FedEx Ground®" has
  // shippingCarrier and a service code and nothing linkable). NetSuite DOES link
  // tracking numbers to carrier sites in its own UI when Shipping Label
  // Integration is on, but it builds those links as it renders them; there is no
  // column holding one. So the URL is a custom field somebody fills in on the
  // shipping item, once per method.
  //
  // SELECT * rather than naming that field: a custom field's id is whatever the
  // person who created it typed, and requiring a particular one would mean the
  // whole feature hinging on a name matching. Every column comes back and the
  // caller picks the one holding a URL (see pickTrackingUrlTemplate). It is also
  // why no field name from the environment is ever spliced into this SQL.
  shipItemsForTrackingUrl: (batch) =>
    `SELECT * FROM shipitem WHERE id IN (${idList(batch)})`,

  shipmentItemsForOrders: (batch) =>
    `SELECT fl.createdfrom AS orderid, fl.transaction AS fulfillmentid, fl.mainline,
              BUILTIN.DF(fl.item) AS item, SUM(ABS(fl.quantity)) AS quantity
         FROM transactionline fl
         JOIN transaction f ON f.id = fl.transaction AND f.type = 'ItemShip'
        WHERE fl.createdfrom IN (${idList(batch)})
          AND fl.itemtype <> 'ShipItem'
          AND (fl.mainline = 'T' OR fl.quantity > 0)
        GROUP BY fl.createdfrom, fl.transaction, fl.mainline, BUILTIN.DF(fl.item)`,
};
