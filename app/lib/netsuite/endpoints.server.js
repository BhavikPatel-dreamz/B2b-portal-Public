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

  // One item-fulfillment record, for its package weights. Always expanded —
  // the packages are a sublist, and they are the only reason it is fetched.
  itemFulfillment: (id) => `/itemfulfillment/${id}${EXPANDED}`,

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
//     ("Unknown field name 'createdFrom'"), and even with a fulfillment id in
//     hand the tracking numbers are not on the REST record: it carries package
//     weights only, and the numbers live in trackingnumbermap/trackingnumber.
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

  // Tracking numbers, with the fulfillment that carries them and when it
  // shipped. transactionline holds one row per fulfillment LINE, so the same
  // tracking number repeats per line — DISTINCT plus the caller's Set collapse
  // that. Most fulfillments legitimately have no tracking (2741 numbers across
  // 1442 of this account's 25815 ItemShip records), so an order coming back
  // without any is normal rather than a lookup failure.
  trackingForOrders: (batch) =>
    `SELECT DISTINCT tl.createdfrom AS orderid, n.trackingnumber,
              f.id AS fulfillmentid, f.trandate AS shipdate, BUILTIN.DF(f.status) AS statuslabel
         FROM transactionline tl
         JOIN transaction f ON f.id = tl.transaction AND f.type = 'ItemShip'
         JOIN trackingnumbermap m ON m.transaction = f.id
         JOIN trackingnumber n ON n.id = m.trackingnumber
        WHERE tl.createdfrom IN (${idList(batch)})`,
};
