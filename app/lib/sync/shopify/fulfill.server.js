import { skuKey } from "../sku.js";
import { carrierName, trackingInfoFor } from "./carriers.js";
import { gqlError } from "./gql.js";

// One Shopify fulfillment per NetSuite shipment
// ---------------------------------------------------------------------------
// A NetSuite order does not ship as one parcel with one number. SO 300777 left
// the warehouse as four item fulfillments — 3x TSK4A under 875373500692, one
// 721520LEC under 875374098216, and so on — and until now all of that arrived in
// Shopify as one comma-joined string sprayed across whatever fulfillments
// happened to exist, so nothing said which number covered which item.
//
// This module rebuilds that shape on the Shopify side: each NetSuite shipment
// becomes a fulfillment carrying the LINES it actually contained and only its
// own tracking number and carrier. Which is also what the customer sees —
// "FedEx Ground® tracking: 875373500692" over the items in that box.
//
// Matching is by SKU, the same key the order's own lines were linked by
// (resolveVariantsBySku): the NetSuite item name is the SKU on this account, and
// a line that never matched a variant was created with that name as its sku, so
// both linked and custom lines are reachable the same way.

// How much of each connection is asked for at a time. Both are Shopify's own
// ceiling for a page, so a first call reaches as far as one call can and the
// paging below is only ever entered by an order that genuinely runs past it.
export const PAGE = 50;
export const LINE_PAGE = 250;

// The order's fulfillment orders, with enough of each line to match it to a
// NetSuite shipment item. `lineItem { sku }` rather than the fulfillment order
// line's own fields: the sku is what the NetSuite item name is compared against,
// and it lives on the order line.
export async function fetchFulfillmentOrders(admin, orderId) {
  const connection = await fetchFulfillmentOrderPage(admin, orderId, null);
  return completeFulfillmentOrders(admin, orderId, connection);
}

async function fetchFulfillmentOrderPage(admin, orderId, after) {
  const resp = await admin.graphql(
    `#graphql
    query OrderFulfillmentOrders($id: ID!, $first: Int!, $lines: Int!, $after: String) {
      order(id: $id) {
        id
        fulfillmentOrders(first: $first, after: $after) {
          nodes {
            id
            status
            lineItems(first: $lines) {
              nodes { id remainingQuantity lineItem { id sku name } }
              pageInfo { hasNextPage endCursor }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`,
    { variables: { id: orderId, first: PAGE, lines: LINE_PAGE, after } },
  );
  const body = await resp.json();
  if (body?.errors?.length) throw new Error(gqlError(body, []));
  return body?.data?.order?.fulfillmentOrders || null;
}

// Every fulfillment order on the order and every line on each of them, followed
// past the first page.
//
// A truncated read is not a smaller answer here, it is a wrong one: a line that
// did not come back is a line the pool never held, so the NetSuite shipment that
// carried it matched nothing, came back as "items not open in Shopify" and had
// its tracking number dropped — silently, and on the biggest orders on the
// account. The extra calls are made only by the orders that actually overflow a
// page; everything else pays one query as before.
export async function completeFulfillmentOrders(admin, orderId, connection) {
  const nodes = [...(connection?.nodes || [])];
  let pageInfo = connection?.pageInfo;
  while (pageInfo?.hasNextPage) {
    const page = await fetchFulfillmentOrderPage(admin, orderId, pageInfo.endCursor);
    nodes.push(...(page?.nodes || []));
    pageInfo = page?.pageInfo;
  }
  for (const fo of nodes) await completeLineItems(admin, fo);
  return nodes;
}

