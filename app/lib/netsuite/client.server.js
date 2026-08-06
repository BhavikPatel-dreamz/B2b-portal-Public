import {
  SyncStoppedError,
  getValidAccessToken,
  isSyncStopRequested,
  setSyncTotal,
  sleepUnlessStopped,
} from "./oauth.server.js";
import { recordPath, recordUrl, suiteqlQuery, suiteqlUrl } from "./endpoints.server.js";
import { pickTrackingUrlTemplate } from "./shipitem.js";
import { toInstant } from "../timezone/index.js";
import {
  accountPreference,
  buildOrdersQuery,
  isQueryRejected,
  nextOrderDateFormat,
  orderDateFormat,
  readAccountPreference,
  rememberAccountPreference,
  rememberOrderDateFormat,
  scanOrders,
} from "./orders-query.server.js";
// Re-exported so the query builder stays reachable from the client module
// that callers already import — see orders-query.server.js for why they live
// apart.
export { buildOrdersQuery, plannedOrdersWindow, scanOrders } from "./orders-query.server.js";
import { getSyncTimeZone } from "../timezone/index.server.js";

// ---------------------------------------------------------------------------
// NetSuite SuiteTalk REST client (OAuth 2.0 Bearer token)
// ---------------------------------------------------------------------------
// Auth is handled per-shop by oauth.server.js (authorization code grant, with
// refresh). See that file for the connect/callback flow.
//
// Every URL this file calls is built by endpoints.server.js — nothing here
// concatenates a host, an API version or a record path.

// Every pause in this file is a rate-limit courtesy, and every one of them is
// cut short by Stop sync — see sleepUnlessStopped. `shop` is threaded through
// for that reason alone: without it a stopped run still sat out its remaining
// sleeps, which on a 50-order run is the best part of a minute of a button that
// looked like it had done nothing.
const sleep = (shop, ms) => sleepUnlessStopped(shop, ms);

// Every NetSuite call is bounded. fetch() has no timeout of its own, so a
// connection that opens and then stalls hangs the run for as long as the platform
// allows — and a cron run that never returns holds the shop's sync lock (see
// acquireSyncLock) until the stale timeout expires, blocking every run behind it.
// SuiteQL gets longer: it runs a real query, and this account's invoice lookup
// takes seconds on a wide window.
const DEFAULT_HTTP_TIMEOUT_MS = 30000;
const DEFAULT_SUITEQL_TIMEOUT_MS = 120000;

function httpTimeout(envName, fallback) {
  const n = Number(process.env[envName]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// True for the failures worth another attempt: a timeout, a dropped connection, a
// DNS blip. A 4xx/5xx is not routed here — those are handled by their own status
// checks, which know whether the response body means "retry" or "give up".
function isTransientNetworkError(err) {
  const name = err?.name || "";
  const code = err?.cause?.code || err?.code || "";
  return (
    name === "TimeoutError"
    || name === "AbortError"
    || ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(code)
  );
}

function stoppedDuring(what) {
  return new SyncStoppedError(`NetSuite ${what} abandoned: the sync was stopped by hand`);
}

// ---------------------------------------------------------------------------
// The one request function
// ---------------------------------------------------------------------------
// Every call this file makes to NetSuite goes through here — the record
// endpoints (nsGet) and SuiteQL (nsSuiteQl) alike. Both used to carry their own
// copy of the account URL, the token fetch, the headers and the timeout, and the
// copies had drifted: a timeout or a dropped connection was retried on a record
// GET and fatal on a SuiteQL query, so a network blip mid-invoice-lookup failed
// the enrichment for the whole run when the very same blip on the order fetch
// would simply have been waited out.
//
// Retries up to 4 times on a 429 or a transient network error, with exponential
// back-off (3s, 6s, 12s, 24s), or until the run is stopped — whichever comes
// first. Retrying is safe for everything sent from here: the record calls are
// GETs, and the SuiteQL POST is a read-only query (that is what Prefer:
// transient means), so neither can be applied twice.
//
// `what` is how the call is named in errors and logs (e.g. `GET /salesorder/1504`
// or `SuiteQL`), and `timeout` picks which of the two budgets applies — SuiteQL
// gets the longer one because it runs a real query, and this account's invoice
// lookup takes seconds on a wide window.
async function nsRequest(shop, { what, url, method = "GET", headers = {}, body, timeout }) {
  const maxRetries = 4;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // The token is fetched per attempt — and, for a paging caller, per page — so
    // a long run cannot outlive the one it started with.
    const accessToken = await getValidAccessToken(shop);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          ...headers,
        },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      if (!isTransientNetworkError(err) || attempt === maxRetries) {
        throw new Error(`NetSuite ${what} failed: ${err?.name || "network error"} ${err?.message || ""}`.trim());
      }
      const delay = 3000 * Math.pow(2, attempt);
      console.warn(`[netsuite] ${err?.name || "network error"} on ${what}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
      // A back-off that doubles to 24s is the longest a stopped run can sit
      // still, so the sleep wakes on a stop and the retry is abandoned rather
      // than served. Giving up here is not a failure of this order — see
      // SyncStoppedError, which the callers count as stopped work, not broken work.
      if (!(await sleep(shop, delay))) throw stoppedDuring(what);
      continue;
    }
    // Read once: a Response body cannot be consumed twice, and both the error
    // path and the success path want it.
    const text = await res.text().catch(() => "");
    if (res.status === 429 && attempt < maxRetries) {
      const delay = 3000 * Math.pow(2, attempt);
      console.warn(`[netsuite] 429 on ${what}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
      if (!(await sleep(shop, delay))) throw stoppedDuring(what);
      continue;
    }
    // Bounded, but generously: a NetSuite error body is the only description of
    // what it objected to, and the record endpoints' messages ("Unknown field
    // name 'createdFrom' …") are the ones worth reading in full.
    if (!res.ok) throw new Error(`NetSuite ${what} failed: ${res.status} ${text.slice(0, 1000)}`);
    return text ? JSON.parse(text) : null;
  }
  // Unreachable: the loop either returns, throws, or continues, and the last
  // attempt cannot continue. Here so the function has no implicit undefined exit.
  throw new Error(`NetSuite ${what} failed: retries exhausted`);
}

