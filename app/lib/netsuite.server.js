import {
  SyncStoppedError,
  bumpSyncDone,
  getValidAccessToken,
  isSyncStopRequested,
  setSyncTotal,
  sleepUnlessStopped,
} from "./netsuite-oauth.server.js";

// ---------------------------------------------------------------------------
// NetSuite SuiteTalk REST client (OAuth 2.0 Bearer token)
// ---------------------------------------------------------------------------
// Auth is handled per-shop by netsuite-oauth.server.js (authorization code
// grant, with refresh). See that file for the connect/callback flow.

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`NetSuite: missing ${name} env var`);
  return v;
}

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

function stoppedDuring(path) {
  return new SyncStoppedError(`NetSuite GET ${path} abandoned: the sync was stopped by hand`);
}

// Low-level GET against a SuiteTalk REST path (e.g. "/salesorder/1504" or
// "/salesorder?limit=100"). Returns the parsed JSON body.
// Retries up to 4 times on 429 with exponential back-off (3s, 6s, 12s, 24s), or
// until the run is stopped — whichever comes first.
async function nsGet(shop, path) {
  const base = required("NETSUITE_ACCOUNT_URL").replace(/\/$/, "");
  const accessToken = await getValidAccessToken(shop);
  const maxRetries = 4;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await fetch(`${base}/services/rest/record/v1${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(httpTimeout("NETSUITE_HTTP_TIMEOUT_MS", DEFAULT_HTTP_TIMEOUT_MS)),
      });
    } catch (err) {
      // A GET is safe to repeat, so a timeout or a dropped connection gets the
      // same back-off as a 429 instead of failing the order outright.
      if (!isTransientNetworkError(err) || attempt === maxRetries) {
        throw new Error(`NetSuite GET ${path} failed: ${err?.name || "network error"} ${err?.message || ""}`.trim());
      }
      const delay = 3000 * Math.pow(2, attempt);
      console.warn(`[netsuite] ${err?.name || "network error"} on ${path}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
      // A back-off that doubles to 24s is the longest a stopped run can sit
      // still, so the sleep wakes on a stop and the retry is abandoned rather
      // than served. Giving up here is not a failure of this order — see
      // SyncStoppedError, which the callers count as stopped work, not broken work.
      if (!(await sleep(shop, delay))) throw stoppedDuring(path);
      continue;
    }
    if (res.status === 429) {
      if (attempt === maxRetries) {
        const text = await res.text().catch(() => "");
        throw new Error(`NetSuite GET ${path} failed: ${res.status} ${text}`);
      }
      const delay = 3000 * Math.pow(2, attempt);
      console.warn(`[netsuite] 429 on ${path}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
      if (!(await sleep(shop, delay))) throw stoppedDuring(path);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`NetSuite GET ${path} failed: ${res.status} ${text}`);
    }
    return res.json();
  }
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
  const base = required("NETSUITE_ACCOUNT_URL").replace(/\/$/, "");
  const rows = [];
  let offset = 0;

  for (;;) {
    // The token is fetched per page so a long paging run cannot outlive it.
    const accessToken = await getValidAccessToken(shop);
    const res = await fetch(
      `${base}/services/rest/query/v1/suiteql?limit=${SUITEQL_PAGE}&offset=${offset}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          // SuiteQL rejects the request without this.
          Prefer: "transient",
        },
        body: JSON.stringify({ q: sql }),
        signal: AbortSignal.timeout(httpTimeout("NETSUITE_SUITEQL_TIMEOUT_MS", DEFAULT_SUITEQL_TIMEOUT_MS)),
      },
    );
    const text = await res.text();
    if (!res.ok) throw new Error(`NetSuite SuiteQL failed: ${res.status} ${text.slice(0, 300)}`);
    const body = JSON.parse(text);
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
// 1000 expressions — a run with NETSUITE_ORDER_LIMIT above that would otherwise
// build an IN list that the database rejects outright.
function chunkIds(ids, size = 500) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