async function completeLineItems(admin, fulfillmentOrder) {
  let pageInfo = fulfillmentOrder.lineItems?.pageInfo;
  while (pageInfo?.hasNextPage) {
    const resp = await admin.graphql(
      `#graphql
      query FulfillmentOrderLines($id: ID!, $first: Int!, $after: String) {
        fulfillmentOrder(id: $id) {
          lineItems(first: $first, after: $after) {
            nodes { id remainingQuantity lineItem { id sku name } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { variables: { id: fulfillmentOrder.id, first: LINE_PAGE, after: pageInfo.endCursor } },
    );
    const body = await resp.json();
    if (body?.errors?.length) throw new Error(gqlError(body, []));
    const page = body?.data?.fulfillmentOrder?.lineItems;
    fulfillmentOrder.lineItems.nodes.push(...(page?.nodes || []));
    pageInfo = page?.pageInfo;
  }
}

const OPEN_STATUSES = ["OPEN", "IN_PROGRESS", "SCHEDULED"];

// The pool of Shopify quantities still waiting to be fulfilled, keyed by sku.
// Mutable on purpose: shipments are planned one after another and each takes
// what it needs out of the pool, so two shipments of the same item can never be
// handed the same unit twice.
export function openLinePool(fulfillmentOrders) {
  const pool = [];
  for (const fo of fulfillmentOrders || []) {
    if (!OPEN_STATUSES.includes(fo.status)) continue;
    for (const li of fo.lineItems?.nodes || []) {
      const remaining = li.remainingQuantity ?? 0;
      if (remaining <= 0) continue;
      pool.push({
        fulfillmentOrderId: fo.id,
        id: li.id,
        remaining,
        key: skuKey(li.lineItem?.sku || li.lineItem?.name || ""),
      });
    }
  }
  return pool;
}

// Takes `quantity` units of `sku` out of the pool, across as many lines as it
// needs. Returns what it got — fewer units than asked for when Shopify's order
// simply doesn't have them, which is normal: a NetSuite shipment can cover an
// item the Shopify order never carried.
function take(pool, sku, quantity) {
  const key = skuKey(sku);
  const taken = [];
  let left = quantity;
  for (const line of pool) {
    if (left <= 0) break;
    if (line.key !== key || line.remaining <= 0) continue;
    const n = Math.min(line.remaining, left);
    line.remaining -= n;
    left -= n;
    taken.push({ fulfillmentOrderId: line.fulfillmentOrderId, id: line.id, quantity: n });
  }
  return taken;
}

// Groups the taken lines into fulfillmentCreate's lineItemsByFulfillmentOrder
// shape. One group per fulfillment order, and the caller writes one fulfillment
// per group: fulfillmentCreate can only span fulfillment orders that share a
// location, and reading a fulfillment order's location needs the read_locations
// scope this app is not granted (see openFulfillmentOrderGroups). One per group
// satisfies the rule without asking.
export function groupByFulfillmentOrder(taken) {
  const byFo = new Map();
  for (const t of taken) {
    const lines = byFo.get(t.fulfillmentOrderId) || [];
    lines.push({ id: t.id, quantity: t.quantity });
    byFo.set(t.fulfillmentOrderId, lines);
  }
  return [...byFo.entries()].map(([fulfillmentOrderId, fulfillmentOrderLineItems]) => (
    [{ fulfillmentOrderId, fulfillmentOrderLineItems }]
  ));
}

// What to write to Shopify for this order's shipments, worked out before
// anything is written: a list of fulfillments (line items + trackingInfo), plus
// what could not be placed.
//
// `remainder` is set when NetSuite reports the order shipped but lines are still
// open in Shopify after every shipment has taken its own — an item NetSuite
// shipped under a name no Shopify line carries, or a shipment NetSuite recorded
// with no item lines at all. It is fulfilled without tracking rather than left
// behind, so the Shopify order still ends up in the state NetSuite says it is in.
export function planShipmentFulfillments(shipments, fulfillmentOrders, { fulfillRemainder = false } = {}) {
  const pool = openLinePool(fulfillmentOrders);
  const plans = [];
  const unplaced = [];

  for (const shipment of shipments || []) {
    const taken = [];
    const missing = [];
    for (const item of shipment.items || []) {
      const got = take(pool, item.sku, item.quantity);
      const count = got.reduce((sum, g) => sum + g.quantity, 0);
      taken.push(...got);
      if (count < item.quantity) missing.push(`${item.sku} x${item.quantity - count}`);
    }
    if (!taken.length) {
      // Nothing of this shipment is open in Shopify — already fulfilled by an
      // earlier run, or items this Shopify order never had. Its tracking numbers
      // are reported so the caller can say so rather than lose them silently.
      unplaced.push({ shipment, reason: (shipment.items || []).length ? "items not open in Shopify" : "NetSuite shipment has no item lines" });
      continue;
    }
    for (const lineItemsByFulfillmentOrder of groupByFulfillmentOrder(taken)) {
      plans.push({
        shipment,
        lineItemsByFulfillmentOrder,
        trackingInfo: trackingInfoFor(shipment.trackingNumbers, shipment),
        ...(missing.length ? { partial: missing.join(", ") } : {}),
      });
    }
  }

  const leftover = pool.filter((l) => l.remaining > 0);
  const remainder = fulfillRemainder && leftover.length
    ? groupByFulfillmentOrder(leftover.map((l) => ({ ...l, quantity: l.remaining })))
      .map((lineItemsByFulfillmentOrder) => ({ shipment: null, lineItemsByFulfillmentOrder, trackingInfo: null }))
    : [];

  return { plans, unplaced, remainder, leftover: leftover.length };
}

export async function createFulfillment(admin, lineItemsByFulfillmentOrder, trackingInfo) {
  const resp = await admin.graphql(
    `#graphql
    mutation FulfillmentCreate($fulfillment: FulfillmentInput!) {
      fulfillmentCreate(fulfillment: $fulfillment) {
        fulfillment { id trackingInfo { company number url } }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        fulfillment: {
          lineItemsByFulfillmentOrder,
          ...(trackingInfo ? { trackingInfo } : {}),
          notifyCustomer: false,
        },
      },
    },
  );
  const body = await resp.json();
  const payload = body?.data?.fulfillmentCreate;
  const errors = payload?.userErrors || [];
  if (errors.length || !payload?.fulfillment) throw new Error(gqlError(body, errors));
  return payload.fulfillment;
}

// Writes the planned fulfillments. Each one is attempted on its own: a shipment
// Shopify rejects must not cost the order the other three that would have gone
// through, and a fulfillment that fails is reported next to the ones that did
// not. Throws only when EVERY write failed, which is the case the caller can
// still fall back from (see syncTracking).
export async function writeShipmentFulfillments(admin, plan) {
  const all = [...plan.plans, ...plan.remainder];
  const created = [];
  const failed = [];
  for (const p of all) {
    const numbers = p.shipment?.trackingNumbers || [];
    const label = p.shipment
      ? `NetSuite fulfillment ${p.shipment.netsuiteId}`
      : "remaining items (no NetSuite shipment)";
    try {
      const fulfillment = await createFulfillment(admin, p.lineItemsByFulfillmentOrder, p.trackingInfo);
      created.push({
        id: fulfillment.id,
        netsuiteFulfillment: p.shipment?.netsuiteId || null,
        lines: p.lineItemsByFulfillmentOrder[0].fulfillmentOrderLineItems.reduce((sum, l) => sum + l.quantity, 0),
        numbers,
        company: fulfillment.trackingInfo?.[0]?.company || p.trackingInfo?.company || null,
        url: fulfillment.trackingInfo?.[0]?.url || null,
        created: true,
        ...(p.partial ? { partial: p.partial } : {}),
      });
    } catch (err) {
      failed.push(`${label}: ${err?.message || String(err)}`);
    }
  }
  if (!created.length && failed.length) throw new Error(failed.join("; "));
  return { created, failed };
}

// The order's shipments as one line each, for the netsuite_shipments custom
// attribute: what shipped, under which number, with whom and when. Shopify's own
// fulfillments carry the same numbers as clickable links; this states them per
// NetSuite fulfillment on the order itself, so the breakdown survives even on
// the orders where the fulfillment write is not available (no open fulfillment
// order, missing scopes, SYNC_FULFILLMENT_CREATE=false).
//
// No tracking URLs in here. They are what makes the fulfillment's number a link
// and they belong there; repeating them would triple the length of a value that
// is capped for a reason — this attribute goes out with orderCreate, and a value
// Shopify rejects would cost the whole order, not just the summary.
const SHIPMENT_SUMMARY_MAX = 250;

export function shipmentSummary(entry) {
  const lines = (entry.shipments || []).map((s) => {
    const company = carrierName(s.shipMethod, s.carrier);
    const items = (s.items || []).map((i) => `${i.sku} x${i.quantity}`).join(", ");
    return [
      s.trackingNumbers?.length ? s.trackingNumbers.join(" ") : "no tracking number",
      company,
      s.shipDate,
      items || null,
    ].filter(Boolean).join(" · ");
  });
  if (!lines.length) return null;
  const summary = lines.join(" | ");
  if (summary.length <= SHIPMENT_SUMMARY_MAX) return summary;

  // Whole lines only — half a tracking number is worse than a shipment count —
  // and the "+N more" that replaces the dropped ones is counted against the cap
  // as it is built, not tacked on over the top of it afterwards.
  const kept = [];
  let length = 0;
  for (const line of lines) {
    const more = ` | +${lines.length - kept.length - 1} more shipment(s)`.length;
    const separator = kept.length ? 3 : 0;
    if (length + separator + line.length + more > SHIPMENT_SUMMARY_MAX) break;
    kept.push(line);
    length += separator + line.length;
  }
  const dropped = lines.length - kept.length;
  if (!kept.length) return `${dropped} shipment(s)`;
  return `${kept.join(" | ")} | +${dropped} more shipment(s)`;
}