// A SuiteTalk REST record call (e.g. "/salesorder/1504" or "/salesorder?limit=100").
// Returns the parsed JSON body.
async function nsGet(shop, path) {
  return nsRequest(shop, {
    what: `GET ${path}`,
    url: recordUrl(path),
    timeout: httpTimeout("NETSUITE_HTTP_TIMEOUT_MS", DEFAULT_HTTP_TIMEOUT_MS),
  });
}

// POSTs a SuiteQL query and returns its rows. Needed because the parts of the
// schema this sync depends on are not reachable from the record endpoints —
// see fetchInvoicesForOrders (transactionline.createdfrom) and the tracking
// note in scripts/netsuite-export-orders.mjs.
// Pages until hasMore is false. SuiteQL caps a response at 1000 rows and says
// so ONLY via hasMore/totalResults — a query matching more just comes back
// truncated with a 200, no error. Reading one page would silently drop rows,
// which for the invoice lookup means an order looks un-invoiced and its Shopify
// financial status quietly falls back to PENDING. Verified on this account: a
// 2741-row query returns items=1000, totalResults=2741, hasMore=true, and
// offset paging returns disjoint pages.
const SUITEQL_PAGE = 1000;

async function nsSuiteQl(shop, sql) {
  const rows = [];
  let offset = 0;

  for (;;) {
    const body = await nsRequest(shop, {
      what: "SuiteQL",
      url: suiteqlUrl({ limit: SUITEQL_PAGE, offset }),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // SuiteQL rejects the request without this.
        Prefer: "transient",
      },
      body: JSON.stringify({ q: sql }),
      timeout: httpTimeout("NETSUITE_SUITEQL_TIMEOUT_MS", DEFAULT_SUITEQL_TIMEOUT_MS),
    });
    const page = body?.items ?? [];
    rows.push(...page);
    if (!body?.hasMore || !page.length) break;
    offset += SUITEQL_PAGE;
    // Stopped mid-query: the rows already read are returned rather than thrown
    // away, and the caller (the invoice lookup) treats a short answer the same
    // way it treats an account with fewer invoices — there is nothing half-made
    // here to leave behind.
    if (!(await sleep(shop, 300))) {
      console.warn(`[netsuite] ${shop}: SuiteQL paging stopped by hand after ${rows.length} row(s).`);
      break;
    }
  }
  return rows;
}

// Splits ids into chunks small enough for an Oracle IN list, which is capped at
// 1000 expressions — a batch bigger than that would otherwise build an IN list
// that the database rejects outright.
function chunkIds(ids, size = 500) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}



// The most ids NetSuite will return from one list call. Its own ceiling, not a
// choice this app makes — the REST record collections cap `limit` at 1000 and
// reject anything higher.
//
// There used to be a NETSUITE_ORDER_LIMIT on top of this, capping how many
// orders one run would take. It is gone: with paging removed, a cap below the
// page size did not bound work so much as silently decide WHICH orders a run
// saw — the first N ids of a multi-day filter, which for a short window are
// mostly the wrong ones. Asking for everything the filter matches, up to what
// NetSuite will give, is both simpler and more likely to be right.
const LIST_LIMIT = 1000;












// ---------------------------------------------------------------------------
// How this account writes dates
// ---------------------------------------------------------------------------
// GET /preference/userPreference, which answers with the three settings
// NetSuite's own parser uses on the `q` filter:
//
//   { "timeZone": { "id": "America/New_York", "refName": "(GMT-05:00) …" },
//     "dateFormat": "M/d/YYYY",
//     "timeFormat": "h:mm a" }
//
// Worth one request because those three were previously GUESSED — the sync wrote
// its date literals in SYNC_TIMEZONE and hoped the account agreed, and picked
// between a 24- and a 12-hour clock by watching which one came back with a 400.
// See ORDER_DATE_FORMATS.
//
// Best-effort, like every other lookup that decorates a run rather than being it:
// a failure leaves the preference unknown, and the ISO literal the filter leads
// with needs no preference at all. So this can only make the fallbacks better
// informed; it can never be the reason a run fails.
//
// Cached per shop for an hour. A format preference changes about as often as a
// store's timezone does (see getSyncTimeZone, which caches for the same reason
// and the same hour), and asking once per run for an answer that has not moved
// since the account was set up is a request per run for nothing.
const PREFERENCE_TTL_MS = 60 * 60 * 1000;
const preferenceCache = new Map();

// Named only so the warning below can say what the run will do instead, rather
// than leaving "the defaults" to be looked up in another file.
const DEFAULT_PREFERENCE_NOTE = 'dates as "M/d/YYYY" and times as "h:mm a"';

async function loadAccountPreference(shop) {
  const hit = preferenceCache.get(shop);
  // Re-remembered on a cache hit too, not just on a fetch: the remembered value
  // is process-wide (one NetSuite account per deployment) while this cache is
  // per shop, so setting it at the start of every fetch is what keeps the two
  // from disagreeing about which shop is currently syncing.
  if (hit && hit.expires > Date.now()) {
    rememberAccountPreference(hit.preference);
    return hit.preference;
  }

  let preference = null;
  let unavailable = false;
  try {
    const body = await nsGet(shop, recordPath.userPreference());
    preference = readAccountPreference(body);
    if (preference) {
      console.log(
        `[netsuite] ${shop}: account writes dates as "${preference.dateFormat}", times as "${preference.timeFormat}", in ${preference.timeZone || "an unstated zone"}.`,
      );
    } else {
      console.warn(
        "[netsuite] /preference/userPreference carried no dateFormat, timeFormat or timeZone:",
        JSON.stringify(body)?.slice(0, 500),
      );
    }
  } catch (err) {
    // A stop is not this lookup failing, and swallowing it here would have the
    // run carry on into the list call it was stopped before making.
    if (err?.syncStopped) throw err;
    unavailable = /Record type 'preference' does not exist|\b404\b/.test(err?.message || "");
    console.warn(
      `[netsuite] ${shop}: could not read the account's date preferences (${err?.message || err}) — the filter will fall back to assuming ${DEFAULT_PREFERENCE_NOTE}, and try the other shapes if that is refused.${unavailable ? " Not asking again this hour: this account does not serve that endpoint." : ""}`,
    );
  }

  // A real answer is cached, and so is a definitive "there is nothing to ask" —
  // this account answers the endpoint with
  //
  //   404 Record type 'preference' does not exist
  //
  // which will not become true an hour from now, and re-asking it every run is a
  // failing request and a warning line per run forever. Any OTHER failure (a
  // timeout, a 401 on a token that was mid-refresh) is left uncached so the next
  // run tries again, and must not overwrite an answer an earlier run already got.
  if (preference || unavailable) {
    preferenceCache.set(shop, { preference, expires: Date.now() + PREFERENCE_TTL_MS });
  }
  if (preference) rememberAccountPreference(preference);
  return preference ?? accountPreference();
}