// Formats a Date as NetSuite's N/query date format (M/D/YYYY, no leading zeros).
// Date-granularity is all the record-collection q filter documents. Truncating
// the watermark to its date is what keeps that safe: ON_OR_AFTER the watermark's
// DAY re-includes everything modified earlier that same day, so nothing between
// the watermark's time-of-day and midnight can slip through. The cost is that
// the watermark day is re-pulled every run, which is harmless — the sync is
// idempotent. (NETSUITE_BEFORE_LAST_SYNC_HOURS can widen the window further on
// top of this truncation; unset, this truncation is the only overlap there is.)
function nsQueryDate(d) {
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

// Whether a fetched record really falls inside an explicit window.
//
// It has to be re-checked here because the q filter is date-granular (see
// nsQueryDate): "last 2 hours" can only be asked of NetSuite as the whole day
// (or two) it spans, so the list comes back wider than what was asked for and
// the surplus is dropped once the records — which do carry a full
// lastModifiedDate timestamp — have been expanded.
//
// A record with no readable lastModifiedDate is KEPT rather than dropped: the
// demo feed carries no dates at all, and judging a window by a field that isn't
// there would turn every demo-mode window sync into a silent no-op.
function inWindow(rec, window) {
  const t = Date.parse(rec?.lastModifiedDate ?? "");
  if (!Number.isFinite(t)) return true;
  return t >= window.from.getTime() && t <= window.to.getTime();
}

// How many orders one run will SYNC. (Targeted mode bypasses it — an explicit
// list of orders is the scope.)
const DEFAULT_ORDER_LIMIT = 10;

function orderLimit() {
  return Number(process.env.NETSUITE_ORDER_LIMIT) || DEFAULT_ORDER_LIMIT;
}

// How many order ids a WINDOWED run may list and expand while looking for
// orderLimit() orders inside its window.
//
// It has to be bigger than the order limit, because NetSuite can only be asked
// for whole days: to find the 6 orders modified in the last 2 hours, the run has
// to walk the day's ids and check each one's real timestamp. It also has to be
// BOUNDED, because each id costs an expand call and a second of rate-limit sleep
// — an unbounded scan of a busy day would spend ten minutes to sync six orders.
//
// The default gives the window ten times the limit to find its orders in, with a
// floor for small limits. NETSUITE_WINDOW_SCAN_LIMIT overrides it.
function windowScanLimit(maxOrders) {
  const n = Number(process.env.NETSUITE_WINDOW_SCAN_LIMIT);
  if (Number.isFinite(n) && n > 0) return Math.max(n, maxOrders);
  return Math.max(maxOrders * 10, 200);
}

// Walks listed order ids, expands each one, and keeps the ones that belong to the
// run. Split out of fetchNetsuiteOrders so this — the part with the decisions in
// it — can be tested without a NetSuite account: `expand` is the only thing that
// touches the network, and a test passes its own.
//
// Two things it decides:
//
//   • which records to keep. With a window, the expanded record's real
//     lastModifiedDate is the first place the true timestamp is available (the
//     list call could only be asked for whole days), so the window is applied
//     here and nowhere else.
//
//   • when to stop. Once `keepLimit` records are IN the window there is no
//     reason to keep paying an expand call and a second of sleep for the rest of
//     the day's ids. `scanStoppedAt` says how far it got, which is what tells the
//     caller whether anything was left unexamined.
//
// An expand that throws is collected, not raised: one unreadable order must not
// cost the run the others. The exception is a throw that means "the run was
// stopped" — that is not this order failing, and recording it as one would put a
// row in the log blaming an order for a button someone pressed.
//
// `stopped` is asked before each expand: an optional async predicate, so the real
// caller can hand it the sync's stop flag while a test needs no notion of one.
//
// `onProgress`, if given, is awaited after each ref that was actually scanned —
// kept, outside the window, or errored alike, since "done" here means "looked
// at", the same meaning bumpSyncDone gives it in the write phase. Not called for
// a ref skipped by keepLimit or a stop, which were never looked at.
export async function scanOrders(refs, { window, keepLimit = Infinity, expand, stopped, onProgress }) {
  const items = [];
  const errors = [];
  let outsideWindow = 0;
  let scanned = 0;
  let scanStoppedAt = null;
  let stoppedByHand = false;

  for (const ref of refs) {
    if (!ref?.id) continue;
    if (items.length >= keepLimit) {
      scanStoppedAt = scanned;
      break;
    }
    if (stopped && (await stopped())) {
      stoppedByHand = true;
      scanStoppedAt = scanned;
      break;
    }
    scanned += 1;
    try {
      const full = await expand(ref.id);
      if (window && !inWindow(full, window)) outsideWindow += 1;
      else items.push(full);
    } catch (err) {
      if (err?.syncStopped) {
        stoppedByHand = true;
        scanStoppedAt = scanned;
        break;
      }
      errors.push({ id: ref.id, error: err?.message || String(err) });
    }
    await onProgress?.();
  }
  return { items, errors, outsideWindow, scanned, scanStoppedAt, stopped: stoppedByHand };
}

// Builds the `q` filter expression for the sales-order list call.
// NETSUITE_ORDERS_QUERY, when set, is a raw q expression that overrides the
// automatic incremental window (manual/backfill mode). Otherwise we filter on
// lastModifiedDate between the watermark's DAY and today (see nsQueryDate for
// why the day, not the timestamp), or an initial window on first run
// (NETSUITE_INITIAL_SYNC_DAYS, default 2) when there's no watermark yet.
const DEFAULT_INITIAL_SYNC_DAYS = 2;

function initialSyncDays() {
  const n = Number(process.env.NETSUITE_INITIAL_SYNC_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INITIAL_SYNC_DAYS;
}

// Overlap buffer, in hours, subtracted from the watermark to get the window's
// from date (from = lastSyncedAt - N hours). Only applies when there IS a
// watermark; the first-run window is NETSUITE_INITIAL_SYNC_DAYS' job. Fractional
// values are allowed, so minutes are expressible: 0.5 = 30 min, 0.25 = 15 min.
// Unset/0/invalid = no buffer, i.e. today's behaviour.
//
// Worth knowing before tuning this: the q filter is date-granular (see
// nsQueryDate), so the buffer only changes the query when it pushes the
// watermark back across a UTC midnight. With lastSyncedAt = 10:00 UTC, 2 hours
// still lands on the same day and the emitted q is identical; 11 hours crosses
// into the previous day and widens the window by a full day.
function beforeLastSyncMs() {
  const n = Number(process.env.NETSUITE_BEFORE_LAST_SYNC_HOURS);
  return Number.isFinite(n) && n > 0 ? n * 60 * 60 * 1000 : 0;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function shiftDays(d, days) {
  return new Date(d.getTime() + days * DAY_MS);
}

// NetSuite compares a bare date literal against that date at MIDNIGHT, so
// ON_OR_BEFORE "8/4/2026" means "at or before 8/4 00:00" — the named day's own
// records are EXCLUDED. Measured on this account:
//
//   ON_OR_AFTER 8/4 AND ON_OR_BEFORE 8/4  ->   0 orders
//   ON_OR_AFTER 8/4 AND ON_OR_BEFORE 8/5  ->  96
//   ON_OR_AFTER 8/3 AND ON_OR_BEFORE 8/4  ->  49
//   ON_OR_AFTER 8/3 AND ON_OR_BEFORE 8/5  -> 145   (= 96 + 49, so the buckets
//                                                   partition cleanly)
//
// The top line is the bug this fixes. A window that begins and ends on the same
// UTC day — which is EVERY "last 1/2/6 hours" run, and most 12/24 hour ones —
// emitted exactly that query and NetSuite answered with nothing. The sync looked
// like it worked (no error, an empty run, green log rows) and the range dropdown
// looked like it did nothing at all. The watermark path has the same shape and
// was only spared because the watermark here has never advanced: once it does,
// every run inside the same UTC day would read zero orders.
//
// So the upper bound is the day AFTER `to`. Reading up to a day wider is safe by
// construction: a windowed run re-checks every expanded record against the real
// timestamp (inWindow), and the watermark path is idempotent and already
// re-pulls its own day by truncation.
//
// `lowerMarginDays` pushes the lower bound back, and windowed runs pass 1. That
// is for a different timezone question: NetSuite evaluates these literals in the
// ACCOUNT's timezone, while nsQueryDate names UTC days. If the account sits
// behind UTC, its "8/5" starts some hours after 8/5 00:00Z, and a window opening
// inside that gap would be asked for but never returned. A day of slack makes
// the query a superset of the window whatever the account's offset is, and
// inWindow then cuts it back to exactly what was asked for. The watermark path
// does not take the margin — it has no inWindow to trim the surplus, and
// NETSUITE_BEFORE_LAST_SYNC_HOURS is the knob that exists for widening it.
function dateRangeQuery({ from, to }, lowerMarginDays = 0) {
  const start = lowerMarginDays ? shiftDays(from, -lowerMarginDays) : from;
  return `lastModifiedDate ON_OR_AFTER "${nsQueryDate(start)}" AND lastModifiedDate ON_OR_BEFORE "${nsQueryDate(shiftDays(to, 1))}"`;
}

// The stretch of modification time a scheduled run covers: from the watermark
// (less the overlap buffer) to the moment it runs. No watermark yet — a first
// run for this shop, or one that was reset — falls back to a fixed lookback
// instead of pulling the account's entire history.
function watermarkWindow(since, now) {
  return {
    from: since
      ? new Date(since.getTime() - beforeLastSyncMs())
      : new Date(now.getTime() - initialSyncDays() * 24 * 60 * 60 * 1000),
    to: now,
  };
}

// Exported for its tests: this is where the same-day window bug lived, and the
// only way to see it without an account is to read the string it emits.
export function buildOrdersQuery(since, window) {
  // An explicit window is what an operator just asked for by name ("last 2
  // hours"), so the manual/backfill override does not get to silently replace
  // it — nor does the overlap buffer, which exists to protect the watermark and
  // has no watermark to protect here.
  if (window) return dateRangeQuery(window, 1);
  if (process.env.NETSUITE_ORDERS_QUERY) return process.env.NETSUITE_ORDERS_QUERY;
  return dateRangeQuery(watermarkWindow(since, new Date()));
}

// What a scheduled run starting at `at` would ask NetSuite for, given the
// watermark. Exported for the log page's schedule card, which has to answer
// "which dates will the next run cover" — and answers it by asking the code that
// will really build that query, so the two cannot drift apart.
//
// `query` is what NetSuite is actually sent, and it is worth showing next to
// from/to: the q filter is date-granular (see nsQueryDate), so both ends round
// out to whole days and a run always reads a little wider than its window.
export function plannedOrdersWindow(since, at = new Date()) {
  const window = watermarkWindow(since, at);
  const override = process.env.NETSUITE_ORDERS_QUERY || null;
  return {
    from: window.from,
    to: window.to,
    query: override || dateRangeQuery(window),
    // NETSUITE_ORDERS_QUERY replaces the window outright, so when it is set the
    // from/to above are not what the run will really read.
    override: Boolean(override),
  };
}

// ---------------------------------------------------------------------------
// Targeted mode (NETSUITE_ORDER_IDS)
// ---------------------------------------------------------------------------
// A comma-separated list of sales orders to sync, given as either a document
// number ("SO20742", "20742") or a raw internal id ("20249"). When set, the
// date window and NETSUITE_ORDER_LIMIT are both bypassed and ONLY these orders
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
        `/salesorder?q=${encodeURIComponent(`tranId IS "${safe}"`)}&limit=5`,
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
      await nsGet(shop, `/salesorder/${raw}`);
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
    await nsGet(shop, `/salesorder/${raw}`);
    return { id: raw, via: `internalId ${raw} (known)` };
  } catch (err) {
    if (err?.syncStopped) throw err;
    console.warn(`[netsuite] known internal id ${raw} no longer resolves, falling back to a tranId search:`, err?.message);
    return resolveOrderId(shop, raw);
  }
}

// Fetches sales orders from NetSuite. The list endpoint returns { items:
// [{ id, links }], hasMore, ... } with only ids, so we page through it and then
// expand each id into the full record. `since` (the sync watermark) drives the
// incremental lastModifiedDate window — see buildOrdersQuery.
// `window` ({ from, to }) is the other way to scope a run: an explicit stretch of
// modification time, asked for from the log page's "Sync now" control. It replaces
// the watermark window rather than narrowing it, and it is re-applied exactly after
// the records are expanded — see inWindow.
export async function fetchNetsuiteOrders(shop, { since, ids, window, knownInternalIds } = {}) {
  const items = [];
  const errors = [];
  let refs;
  // Set when NETSUITE_ORDER_LIMIT left matching orders unfetched — see the note
  // where it's assigned.
  let capped = null;
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
    await setSyncTotal(shop, targeted.length, 0, "fetching");
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
      await bumpSyncDone(shop);
    }
    // Two identifiers can point at the same order (e.g. "SO20742" and "20742").
    const seen = new Set();
    refs = refs.filter((r) => !seen.has(r.id) && seen.add(r.id));
  } else {
    const q = buildOrdersQuery(since, window);
    // NETSUITE_ORDER_LIMIT is the cap on how many orders one run will process,
    // NOT the page size. The list endpoint returns at most PAGE_SIZE ids per
    // call along with hasMore/offset/totalResults; those were previously
    // ignored, so a window matching more than the limit was silently truncated
    // and the surplus orders were never synced at all.
    const maxOrders = orderLimit();
    // How many ids to LIST. Without a window these are the same number: every
    // listed order is an order to sync. With one they are not, and that was a
    // bug: the q filter is date-granular, so a "last 2 hours" window lists a
    // whole day, and listing exactly maxOrders of them meant the cap fell on the
    // first 50 ids of the DAY — orders that mostly aren't in the window, while
    // the ones that are sat unlisted behind them. The window could then sync
    // nothing at all and look like NetSuite had no recent changes. So a windowed
    // run lists further ahead and lets the window decide what counts.
    const maxRefs = window ? windowScanLimit(maxOrders) : maxOrders;
    // SuiteTalk REST rejects a page whose offset is not divisible by its limit
    // ("Invalid limit and offset values. The offset 20 must be divisible by the
    // limit 3"), so the page size has to stay CONSTANT for the whole loop —
    // shrinking the last request to fit the remaining cap is what triggers that
    // 400. Any surplus is trimmed after the loop instead.
    const pageSize = Math.min(1000, Math.max(1, maxOrders)); // 1000 = REST maximum

    refs = [];
    let offset = 0;
    let totalResults = null;
    for (;;) {
      const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
      if (q) params.set("q", q);
      let list;
      try {
        list = await nsGet(shop, `/salesorder?${params.toString()}`);
      } catch (err) {
        // A page abandoned because of a stop is not a listing failure — the run
        // is over either way, and raising here would report it as NetSuite being
        // unreachable.
        if (!err?.syncStopped) throw err;
        stopped = true;
        break;
      }
      const page = Array.isArray(list?.items) ? list.items : [];
      if (totalResults === null) totalResults = list?.totalResults ?? null;
      refs.push(...page);
      if (!list?.hasMore || !page.length || refs.length >= maxRefs) break;
      offset += pageSize;
      // Listing is pure reading — no Shopify order exists yet and no watermark
      // has moved — so every page boundary is a safe place to stop, and stopping
      // here saves the expand pass that would have followed.
      if (!(await sleep(shop, 500))) {
        stopped = true;
        console.warn(`[netsuite] ${shop}: order listing stopped by hand after ${refs.length} id(s).`);
        break;
      }
    }
    // A full page can overshoot; keep the first maxRefs.
    if (refs.length > maxRefs) refs = refs.slice(0, maxRefs);

    console.log(
      `[netsuite] q=${q} matched ${totalResults ?? refs.length} order(s); listed ${refs.length}.`,
    );
    // Never let a cap truncate silently — a run that skips orders has to say so,
    // otherwise the log reads as "everything is in sync" when it is not. The
    // warning alone was not enough: it goes to a console nobody reads on a cron
    // box, and the caller had no way to know, so it advanced the watermark past
    // orders it never fetched and they were skipped for good. It is reported back
    // now and the watermark stays put (see runOrderSync).
    // A listing cut short by Stop sync is skipped here on purpose: it did leave
    // orders unlisted, but not because a limit was too low, and telling someone
    // to raise NETSUITE_ORDER_LIMIT because they pressed Stop is worse than
    // saying nothing. The stop is reported on its own terms instead — the run
    // ends as stopped, and its watermark stays put for that reason.
    if (!stopped && totalResults != null && totalResults > refs.length) {
      // Which limit stopped the listing decides which one to name — telling
      // someone to raise NETSUITE_ORDER_LIMIT when it was the scan ceiling that
      // ran out sends them to the wrong knob.
      const which = window ? "NETSUITE_WINDOW_SCAN_LIMIT" : "NETSUITE_ORDER_LIMIT";
      capped = {
        limit: maxRefs,
        matched: totalResults,
        fetched: refs.length,
        skipped: totalResults - refs.length,
        reason: `${which} stopped the listing`,
      };
      console.warn(
        `[netsuite] ${which}=${maxRefs} capped this run: ${capped.skipped} matching order(s) were never listed. Raise it or narrow the window.`,
      );
    }
  }

  // "fetching" phase progress for the expand pass about to start: refs.length
  // records, each costing a round trip and a second of rate-limit sleep — the
  // part of a run that actually takes the time. Overwrites whatever total the
  // branch above reported (a targeted list's id count, or nothing yet for a
  // windowed listing): same phase, moving from "how many identifiers" to "how
  // many records to expand". Skipped once already stopped — the run is ending,
  // there is nothing left to report progress on.
  if (!stopped) await setSyncTotal(shop, refs.length, 0, "fetching");

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
    onProgress: () => bumpSyncDone(shop),
    // Without a window every listed order is one to sync, and the list call was
    // already capped at that number.
    keepLimit: window ? orderLimit() : Infinity,
    expand: async (id) => {
      // Without expandSubResources, SuiteTalk REST returns sublists (e.g.
      // "item") as a bare link reference instead of inline line data, which
      // left mapNetsuiteOrder() with an empty lineItems array.
      const full = await nsGet(shop, `/salesorder/${id}?expandSubResources=true`);
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
  const { outsideWindow, scanned, scanStoppedAt } = scan;

  if (window) {
    console.log(
      `[netsuite] window ${window.from.toISOString()} → ${window.to.toISOString()}: scanned ${scanned} listed order(s), kept ${items.length}, ${outsideWindow} were modified outside it.`,
    );
    // The scan hit the order limit with ids still unexamined, so there may be
    // more orders in this window than were synced. Reported like any other cap:
    // the watermark stays put and the log says so, rather than the run looking
    // complete.
    if (!capped && !stopped && scanStoppedAt !== null && scanStoppedAt < refs.length) {
      capped = {
        limit: orderLimit(),
        matched: refs.length,
        fetched: items.length,
        skipped: refs.length - scanStoppedAt,
        reason: "window scan reached NETSUITE_ORDER_LIMIT",
      };
      console.warn(
        `[netsuite] NETSUITE_ORDER_LIMIT=${capped.limit} reached inside the window: ${capped.skipped} listed order(s) were never examined.`,
      );
    }
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
    rows.push(...await nsSuiteQl(
      shop,
      `SELECT DISTINCT tl.createdfrom AS orderid, inv.id, inv.tranid, inv.status,
              BUILTIN.DF(inv.status) AS statuslabel
         FROM transactionline tl
         JOIN transaction inv ON inv.id = tl.transaction
        WHERE tl.createdfrom IN (${batch.join(",")}) AND inv.type = 'CustInvc'`,
    ));
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
    rows.push(...await nsSuiteQl(
      shop,
      `SELECT id, email FROM customer WHERE id IN (${batch.join(",")}) AND email IS NOT NULL`,
    ));
  }

  const map = {};
  for (const r of rows) {
    const email = String(r.email ?? "").trim();
    if (email) map[String(r.id)] = email;
  }
  return map;
}

