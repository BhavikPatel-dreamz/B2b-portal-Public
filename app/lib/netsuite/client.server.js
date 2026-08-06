import {
  SyncStoppedError,
  getValidAccessToken,
  isSyncStopRequested,
  setSyncTotal,
  sleepUnlessStopped,
} from "./oauth.server.js";
import { recordPath, recordUrl, suiteqlQuery, suiteqlUrl } from "./endpoints.server.js";
import { toInstant } from "../timezone/index.js";
import {
  buildOrdersQuery,
  isDateLiteralRejected,
  nextOrderDateFormat,
  orderDateFormat,
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
    // The zone the emitted literals are written in — see nsQueryDateTime. It is
    // resolved here rather than passed in because this is the only place in the
    // fetch that needs it, and because the answer is per-shop and cached.
    const timeZone = await getSyncTimeZone(shop);
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
    // Retried, at most once per spelling, when NetSuite rejects the way a date
    // was written rather than the query itself — see ORDER_DATE_FORMATS, which
    // explains why the right spelling is the ACCOUNT's answer and not something
    // this app can know in advance. Every other failure comes straight out.
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
        const fallback = isDateLiteralRejected(err) ? nextOrderDateFormat(format) : null;
        // Out of spellings: the account has rejected every shape there is, so
        // this is no longer a guess that can be corrected and the error is the
        // real answer.
        if (!fallback) throw err;
        console.warn(
          `[netsuite] this account will not parse the "${format}" date literal in a sales-order filter — retrying with "${fallback}". Set NETSUITE_QUERY_DATE_FORMAT=${fallback} to skip this probe on every run. NetSuite said: ${err.message}`,
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

  // Tracking is best-effort: a failure here leaves linkedTrackingNumbers unset
  // and syncTracking simply reports "no tracking numbers", so it must never take
  // the whole run down.
  if (items.length > 0) {
    console.log(`[netsuite] fetching tracking for ${items.length} order(s)…`);
    try {
      const trackingMap = await fetchTrackingForOrders(shop, items.map((i) => i.id));
      for (const item of items) {
        if (trackingMap[item.id]) {
          item.linkedTrackingNumbers = trackingMap[item.id];
        }
      }
      const withTracking = items.filter((i) => i.linkedTrackingNumbers).length;
      console.log(`[netsuite] tracking found for ${withTracking}/${items.length} order(s).`);
    } catch (err) {
      console.warn("[netsuite] tracking lookup failed:", err?.message);
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

// Fetches tracking numbers, ship date, shipment status and package weight for
// each sales order via its ItemFulfillment records. Returns a map of
// { orderId: { numbers: "TRACK1, TRACK2", shipDate, status, packageWeight } }.
//
// This has to go through SuiteQL, in one batched query, because both halves of
// the REST route are dead ends on this account:
//
//   1. `/itemfulfillment?q=createdFrom IS <id>` is rejected outright —
//      "Unknown field name 'createdFrom' in the search query. The field does
//      not exist on this record type." So the SO -> fulfillment link has to be
//      resolved through transactionline.createdfrom instead. This is what made
//      the previous implementation return nothing for every order, on every
//      run, while burning one failing request per order.
//   2. Even with a fulfillment id in hand, the tracking numbers are not on the
//      REST record: linkedTrackingNumbers is absent and the `package` sublist
//      carries weight only. They live in trackingnumbermap/trackingnumber.
//      (Weight, conversely, is NOT reachable through SuiteQL — see
//      fetchFulfillmentPackageWeights below, which pays for it with one REST
//      call per fulfillment instead.)
//
// Verified against the account: 2741 tracking numbers across 1442 of the 25815
// ItemShip records, so most fulfillments legitimately have none — an order
// coming back without tracking is normal, not a lookup failure. Ship date and
// shipment status ride along on the same join, so they are only known for
// fulfillments that also carry a tracking number — the same scope this
// function has always had.
//
// transactionline holds one row per fulfillment LINE, so the same tracking
// number (and fulfillment id, ship date, status) repeats per line; DISTINCT
// plus the per-order Sets below collapse that.
async function fetchTrackingForOrders(shop, orderIds) {
  const ids = orderIds.map((id) => String(id)).filter((id) => /^\d+$/.test(id));
  if (!ids.length) return {};

  const rows = [];
  for (const batch of chunkIds(ids)) {
    rows.push(...await nsSuiteQl(shop, suiteqlQuery.trackingForOrders(batch)));
  }

  // Grouped per order: tracking numbers and statuses collapse duplicates the
  // same way the plain-string version always did; fulfillment ids are kept as
  // a Set so the weight lookup below asks NetSuite for each fulfillment record
  // once, never once per tracking-number row; ship date keeps the latest one
  // seen, since a re-shipped order's most recent fulfillment is the one worth
  // showing.
  const grouped = {};
  for (const r of rows) {
    const orderId = String(r.orderid);
    const entry = (grouped[orderId] ||= {
      numbers: new Set(), statuses: new Set(), fulfillmentIds: new Set(), shipDate: null,
    });
    const tn = String(r.trackingnumber ?? "").trim();
    if (tn) entry.numbers.add(tn);
    const status = String(r.statuslabel ?? "").trim();
    if (status) entry.statuses.add(status);
    if (r.fulfillmentid != null) entry.fulfillmentIds.add(String(r.fulfillmentid));
    const shipDate = r.shipdate ?? null;
    if (shipDate) {
      const parsed = Date.parse(shipDate);
      const current = entry.shipDate ? Date.parse(entry.shipDate) : NaN;
      // A date that fails to parse is still kept (better than dropping a real
      // ship date over a format this couldn't read) — it just can't outrank
      // whatever is already there, so the LAST one read wins in that case.
      if (!entry.shipDate || !Number.isFinite(current) || (Number.isFinite(parsed) && parsed > current)) {
        entry.shipDate = shipDate;
      }
    }
  }

  const weightByFulfillment = await fetchFulfillmentPackageWeights(
    shop,
    [...new Set(Object.values(grouped).flatMap((g) => [...g.fulfillmentIds]))],
  );

  return Object.fromEntries(
    Object.entries(grouped).map(([orderId, g]) => {
      const fids = [...g.fulfillmentIds];
      const known = fids.filter((fid) => weightByFulfillment[fid] != null);
      return [orderId, {
        numbers: [...g.numbers].join(", "),
        status: [...g.statuses].join(", ") || null,
        shipDate: g.shipDate,
        packageWeight: known.length ? known.reduce((sum, fid) => sum + weightByFulfillment[fid], 0) : null,
      }];
    }),
  );
}

// Package weight lives only on the ItemFulfillment REST record's `package`
// sublist (see the comment above fetchTrackingForOrders) — SuiteQL has no path
// to it, so each unique fulfillment costs one more GET here. Bounded by this
// batch's own fulfillment ids, not the account's full fulfillment history.
//
// The sublist's weight field name is unverified against this account (nothing
// in the codebase names it, and there's no test fixture to check against), so
// it's read defensively and the first package payload is dumped once — the
// same way fetchNetsuiteOrders dumps its first sample order record — so a
// wrong guess shows up as a visible log line instead of a run that just quietly
// reports no weight forever.
//
// Best-effort like the rest of this function's callers: one fulfillment's GET
// failing is logged and skipped, not raised, and a stop request ends the loop
// early rather than being ridden out.
async function fetchFulfillmentPackageWeights(shop, fulfillmentIds) {
  const map = {};
  let dumpedSample = false;
  for (const id of fulfillmentIds) {
    let full;
    try {
      full = await nsGet(shop, recordPath.itemFulfillment(id));
    } catch (err) {
      if (err?.syncStopped) break;
      console.warn(`[netsuite] package weight lookup for fulfillment ${id} failed:`, err?.message);
      continue;
    }
    const packages = full?.package?.items || [];
    if (!dumpedSample && packages.length) {
      console.log(`[netsuite] sample package sublist (fulfillment ${id}):`, JSON.stringify(packages));
      dumpedSample = true;
    }
    const weights = packages
      .map((p) => Number(p?.packageWeight ?? p?.weight))
      .filter((w) => Number.isFinite(w));
    if (weights.length) map[id] = weights.reduce((sum, w) => sum + w, 0);
    if (!(await sleep(shop, 300))) break;
  }
  return map;
}
