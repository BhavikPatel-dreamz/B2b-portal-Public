import { getValidAccessToken } from "./netsuite-oauth.server.js";

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Low-level GET against a SuiteTalk REST path (e.g. "/salesorder/1504" or
// "/salesorder?limit=100"). Returns the parsed JSON body.
// Retries up to 4 times on 429 with exponential back-off (3s, 6s, 12s, 24s).
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
      await sleep(delay);
      continue;
    }
    if (res.status === 429) {
      if (attempt === maxRetries) {
        const text = await res.text().catch(() => "");
        throw new Error(`NetSuite GET ${path} failed: ${res.status} ${text}`);
      }
      const delay = 3000 * Math.pow(2, attempt);
      console.warn(`[netsuite] 429 on ${path}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
      await sleep(delay);
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
    await sleep(300);
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

function buildOrdersQuery(since) {
  if (process.env.NETSUITE_ORDERS_QUERY) return process.env.NETSUITE_ORDERS_QUERY;
  const now = new Date();
  // No watermark yet (first run for this shop, or it was reset) — fall back to
  // a fixed lookback window instead of pulling the account's entire history.
  const from = since
    ? new Date(since.getTime() - beforeLastSyncMs())
    : new Date(now.getTime() - initialSyncDays() * 24 * 60 * 60 * 1000);
  return `lastModifiedDate ON_OR_AFTER "${nsQueryDate(from)}" AND lastModifiedDate ON_OR_BEFORE "${nsQueryDate(now)}"`;
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
      console.warn(`[netsuite] tranId lookup "${safe}" failed:`, err?.message);
    }
    await sleep(400);
  }

  if (/^\d+$/.test(raw)) {
    try {
      await nsGet(shop, `/salesorder/${raw}`);
      return { id: raw, via: `internalId ${raw}` };
    } catch (err) {
      console.warn(`[netsuite] internalId ${raw} lookup failed:`, err?.message);
    }
  }
  return { id: null };
}

// Fetches sales orders from NetSuite. The list endpoint returns { items:
// [{ id, links }], hasMore, ... } with only ids, so we page through it and then
// expand each id into the full record. `since` (the sync watermark) drives the
// incremental lastModifiedDate window — see buildOrdersQuery.
export async function fetchNetsuiteOrders(shop, { since } = {}) {
  const items = [];
  const errors = [];
  let refs;
  // Set when NETSUITE_ORDER_LIMIT left matching orders unfetched — see the note
  // where it's assigned.
  let capped = null;

  const targeted = targetedOrderIds();
  if (targeted.length) {
    // Targeted mode: resolve each configured identifier to an internal id and
    // skip the list call entirely. No date window, no limit.
    console.log(`[netsuite] NETSUITE_ORDER_IDS set — syncing only: ${targeted.join(", ")}`);
    refs = [];
    for (const raw of targeted) {
      const { id, via } = await resolveOrderId(shop, raw);
      if (id) {
        console.log(`[netsuite] resolved "${raw}" -> internal id ${id} (${via})`);
        refs.push({ id });
      } else {
        console.error(`[netsuite] could not resolve "${raw}" to a sales order`);
        errors.push({ id: raw, error: `NETSUITE_ORDER_IDS: "${raw}" did not match any sales order` });
      }
    }
    // Two identifiers can point at the same order (e.g. "SO20742" and "20742").
    const seen = new Set();
    refs = refs.filter((r) => !seen.has(r.id) && seen.add(r.id));
  } else {
    const q = buildOrdersQuery(since);
    // NETSUITE_ORDER_LIMIT is the cap on how many orders one run will process,
    // NOT the page size. The list endpoint returns at most PAGE_SIZE ids per
    // call along with hasMore/offset/totalResults; those were previously
    // ignored, so a window matching more than the limit was silently truncated
    // and the surplus orders were never synced at all.
    const maxOrders = Number(process.env.NETSUITE_ORDER_LIMIT) || 10;
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
      const list = await nsGet(shop, `/salesorder?${params.toString()}`);
      const page = Array.isArray(list?.items) ? list.items : [];
      if (totalResults === null) totalResults = list?.totalResults ?? null;
      refs.push(...page);
      if (!list?.hasMore || !page.length || refs.length >= maxOrders) break;
      offset += pageSize;
      await sleep(500);
    }
    // A full page can overshoot the cap; keep the first maxOrders.
    if (refs.length > maxOrders) refs = refs.slice(0, maxOrders);

    console.log(
      `[netsuite] q=${q} matched ${totalResults ?? refs.length} order(s); fetched ${refs.length}.`,
    );
    // Never let a cap truncate silently — a run that skips orders has to say so,
    // otherwise the log reads as "everything is in sync" when it is not. The
    // warning alone was not enough: it goes to a console nobody reads on a cron
    // box, and the caller had no way to know, so it advanced the watermark past
    // orders it never fetched and they were skipped for good. It is reported back
    // now and the watermark stays put (see runOrderSync).
    if (totalResults != null && totalResults > refs.length) {
      capped = {
        limit: maxOrders,
        matched: totalResults,
        fetched: refs.length,
        skipped: totalResults - refs.length,
      };
      console.warn(
        `[netsuite] NETSUITE_ORDER_LIMIT=${maxOrders} capped this run: ${capped.skipped} matching order(s) were NOT synced. Raise the limit or narrow the window.`,
      );
    }
  }

  let dumped = false;
  for (const ref of refs) {
    if (!ref?.id) continue;
    try {
      // Without expandSubResources, SuiteTalk REST returns sublists (e.g.
      // "item") as a bare link reference instead of inline line data, which
      // left mapNetsuiteOrder() with an empty lineItems array.
      const full = await nsGet(shop, `/salesorder/${ref.id}?expandSubResources=true`);
      // Diagnostic: dump the full expanded record for the FIRST order of each
      // run so the account's real field shape stays visible without flooding
      // the logs when a window spans many orders.
      if (!dumped) {
        console.log(`[netsuite] sample record ${ref.id}:`, JSON.stringify(full));
        dumped = true;
      }
      if (!(full?.item?.items?.length > 0)) {
        console.warn(
          `[netsuite] order ${ref.id}: no inline line items — "item" was:`,
          JSON.stringify(full?.item),
        );
      }
      items.push(full);
      await sleep(1000);
    } catch (err) {
      const message = err?.message || String(err);
      console.error(`[netsuite] expand order ${ref.id} failed:`, message);
      errors.push({ id: ref.id, error: message });
    }
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

  return { items, errors, capped };
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