// Fetches tracking numbers for each sales order via its ItemFulfillment
// records. Returns a map of { orderId: "TRACK1, TRACK2" }.
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
//
// Verified against the account: 2741 tracking numbers across 1442 of the 25815
// ItemShip records, so most fulfillments legitimately have none — an order
// coming back without tracking is normal, not a lookup failure.
//
// transactionline holds one row per fulfillment LINE, so the same tracking
// number repeats per line; DISTINCT plus the Set below collapse that.
async function fetchTrackingForOrders(shop, orderIds) {
  const ids = orderIds.map((id) => String(id)).filter((id) => /^\d+$/.test(id));
  if (!ids.length) return {};

  const rows = [];
  for (const batch of chunkIds(ids)) {
    rows.push(...await nsSuiteQl(
      shop,
      `SELECT DISTINCT tl.createdfrom AS orderid, n.trackingnumber
         FROM transactionline tl
         JOIN transaction f ON f.id = tl.transaction AND f.type = 'ItemShip'
         JOIN trackingnumbermap m ON m.transaction = f.id
         JOIN trackingnumber n ON n.id = m.trackingnumber
        WHERE tl.createdfrom IN (${batch.join(",")})`,
    ));
  }

  // The Set per order already collapses duplicates across pages/batches.
  const grouped = {};
  for (const r of rows) {
    const tn = String(r.trackingnumber ?? "").trim();
    if (!tn) continue;
    (grouped[String(r.orderid)] ||= new Set()).add(tn);
  }
  return Object.fromEntries(
    Object.entries(grouped).map(([orderId, set]) => [orderId, [...set].join(", ")]),
  );
}