// ---------------------------------------------------------------------------
// Targeted mode (NETSUITE_ORDER_IDS)
// ---------------------------------------------------------------------------
// A comma-separated list of sales orders to sync, given as either a document
// number ("SO20742", "20742") or a raw internal id ("20249"). When set, the
// date window is bypassed and ONLY these orders
// are fetched. Leave it blank/unset for normal incremental behaviour.
export function targetedOrderIds() {
  return (process.env.NETSUITE_ORDER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Resolves one identifier to a sales-order internal id. Tries a tranId lookup
// first (both with and without the "SO" prefix, since NetSuite stores the
// prefix on tranId but users usually type it either way), then falls back to
// treating a bare numeric value as an internal id.
async function resolveOrderId(shop, raw) {
  const candidates = [raw];
  if (/^SO/i.test(raw)) candidates.push(raw.replace(/^SO/i, ""));
  else candidates.push(`SO${raw}`);

  for (const c of candidates) {
    // Embedded quotes would break out of the q string literal.
    const safe = c.replace(/"/g, "");
    try {
      const list = await nsGet(
        shop,
        recordPath.salesOrderByTranId(safe),
      );
      const hit = (list?.items || []).find((i) => i?.id);
      if (hit) return { id: String(hit.id), via: `tranId IS "${safe}"` };
    } catch (err) {
      if (err?.syncStopped) throw err;
      console.warn(`[netsuite] tranId lookup "${safe}" failed:`, err?.message);
    }
    // Thrown rather than broken out of, because "not resolved" and "not asked"
    // are different answers: falling through would return { id: null } and the
    // caller would record this identifier as matching no sales order, which is a
    // claim about NetSuite that nothing here checked.
    if (!(await sleep(shop, 400))) {
      throw new SyncStoppedError(`resolving "${raw}" abandoned: the sync was stopped by hand`);
    }
  }

  if (/^\d+$/.test(raw)) {
    try {
      await nsGet(shop, recordPath.salesOrder(raw));
      return { id: raw, via: `internalId ${raw}` };
    } catch (err) {
      if (err?.syncStopped) throw err;
      console.warn(`[netsuite] internalId ${raw} lookup failed:`, err?.message);
    }
  }
  return { id: null };
}

// For a raw value the CALLER already knows is a NetSuite internal id — a re-sync
// of a log row is asking about the exact order it recorded before, not typing a
// guess — so there is no "SO number or internal id?" ambiguity to resolve and no
// reason to pay for resolveOrderId's two tranId search queries (plus the 400ms
// courtesy sleep between them) before it falls back to this same direct lookup.
// Only if this specific id no longer resolves (the order was deleted in NetSuite
// since we last saw it) does it fall back to the full ambiguity-handling search,
// on the offhand chance the identifier still means something as a tranId.
async function resolveKnownInternalId(shop, raw) {
  try {
    await nsGet(shop, recordPath.salesOrder(raw));
    return { id: raw, via: `internalId ${raw} (known)` };
  } catch (err) {
    if (err?.syncStopped) throw err;
    console.warn(`[netsuite] known internal id ${raw} no longer resolves, falling back to a tranId search:`, err?.message);
    return resolveOrderId(shop, raw);
  }
}

// ---------------------------------------------------------------------------
// The sales-order API, as one function
// ---------------------------------------------------------------------------
// Everything this app reads out of NetSuite's salesorder endpoint goes through
// here: the scheduled incremental run, a run scoped to an explicit date range
// from the log page's "Sync now", and a re-sync of hand-picked orders. One door,
// so there is one place where a run's scope is turned into a NetSuite query and
// one place to look when a run reads the wrong thing.
//
// The three ways to scope a call, in the order they take precedence:
//
//   • `ids` — an explicit list of sales orders (internal ids or SO numbers).
//     Skips the list endpoint entirely; no date range applies.
//   • `from`/`to` — a date range, passed straight through to the salesorder
//     query as its lastModifiedDate bounds. Accepts Date objects, epoch
//     milliseconds, or a date string; parsed by toInstant, so a bare
//     "YYYY-MM-DD" means that day in UTC and an impossible date is refused
//     rather than rolled over. Both ends are required; one alone is not a range
//     and is refused rather than quietly treated as open-ended, which would read
//     the account's whole history.
//   • `since` — the sync watermark, i.e. "everything modified since the last
//     successful run". What the cron passes.
//
// Note that a range and the watermark are NOT interchangeable, which is why they
// are separate arguments rather than one normalised pair: a range is re-applied
// exactly after the records are expanded (see inWindow, and ORDER_DATE_FORMATS
// for the accounts whose filter can only name whole days), and a run given a
// range never advances the watermark. The watermark path does neither.
export function fetchSalesOrders(shop, { from, to, since, ids, knownInternalIds } = {}) {
  let window = null;
  if (from || to) {
    if (!from || !to) {
      throw new Error("NetSuite salesorder: a date range needs both `from` and `to`");
    }
    // dayjs-backed (see toInstant): a bare YYYY-MM-DD is read as UTC, and a date
    // that does not exist — "2026-08-32", "2026-13-01" — is refused rather than
    // rolled over into a neighbouring month and quietly queried.
    const fromAt = toInstant(from);
    const toAt = toInstant(to);
    if (!fromAt || !toAt) {
      // Names WHICH end was unreadable; with both in one message it is a guess.
      const bad = [!fromAt && `from=${JSON.stringify(from)}`, !toAt && `to=${JSON.stringify(to)}`].filter(Boolean);
      throw new Error(`NetSuite salesorder: unreadable date range (${bad.join(", ")})`);
    }
    window = { from: fromAt, to: toAt };
    if (window.from > window.to) {
      throw new Error(`NetSuite salesorder: range starts after it ends (${window.from.toISOString()} → ${window.to.toISOString()})`);
    }
  }
  return fetchNetsuiteOrders(shop, { since, ids, window, knownInternalIds });
}

// Fetches sales orders from NetSuite. The list endpoint returns { items:
// [{ id, links }], hasMore, ... } with only ids, so we page through it and then
// expand each id into the full record. `since` (the sync watermark) drives the
// incremental lastModifiedDate window — see buildOrdersQuery.
// `window` ({ from, to }) is the other way to scope a run: an explicit stretch of
// modification time, asked for from the log page's "Sync now" control. It replaces
// the watermark window rather than narrowing it, and it is re-applied exactly after
// the records are expanded — see inWindow.
//
// Reached through fetchSalesOrders above, which is the documented entry point —
// this is where the paging, expanding and enrichment live.
export async function fetchNetsuiteOrders(shop, { since, ids, window, knownInternalIds } = {}) {
  const items = [];
  const errors = [];
  let refs;
  // Set when more orders matched than one list call returns — see the note
  // where it's assigned.
  let capped = null;
  // How many matching orders exist in total, independent of this call's own
  // list call — known once the list endpoint's response
  // comes back. Hoisted out of the listing branch below so the "fetching"
  // progress bar can report against the true total instead of just this
  // batch's count (see the setSyncTotal call further down).
  let totalResults = null;
  // Set when Stop sync cut the fetch short. Reported back so the caller stops
  // rather than syncing the partial set it happens to have: an interrupted fetch
  // is not "these are the orders that changed", and a run that treated it as one
  // would advance the watermark past everything it never listed.
  let stopped = false;

  // `ids` is the same targeted mode NETSUITE_ORDER_IDS gives, decided per call
  // instead of per process — it's what a manual re-sync of specific orders (the
  // log page's Sync buttons) passes. An explicit list wins over the env var.
  const requested = (ids || []).map((v) => String(v).trim()).filter(Boolean);
  const targeted = requested.length ? requested : targetedOrderIds();
  const source = requested.length ? "requested orders" : "NETSUITE_ORDER_IDS";
  if (targeted.length) {
    // Targeted mode: resolve each identifier to an internal id and skip the list
    // call entirely. No date window, no limit.
    console.log(`[netsuite] ${source} — syncing only: ${targeted.join(", ")}`);
    // "fetching" phase progress for a targeted list: one identifier resolved is
    // one done, whether or not it turned out to match an order.
    // Not reported as progress: the bar counts ORDERS SYNCED against the orders
    // this run has to do, and an id being resolved is neither. Resetting it here
    // is what stops the bar showing the previous run's numbers while this one
    // reads NetSuite.
    await setSyncTotal(shop, null, 0);
    refs = [];
    for (const raw of targeted) {
      // Resolving costs a lookup and a pause per identifier, so a long targeted
      // list gets the same per-item stop check the expand pass gets.
      if (await isSyncStopRequested(shop)) {
        stopped = true;
        console.warn(`[netsuite] ${shop}: id resolution stopped by hand after ${refs.length} of ${targeted.length}.`);
        break;
      }
      let resolved;
      try {
        resolved = knownInternalIds?.has(raw)
          ? await resolveKnownInternalId(shop, raw)
          : await resolveOrderId(shop, raw);
      } catch (err) {
        if (!err?.syncStopped) throw err;
        stopped = true;
        break;
      }
      const { id, via } = resolved;
      if (id) {
        console.log(`[netsuite] resolved "${raw}" -> internal id ${id} (${via})`);
        refs.push({ id });
      } else {
        console.error(`[netsuite] could not resolve "${raw}" to a sales order`);
        errors.push({ id: raw, error: `${source}: "${raw}" did not match any sales order` });
      }
    }
    // Two identifiers can point at the same order (e.g. "SO20742" and "20742").
    const seen = new Set();
    refs = refs.filter((r) => !seen.has(r.id) && seen.add(r.id));
  } else {
    // The zone the emitted literals are written in — which the ISO spelling the
    // filter normally uses does not need at all, but the account-formatted
    // fallbacks do (see ORDER_DATE_FORMATS). Resolved here rather than passed in
    // because this is the only place in the fetch that needs it, and because the
    // answer is per-shop and cached. The account's OWN zone, when the preference
    // below could be read, outranks it for those literals — it is the zone
    // NetSuite compares them in.
    const timeZone = await getSyncTimeZone(shop);
    await loadAccountPreference(shop);
    let format = orderDateFormat();
    let q = buildOrdersQuery(since, window, timeZone, format);
    // ONE list call, no paging. The filter decides what comes back and the run
    // syncs that — there is no offset walk, no resume session and no backlog to
    // drain across runs.
    //
    // The consequence is worth being explicit about, because it is invisible
    // otherwise: NetSuite returns at most `limit` ids per call (1000 is the REST
    // maximum), so a filter matching more than that is answered only in part.
    // `totalResults` says how many it really matched, and anything beyond what
    // came back is reported as `capped` below — which is what stops the run
    // advancing the watermark past orders it never saw. Nothing is skipped
    // silently; it is skipped loudly, and the next run asks the same question.
    const limit = LIST_LIMIT;
    refs = [];
    // Retried, at most once per spelling, when NetSuite rejects the way the
    // filter was written — see ORDER_DATE_FORMATS, which explains why the right
    // spelling is the ACCOUNT's answer and not something this app can know in
    // advance. Every other failure comes straight out.
    //
    // Not for a NETSUITE_ORDERS_QUERY override, which replaces the filter
    // wholesale: rewriting the date literals cannot fix a query this app did not
    // write, so all a walk would do there is send the same rejected string four
    // times before surfacing the error it had on the first attempt.
    const canReword = Boolean(window) || !process.env.NETSUITE_ORDERS_QUERY;
    for (;;) {
      try {
        const list = await nsGet(shop, recordPath.salesOrderList({ limit, offset: 0, q }));
        refs = Array.isArray(list?.items) ? list.items : [];
        totalResults = list?.totalResults ?? null;
        break;
      } catch (err) {
        // A call abandoned because of a stop is not a listing failure — the run
        // is over either way, and raising here would report it as NetSuite being
        // unreachable.
        if (err?.syncStopped) {
          stopped = true;
          break;
        }
        const fallback = canReword && isQueryRejected(err) ? nextOrderDateFormat(format) : null;
        // Out of spellings: the account has rejected every shape there is, so
        // this is no longer a guess that can be corrected and the error is the
        // real answer.
        if (!fallback) throw err;
        console.warn(
          `[netsuite] this account will not parse a sales-order filter written the "${format}" way — retrying with "${fallback}". Set NETSUITE_QUERY_DATE_FORMAT=${fallback} to skip this probe on every run. NetSuite said: ${err.message}`,
        );
        // Remembered before the retry, not after it: plannedOrdersWindow reads
        // the same setting for the schedule card, and a card still showing a
        // query this account has just refused is worse than one showing a
        // spelling that turns out to need one more step.
        rememberOrderDateFormat(fallback);
        format = fallback;
        q = buildOrdersQuery(since, window, timeZone, format);
      }
    }

    console.log(
      `[netsuite] q=${q} matched ${totalResults ?? refs.length} order(s); listed ${refs.length}.`,
    );
    // Never let the page limit truncate silently — a run that skips orders has to
    // say so, or the log reads as "everything is in sync" when it is not. A
    // listing cut short by Stop sync is excluded on purpose: it did leave orders
    // unlisted, but not because a limit was too low, and telling someone to raise
    // the range because they pressed Stop is worse than saying
    // nothing. The stop is reported on its own terms instead.
    if (!stopped && totalResults != null && totalResults > refs.length) {
      capped = {
        limit,
        matched: totalResults,
        fetched: refs.length,
        skipped: totalResults - refs.length,
        reason: "more orders match than one NetSuite list call returns",
      };
      console.warn(
        `[netsuite] ${totalResults} order(s) match this filter but NetSuite returns at most ${limit} per call — ${capped.skipped} were not listed. Narrow the range.`,
      );
    }
  }

  if (!stopped) {
    // Cleared rather than counted, for the reason above. The real total is set
    // by the caller once the fetch is done and it knows how many orders it has
    // to sync (see setSyncTotal in runOrderSync).
    await setSyncTotal(shop, null, 0);
  }

  // Expand each listed id into the full record, keeping the ones that really
  // fall in the window. The walk itself is scanOrders (below) so it can be
  // tested without a NetSuite account; everything account-shaped — the request,
  // the diagnostics, the rate-limit sleep — stays in this callback.
  let dumped = false;
  const scan = await scanOrders(refs, {
    window,
    // Asked before each order is expanded. Expanding is a read, so between two of
    // them is as safe a place to stop as between two pages — and it is where a
    // long run spends most of its time, a second of rate-limit sleep and a round
    // trip per order.
    stopped: () => isSyncStopRequested(shop),
    // Without a window every listed order is one to sync, and the list call was
    // already capped at that number.
    expand: async (id) => {
      // Without expandSubResources, SuiteTalk REST returns sublists (e.g.
      // "item") as a bare link reference instead of inline line data, which
      // left mapNetsuiteOrder() with an empty lineItems array.
      const full = await nsGet(shop, recordPath.salesOrder(id, { expand: true }));
      // Diagnostic: dump the full expanded record for the FIRST order of each
      // run so the account's real field shape stays visible without flooding
      // the logs when a window spans many orders.
      if (!dumped) {
        console.log(`[netsuite] sample record ${id}:`, JSON.stringify(full));
        dumped = true;
      }
      if (!(full?.item?.items?.length > 0)) {
        console.warn(
          `[netsuite] order ${id}: no inline line items — "item" was:`,
          JSON.stringify(full?.item),
        );
      }
      await sleep(shop, 1000);
      return full;
    },
  });
  if (scan.stopped) stopped = true;
  items.push(...scan.items);
  for (const err of scan.errors) {
    console.error(`[netsuite] expand order ${err.id} failed:`, err.error);
    errors.push(err);
  }
  const { outsideWindow, scanned } = scan;   // both logged only

  if (window) {
    console.log(
      `[netsuite] window ${window.from.toISOString()} → ${window.to.toISOString()}: scanned ${scanned} listed order(s), kept ${items.length}, ${outsideWindow} were modified outside it.`,
    );
  }

  // Nothing below this line is worth doing for a fetch that was called off. The
  // three lookups that follow decorate records the caller is about to discard —
  // between them several SuiteQL queries, each of which can take seconds on a
  // wide window — so a stopped run returns here instead of paying for them.
  if (stopped) {
    console.warn(
      `[netsuite] ${shop}: fetch stopped by hand — returning ${items.length} order(s) unenriched; the caller will not sync them.`,
    );
    return { items, errors, capped, stopped: true, ...(window ? { outsideWindow } : {}) };
  }

  // Fetch tracking numbers from linked Item Fulfillment records and attach
  // them to each order. Sales Orders don't carry tracking — it lives on the
  // separate ItemFulfillment record created when goods ship.
  // Attach the linked invoices so the Shopify financial status is derived from
  // the invoice's real paid state instead of being guessed from the SO status.
  // A failure here must not break the sync — mapFinancialStatus falls back to
  // the SO status when linkedInvoices is absent.
  if (items.length > 0) {
    try {
      const invoiceMap = await fetchInvoicesForOrders(shop, items.map((i) => i.id));
      for (const item of items) {
        const invoices = invoiceMap[String(item.id)];
        if (invoices) item.linkedInvoices = invoices;
      }
      const paid = items.filter((i) =>
        i.linkedInvoices?.length && i.linkedInvoices.every((v) => v.statusId === INVOICE_PAID_IN_FULL),
      ).length;
      console.log(
        `[netsuite] invoices: ${items.filter((i) => i.linkedInvoices).length}/${items.length} order(s) invoiced, ${paid} fully paid.`,
      );
    } catch (err) {
      console.warn("[netsuite] invoice lookup failed, falling back to SO status:", err?.message);
    }
  }

  // Orders whose own Email field is blank get the address off their customer
  // record instead. Best-effort like the two lookups around it: without it the
  // order simply keeps the null email it already had.
  //
  // Skipped entirely under TEST_EMAIL, which overrides every order's email in
  // mapNetsuiteOrder — asking NetSuite for an address that is guaranteed to be
  // discarded is a request per run for nothing.
  const withoutEmail = process.env.TEST_EMAIL
    ? []
    : items.filter((i) => !i.email && i?.entity?.id);
  if (withoutEmail.length > 0) {
    try {
      const emailMap = await fetchCustomerEmails(shop, withoutEmail.map((i) => i.entity.id));
      let filled = 0;
      for (const item of withoutEmail) {
        const email = emailMap[String(item.entity.id)];
        if (email) {
          item.linkedCustomerEmail = email;
          filled++;
        }
      }
      console.log(
        `[netsuite] customer email fallback: ${withoutEmail.length} order(s) had no email of their own, filled ${filled} from the customer record.`,
      );
    } catch (err) {
      console.warn("[netsuite] customer email lookup failed:", err?.message);
    }
  }

  // Shipment detail is best-effort: a failure here leaves linkedTrackingNumbers
  // unset and syncTracking reports the order as having no fulfillment record,
  // so it must never take the whole run down.
  if (items.length > 0) {
    console.log(`[netsuite] fetching shipment detail for ${items.length} order(s)…`);
    try {
      const trackingMap = await fetchTrackingForOrders(shop, items.map((i) => i.id));
      for (const item of items) {
        if (trackingMap[item.id]) {
          item.linkedTrackingNumbers = trackingMap[item.id];
        }
      }
      // Shipped and tracked are counted apart because they diverge sharply on
      // this account, and a single "tracking found for N orders" number hid
      // that: most shipped orders carry no tracking number, which is normal
      // and not something the next reader should have to rediscover.
      const shipped = items.filter((i) => i.linkedTrackingNumbers);
      const tracked = shipped.filter((i) => i.linkedTrackingNumbers.tracked > 0);
      const weighed = shipped.filter((i) => i.linkedTrackingNumbers.packageWeight != null);
      console.log(
        `[netsuite] shipments: ${shipped.length}/${items.length} order(s) have a fulfillment, `
        + `${tracked.length} carry tracking numbers, ${weighed.length} have a package weight.`,
      );
    } catch (err) {
      console.warn("[netsuite] shipment lookup failed:", err?.message);
    }
  }

  return { items, errors, capped, ...(window ? { outsideWindow } : {}) };
}

// ---------------------------------------------------------------------------
// Invoices (the real paid/unpaid signal)
// ---------------------------------------------------------------------------
// A Sales Order's own status says nothing about payment — it tracks shipping and
// whether an invoice was CREATED, not whether it was settled. Measured on this
// account (2026 orders): of the sales orders in status G "Billed", 1718 have a
// Paid In Full invoice, 638 have an OPEN (unpaid) invoice, and 29 have no
// invoice at all. So "Billed" is not "paid" for roughly a quarter of them, and
// the invoice record is the only fact that answers it.
//
// Invoice status ids on this account: A = Open, B = Paid In Full.
//
// The SO -> Invoice link is only reachable through transactionline.createdfrom
// (the same reason the tracking lookup below has to go through SuiteQL), so
// this is one batched query for the whole run rather than a call per order.
// Returns a map of { orderId: [{ id, tranId, statusId, statusLabel }, ...] }.
export const INVOICE_PAID_IN_FULL = "B";
export const INVOICE_OPEN = "A";

async function fetchInvoicesForOrders(shop, orderIds) {
  const ids = orderIds.map((id) => String(id)).filter((id) => /^\d+$/.test(id));
  if (!ids.length) return {};

  const rows = [];
  for (const batch of chunkIds(ids)) {
    rows.push(...await nsSuiteQl(shop, suiteqlQuery.invoicesForOrders(batch)));
  }

  const map = {};
  const seen = new Set();
  for (const r of rows) {
    const key = String(r.orderid);
    // DISTINCT only dedupes within one page/batch, so the same invoice can
    // arrive twice; a duplicate would skew the paid-vs-total count that decides
    // PAID / PARTIALLY_PAID / PENDING.
    const pair = `${key}:${r.id}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    (map[key] ||= []).push({
      id: String(r.id),
      tranId: r.tranid ?? null,
      statusId: r.status ?? null,
      statusLabel: r.statuslabel ?? null,
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Customer email (the fallback when the order carries none)
// ---------------------------------------------------------------------------
// A sales order's own Email field is what the sync normally uses, but it is only
// as reliable as the form the order was entered on: measured on this account,
// 13 of the 447 sales orders since 1 Jul 2026 have no email at all, and they
// cluster by custom form (form 153 and 190 carry none, form 152 fills 212 of
// 218). The customer record behind those orders usually does have one — 7 of
// those 13 — so it is worth asking for.
//
// This matters more than a missing field usually would: a B2B order (one with a
// company name) is failed outright without an email, because the buyer can't be
// identified as the company's contact — see lookupCompanyLocation in
// order-sync.server.js. So the fallback is the difference between the order
// syncing and not syncing at all.
//
// One batched query for the whole run, keyed on customer id, because a window
// normally holds several orders for the same handful of customers.
// Returns a map of { customerId: "someone@example.com" }.
async function fetchCustomerEmails(shop, customerIds) {
  const ids = [...new Set(customerIds.map((id) => String(id)))].filter((id) => /^\d+$/.test(id));
  if (!ids.length) return {};

  const rows = [];
  for (const batch of chunkIds(ids)) {
    rows.push(...await nsSuiteQl(shop, suiteqlQuery.customerEmails(batch)));
  }

  const map = {};
  for (const r of rows) {
    const email = String(r.email ?? "").trim();
    if (email) map[String(r.id)] = email;
  }
  return map;
}

// Fetches the shipment facts for each sales order from its ItemFulfillment
// records: tracking numbers, ship date, shipment status, carrier service and
// package weight. Returns a map of
// { orderId: { numbers, shipDate, status, shipMethod, packageWeight,
//              fulfillments, tracked } }.
//
// This goes through SuiteQL, in one batched query, because the REST route is a
// dead end in both directions:
//
//   1. `/itemfulfillment?q=createdFrom IS <id>` is rejected outright —
//      "Unknown field name 'createdFrom' in the search query. The field does
//      not exist on this record type." So the SO -> fulfillment link has to be
//      resolved through transactionline.createdfrom instead. This is what made
//      an earlier implementation return nothing for every order, on every run,
//      while burning one failing request per order.
//   2. The tracking numbers are not on the REST record at all — they live in
//      trackingnumbermap/trackingnumber.
//
// Package weight used to be read back through REST, one GET per fulfillment,
// off `record.package.items`. That found a weight on 0 of 20 sampled
// fulfillments, because the package sublist is named for the CARRIER, not
// uniformly: a UPS shipment carries `packageUps` with `packageWeightUps`, a
// FedEx one `packageFedex` with `packageWeightFedEx`, and only a
// carrier-less shipment has the plain `package`/`packageWeight` the code was
// looking for. So every run paid a request plus a 300ms pause per fulfillment
// to come back with null every time. The itemfulfillmentpackage table exposes
// all three uniformly and rides along on this query for free — verified equal
// to the REST sublist sum on every fulfillment checked (e.g. 3538: 9 UPS
// packages x 17 = 153, matching the record's own shipmentWeightUps).
//
// Ship date, status, carrier and weight are per-FULFILLMENT facts, so they are
// read from fulfillments whether or not a tracking number happens to hang off
// them (see the LEFT JOIN note on the query). Tracking numbers themselves stay
// genuinely sparse — 2756 numbers across 1454 of this account's 25978 ItemShip
// records — so an order coming back with a ship date and no tracking is the
// normal case, not a lookup failure.
//
// transactionline holds one row per fulfillment LINE, so every fulfillment's
// details repeat per line and per tracking number; DISTINCT plus the per-order
// grouping below collapse that. Weight in particular must be counted ONCE per
// fulfillment, not once per row.
async function fetchTrackingForOrders(shop, orderIds) {
  const ids = orderIds.map((id) => String(id)).filter((id) => /^\d+$/.test(id));
  if (!ids.length) return {};

  const rows = [];
  for (const batch of chunkIds(ids)) {
    rows.push(...await nsSuiteQl(shop, suiteqlQuery.trackingForOrders(batch)));
  }

  // Grouped per order. Tracking numbers, statuses and carriers collapse
  // duplicates through Sets; weights are keyed by fulfillment id so a
  // fulfillment repeated across rows is added once; ship date keeps the latest
  // seen, since a re-shipped order's most recent fulfillment is the one worth
  // showing.
  //
  // shipmentById is the same rows kept APART instead of merged: one entry per
  // NetSuite fulfillment, holding its own numbers, carrier, date and weight. It
  // is what lets Shopify show shipment-by-shipment tracking (this number carried
  // these items) rather than every number on every fulfillment. The merged
  // fields above stay exactly as they were — the log, the custom attributes and
  // the fallback paths all still read them.
  const grouped = {};
  for (const r of rows) {
    const orderId = String(r.orderid);
    const entry = (grouped[orderId] ||= {
      numbers: new Set(), statuses: new Set(), shipMethods: new Set(),
      fulfillmentIds: new Set(), weightByFulfillment: new Map(), shipDate: null,
      shipmentById: new Map(),
    });
    const tn = String(r.trackingnumber ?? "").trim();
    if (tn) entry.numbers.add(tn);
    const status = cleanShipmentStatus(r.statuslabel);
    if (status) entry.statuses.add(status);
    const shipMethod = String(r.shipmethod ?? "").trim();
    if (shipMethod) entry.shipMethods.add(shipMethod);
    if (r.fulfillmentid != null) {
      const fid = String(r.fulfillmentid);
      entry.fulfillmentIds.add(fid);
      const weight = Number(r.packageweight);
      if (Number.isFinite(weight)) entry.weightByFulfillment.set(fid, weight);
      const shipment = entry.shipmentById.get(fid) || {
        id: fid, numbers: new Set(), shipDate: null, status: null,
        shipMethod: null, carrier: null, packageWeight: null,
        // Two candidate item lists, resolved to one below: a fulfillment's
        // detail lines name every item it carried, its mainline row only the
        // first, and 93% of this account's fulfillments have nothing but the
        // mainline row (see shipmentItemsForOrders).
        items: [], mainlineItems: [],
        // The shipping item id, kept only long enough to look its tracking URL
        // up below; it is dropped before the shipment is returned.
        shipMethodId: null, trackingUrlTemplate: null,
      };
      if (tn) shipment.numbers.add(tn);
      shipment.shipDate ||= String(r.shipdate ?? "").trim() || null;
      shipment.status ||= status;
      shipment.shipMethod ||= shipMethod || null;
      shipment.carrier ||= String(r.shipcarrier ?? "").trim() || null;
      shipment.shipMethodId ||= r.shipmethodid != null ? String(r.shipmethodid) : null;
      if (Number.isFinite(weight)) shipment.packageWeight = weight;
      entry.shipmentById.set(fid, shipment);
    }
    // Already YYYY-MM-DD (the query renders it), so a plain string compare
    // orders these correctly and needs no date parsing to do it.
    const shipDate = String(r.shipdate ?? "").trim();
    if (shipDate && (!entry.shipDate || shipDate > entry.shipDate)) entry.shipDate = shipDate;
  }

  // What each of those shipments contained. Best-effort on purpose: without it
  // the shipments still carry their tracking numbers and carrier, and the
  // fulfillment write falls back to splitting the order's lines the way it did
  // before there was any item detail at all.
  try {
    const itemRows = [];
    for (const batch of chunkIds(ids)) {
      itemRows.push(...await nsSuiteQl(shop, suiteqlQuery.shipmentItemsForOrders(batch)));
    }
    for (const r of itemRows) {
      const shipment = grouped[String(r.orderid)]?.shipmentById?.get(String(r.fulfillmentid));
      const item = String(r.item ?? "").trim();
      const quantity = Number(r.quantity);
      if (!shipment || !item || !Number.isFinite(quantity) || quantity <= 0) continue;
      if (String(r.mainline) === "T") shipment.mainlineItems.push({ item, quantity });
      else shipment.items.push({ item, quantity });
    }
  } catch (err) {
    console.warn("[netsuite] shipment item lookup failed:", err?.message);
  }

  await attachTrackingUrls(shop, grouped);

  return Object.fromEntries(
    Object.entries(grouped).map(([orderId, g]) => {
      const weights = [...g.weightByFulfillment.values()];
      return [orderId, {
        numbers: [...g.numbers].join(", "),
        status: [...g.statuses].join(", ") || null,
        shipMethod: [...g.shipMethods].join(", ") || null,
        shipDate: g.shipDate,
        // Oldest shipment first, so the Shopify fulfillments the sync writes off
        // these come out in the order the goods actually left the warehouse.
        // Listed field by field rather than spread: shipMethodId and
        // mainlineItems are working state (the shipping item to look a URL up
        // by, the fallback item list) and have no business leaving this
        // function.
        shipments: [...g.shipmentById.values()]
          .map((s) => ({
            id: s.id,
            numbers: [...s.numbers],
            items: s.items.length ? s.items : s.mainlineItems,
            shipDate: s.shipDate,
            status: s.status,
            shipMethod: s.shipMethod,
            carrier: s.carrier,
            trackingUrlTemplate: s.trackingUrlTemplate,
            packageWeight: s.packageWeight,
          }))
          .sort((a, b) => (a.shipDate || "").localeCompare(b.shipDate || "") || Number(a.id) - Number(b.id)),
        // Rounded because summing decimal weights in binary floating point
        // produces artefacts: four FedEx packages on SO 295937 add up to
        // 72.17000000000004, and this value is written verbatim into a Shopify
        // custom attribute and a log line. Two places is past the precision
        // NetSuite records a package weight to.
        packageWeight: weights.length ? round2(weights.reduce((sum, w) => sum + w, 0)) : null,
        // Log-only, and the difference between "NetSuite has no tracking for
        // this shipment" and "the lookup found no shipment at all" — which the
        // sync log could not previously tell apart.
        fulfillments: g.fulfillmentIds.size,
        tracked: g.numbers.size,
      }];
    }),
  );
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Fills in each shipment's trackingUrlTemplate from its shipping method.
//
// NetSuite has no tracking URL of its own anywhere — not on the tracking number,
// the fulfillment or the shipping item — so the link the customer clicks in
// Shopify can only come from a custom field someone fills in on the shipping
// method, once per method:
//
//   <any custom field> = https://www.fedex.com/fedextrack/?trknbr={number}
//
// Any custom field, on purpose: the whole shipping item record is read and the
// URL is recognised by what it CONTAINS, not by the field being called something
// in particular (see pickTrackingUrlTemplate). NETSUITE_TRACKING_URL_FIELD pins
// an exact column when an account wants to be explicit about which one; an empty
// value skips the lookup entirely.
//
// Best-effort: an account that has not filled anything in is the normal state,
// not a fault. The shipments keep their numbers and carrier either way, and only
// the link is missing.
async function attachTrackingUrls(shop, grouped) {
  const pinned = process.env.NETSUITE_TRACKING_URL_FIELD?.trim();
  if (pinned === "") return;

  const shipments = Object.values(grouped).flatMap((g) => [...g.shipmentById.values()]);
  const ids = [...new Set(shipments.map((s) => s.shipMethodId).filter((id) => id && /^\d+$/.test(id)))];
  if (!ids.length) return;

  let templateById;
  try {
    const rows = [];
    for (const batch of chunkIds(ids)) {
      rows.push(...await nsSuiteQl(shop, suiteqlQuery.shipItemsForTrackingUrl(batch)));
    }
    templateById = new Map(
      rows
        .map((r) => [String(r.id), pickTrackingUrlTemplate(r, pinned)])
        .filter(([, template]) => template),
    );
  } catch (err) {
    console.warn(`[netsuite] shipping method lookup failed (${err?.message}); tracking numbers sync without a link.`);
    return;
  }

  let filled = 0;
  for (const shipment of shipments) {
    const template = templateById.get(shipment.shipMethodId);
    if (!template) continue;
    shipment.trackingUrlTemplate = template;
    filled++;
  }
  console.log(
    `[netsuite] tracking URLs: ${templateById.size} of ${ids.length} shipping method(s) carry one, `
    + `covering ${filled} of ${shipments.length} shipment(s).`,
  );
}

// NetSuite labels an item fulfillment's status "Item Fulfillment : Shipped".
// The record type is already known from context everywhere this is shown — on a
// Shopify custom attribute and in the sync log next to the tracking number — so
// only the state itself is kept.
function cleanShipmentStatus(label) {
  const text = String(label ?? "").trim();
  if (!text) return null;
  const colon = text.lastIndexOf(":");
  return (colon === -1 ? text : text.slice(colon + 1).trim()) || null;
}
