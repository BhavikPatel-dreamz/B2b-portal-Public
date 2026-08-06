import { extTag } from "../ext-tag.js";
import { trackingInfoFor } from "./carriers.js";
import { findOrderIdByExternalId } from "./common.server.js";
import { gqlError } from "./gql.js";
import {
  LINE_PAGE,
  PAGE,
  completeFulfillmentOrders,
  groupByFulfillmentOrder,
  openLinePool,
  planShipmentFulfillments,
  shipmentSummary,
  writeShipmentFulfillments,
} from "./fulfill.server.js";

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
export async function syncTracking(admin, entry, orderId, via) {
  const numbers = trackingNumbers(entry.tracking);
  // What NetSuite's shipment side of this order looks like, as the sync log
  // sees it. Named for NetSuite rather than plainly (`fulfillments`) because
  // the success paths below return the SHOPIFY fulfillments they wrote under
  // that key, and one silently overwriting the other is exactly the kind of
  // log that reads fine and says the wrong thing.
  const shipment = {
    // Log-only from here down: ship date/status/weight have no native Shopify
    // fulfillment field to land on — they're written as custom attributes below
    // instead, and ride along here just so the sync log shows them next to the
    // tracking numbers they describe. (The carrier IS sent to Shopify now, but
    // per shipment rather than per order — see carriers.js.)
    //
    // Two ship methods, because they answer different questions: the sales
    // order's is what the customer ASKED for, the fulfillment's is what
    // actually carried the goods, and they do not always agree.
    shipMethod: entry.shipMethod || null,
    shippedVia: entry.trackingShipMethod || null,
    shipmentDate: entry.trackingShipDate || null,
    shipmentStatus: entry.trackingStatus || null,
    packageWeight: entry.trackingPackageWeight ?? null,
    netsuiteFulfillments: entry.trackingFulfillments || 0,
    netsuiteTrackingNumbers: numbers.length,
  };
  const base = {
    action: "tracking", id: orderId, matchedBy: via, netsuiteId: entry.externalId,
    ...shipment,
  };

  // An order can need work with no tracking at all: NetSuite reports it as
  // shipped while Shopify still shows it unfulfilled. That is the common case
  // here, not an edge case — this account records tracking numbers on only
  // 1454 of its 25978 fulfillments. Bail out only when there is neither
  // tracking to write nor a fulfillment state to correct.
  const shipped = entry.fulfillmentStatus === "FULFILLED"
    || entry.fulfillmentStatus === "PARTIALLY_FULFILLED";
  if (!numbers.length && !shipped) {
    return { ...base, ok: true, skipped: true, reason: noTrackingReason(entry) };
  }

  const ctx = await fetchTrackingContext(admin, orderId);
  if (!ctx) return { ...base, ok: false, error: "order disappeared between match and update" };

  // Ship date/status/weight land as custom attributes regardless of which path
  // below ends up carrying the tracking NUMBER itself — there's no
  // trackingInfo-shaped field for any of them to ride on instead. Best-effort:
  // a failure here is a warning, not a reason to fail the tracking sync that
  // triggered it. On success, ctx.customAttributes is updated in place so a
  // later write in this same call (the netsuite_tracking fallback below)
  // starts from what was just written — orderUpdate replaces the whole
  // attribute set, so working from a stale snapshot would silently undo this.
  const detailPairs = [
    ["netsuite_shipped_date", entry.trackingShipDate],
    ["netsuite_shipment_status", entry.trackingStatus],
    ["netsuite_shipped_via", entry.trackingShipMethod],
    ["netsuite_package_weight", entry.trackingPackageWeight != null ? String(entry.trackingPackageWeight) : null],
    ["netsuite_shipments", shipmentSummary(entry)],
  ].filter(([, v]) => v != null && v !== "");
  if (detailPairs.length && attributesDiffer(ctx.customAttributes, detailPairs)) {
    try {
      const result = await writeCustomAttributePairs(admin, orderId, ctx.customAttributes, detailPairs);
      if (result.ok) ctx.customAttributes = result.customAttributes;
      else console.warn(`[order-sync] ${entry.externalId}: writing shipment detail attributes failed: ${result.error}`);
    } catch (err) {
      console.warn(`[order-sync] ${entry.externalId}: writing shipment detail attributes failed: ${err?.message || String(err)}`);
    }
  }

  const fulfillments = (ctx.fulfillments || []).filter((f) => f.status !== "CANCELLED");
  const allowCreate = process.env.SYNC_FULFILLMENT_CREATE !== "false";
  // Set below, and read by the netsuite_tracking fallback after the block: why
  // the numbers ended up on the order itself rather than on a fulfillment. It
  // starts as the case that gets there without passing through the reasoning —
  // an order with neither a fulfillment nor anything open to make one from.
  let notFulfilled = "no fulfillment or open fulfillment order on the Shopify order";
  try {
    // Item-wise first, and BEFORE the fulfillments the order already has are
    // touched: which of NetSuite's shipments still have open lines here decides
    // both what is written now and which numbers are left over for those
    // fulfillments.
    //
    // The order matters because an order that ships in parts arrives here with
    // work on both sides. This used to return on the first existing fulfillment
    // it found, which meant the second run of a two-shipment order never
    // fulfilled the second shipment's lines and wrote its number onto the first
    // shipment's parcel instead — the one thing the item-wise path exists to
    // prevent.
    //
    // Creating a fulfillment is a real state change (items become fulfilled,
    // stock is drawn from the location), so SYNC_FULFILLMENT_CREATE=false skips
    // it: the sync is then restricted to updating what Shopify has already
    // fulfilled, and everything else falls through to the netsuite_tracking
    // attribute.
    const written = allowCreate ? await fulfilByShipment(admin, entry, ctx) : null;

    // What did not go out on a fulfillment written just now. With shipment
    // detail those are the shipments whose lines are no longer open here — an
    // earlier run already fulfilled them — and without it, every number the
    // order has.
    const leftover = written ? numbers.filter((n) => !written.placed.has(n)) : numbers;
    const updated = fulfillments.length && leftover.length
      ? await updateExistingTracking(admin, entry, fulfillments, leftover, written?.unplacedShipments)
      : [];

    if (written && updated.length) {
      return {
        ...base,
        ok: true,
        name: ctx.name,
        ...written.log,
        via: `${written.log.via} + fulfillmentTrackingInfoUpdate`,
        fulfillments: [...(written.log.fulfillments || []), ...updated],
        tracking: numbers.join(", ") || null,
      };
    }
    if (written) return { ...base, ok: true, name: ctx.name, ...written.log };
    if (updated.length) {
      return { ...base, ok: true, name: ctx.name, via: "fulfillmentTrackingInfoUpdate", fulfillments: updated, tracking: leftover.join(", ") };
    }

    // Fulfilled here, and everything NetSuite shipped is already on it.
    if (fulfillments.length) {
      return {
        ...base,
        ok: true,
        skipped: true,
        name: ctx.name,
        ...(numbers.length ? { tracking: numbers.join(", ") } : {}),
        reason: numbers.length
          ? "tracking already up to date"
          : `already fulfilled in Shopify (${fulfillments.length}); ${noTrackingReason(entry)}`,
      };
    }

    // Nothing fulfilled here and nothing NetSuite shipped could be tied to this
    // order's lines — the numbers are split flat across whatever is still open.
    //
    // Not on a part-shipped order, though. This path fulfils EVERY open line,
    // and on a PARTIALLY_FULFILLED order the open lines are lines that genuinely
    // have not shipped: closing them tells the customer their whole order is on
    // its way when NetSuite says half of it is still in the warehouse. The
    // item-wise path refuses the same thing for the same reason (fulfillRemainder
    // in planShipmentFulfillments), and orderCreate records a part-shipped order
    // as PARTIAL rather than closing it — this was the one place that overstated
    // it. With no shipment detail there is nothing to say WHICH lines went, so
    // the numbers go on the order as an attribute instead of onto a fulfillment
    // that claims more than NetSuite does.
    const open = openFulfillmentOrderGroups(ctx.fulfillmentOrders?.nodes || []);
    const partOnly = entry.fulfillmentStatus === "PARTIALLY_FULFILLED";
    if (allowCreate && !partOnly && open.length) {
      const created = [];
      const buckets = trackingBuckets(entry, numbers, open.length);
      for (let i = 0; i < open.length; i++) {
        created.push(await createFulfillmentWithTracking(admin, open[i], buckets[i].numbers, buckets[i].shipment));
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

    // Why nothing was fulfilled — three different things, and the log row is
    // where someone goes to find out which.
    notFulfilled = !open.length
      ? "no fulfillment or open fulfillment order on the Shopify order"
      : !allowCreate
        ? "fulfillment creation is off (SYNC_FULFILLMENT_CREATE=false)"
        : "NetSuite reports only part of the order shipped and named no items, so the lines still open here were left alone";

    // Nothing to fulfil and no tracking to fall back on writing either.
    if (!numbers.length) {
      return { ...base, ok: true, skipped: true, name: ctx.name, reason: `${notFulfilled}; ${noTrackingReason(entry)}` };
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
    const attr = await writeTrackingAttribute(admin, orderId, ctx.customAttributes, numbers);
    return { ...base, ...attributeResult(attr, numbers), name: ctx.name, warning: message };
  }

  const attr = await writeTrackingAttribute(admin, orderId, ctx.customAttributes, numbers);
  return {
    ...base,
    ...attributeResult(attr, numbers),
    name: ctx.name,
    reason: attr.unchanged
      ? `${notFulfilled}; the number it already carries is the one NetSuite reports`
      : notFulfilled,
  };
}

// The netsuite_tracking write, skipped when the order already carries exactly
// what NetSuite reports. Without that check this went out on EVERY run for
// every order with no fulfillment to hang the numbers on — which on this
// account is most of them — so a sync where nothing had changed still spent an
// orderUpdate, a Shopify rate-limit slice and a new order version per order.
// The detail attributes above have always been guarded this way; this one was
// not.
async function writeTrackingAttribute(admin, orderId, existing, numbers) {
  const pairs = [["netsuite_tracking", numbers.join(", ")]];
  if (!attributesDiffer(existing, pairs)) return { ok: true, unchanged: true };
  return writeCustomAttributePairs(admin, orderId, existing, pairs);
}

// The log fields for an attribute write. Named rather than spread from the
// write's own return value: that carries the whole merged attribute set (forty
// keys on an order this sync created), and spreading it put all of them in the
// sync log row for every order that took this path.
function attributeResult(attr, numbers) {
  return {
    ok: attr.ok,
    via: "customAttribute",
    tracking: numbers.join(", "),
    ...(attr.unchanged ? { skipped: true } : {}),
    ...(attr.error ? { error: attr.error } : {}),
  };
}

// Why an order came out of NetSuite with no tracking. The three cases look
// identical in the log ("no tracking numbers") but mean entirely different
// things — nothing has shipped, something shipped without a number recorded, or
// the shipment lookup itself found nothing — and only the middle one is normal
// on this account. Worth the sentence: this is the reason someone opens the log
// row at all.
function noTrackingReason(entry) {
  const shipments = entry.trackingFulfillments || 0;
  if (!shipments) {
    return `nothing shipped in NetSuite (no item fulfillment record) and NetSuite reports ${entry.fulfillmentStatus || "no fulfillment status"}`;
  }
  const when = entry.trackingShipDate ? ` on ${entry.trackingShipDate}` : "";
  return `${shipments} NetSuite fulfillment(s)${when} carry no tracking number, and NetSuite reports ${entry.fulfillmentStatus || "no fulfillment status"}`;
}

// One Shopify fulfillment per NetSuite shipment, written straight off the
// shipment detail: its own lines, its own number, its own carrier and link.
// This is the path that makes the tracking item-wise instead of every number
// showing against every item.
//
// Returns null — meaning "nothing was written, carry on" — when NetSuite
// reported no shipment detail for this order, or when nothing it shipped is
// still open in Shopify. Both leave the caller on the flat split it used
// before, which is the only thing that can be done with numbers that cannot be
// tied to lines.
//
// Otherwise it returns what was written plus the two things the caller needs to
// finish the order off: the numbers that DID go out on a new fulfillment, and
// the shipments that could not be placed. The second set is what the order's
// existing fulfillments are then reconciled against — a shipment whose lines
// are no longer open here is, on a partly-shipped order, precisely the shipment
// an earlier run already fulfilled.
async function fulfilByShipment(admin, entry, ctx) {
  const shipments = (entry.shipments || []).filter((s) => s.items?.length);
  if (!shipments.length) return null;

  // A remainder is only fulfilled when NetSuite says the whole order shipped.
  // On a PARTIALLY_FULFILLED order the lines left over are lines that genuinely
  // have not shipped yet, and fulfilling them would tell the customer they had.
  const plan = planShipmentFulfillments(shipments, ctx.fulfillmentOrders?.nodes || [], {
    fulfillRemainder: entry.fulfillmentStatus === "FULFILLED",
  });
  if (!plan.plans.length) return null;

  const { created, failed } = await writeShipmentFulfillments(admin, plan);
  const numbers = created.flatMap((c) => c.numbers);
  return {
    placed: new Set(numbers),
    unplacedShipments: plan.unplaced.map((u) => u.shipment),
    log: {
      via: "fulfillmentCreate (one per NetSuite shipment)",
      fulfillments: created,
      tracking: numbers.join(", ") || null,
      shipmentsPlanned: `${plan.plans.length} of ${shipments.length} NetSuite shipment(s) matched Shopify lines`,
      // A shipment whose items are no longer open here keeps its numbers out of
      // Shopify entirely, so it is named rather than silently dropped.
      ...(plan.unplaced.length
        ? { note: plan.unplaced.map((u) => `NetSuite fulfillment ${u.shipment.netsuiteId} (${(u.shipment.trackingNumbers || []).join(", ") || "no tracking"}): ${u.reason}`).join("; ") }
        : {}),
      ...(failed.length ? { warning: failed.join("; ") } : {}),
    },
  };
}

// Puts the leftover numbers onto the fulfillments the order already has, and
// returns only the ones it actually changed.
//
// `shipments` is the candidate list to pair against: the shipments that could
// not be written as new fulfillments when the item-wise path ran, and every
// shipment the order has when it did not.
async function updateExistingTracking(admin, entry, fulfillments, numbers, shipments) {
  const updated = [];
  const buckets = trackingBuckets(entry, numbers, fulfillments.length, shipments);
  for (let i = 0; i < fulfillments.length; i++) {
    const f = fulfillments[i];
    const { numbers: bucket, shipment: from } = buckets[i];
    if (!bucket.length) continue;
    const wanted = trackingInfoFor(bucket, from);
    if (sameTracking(f.trackingInfo, wanted)) continue;
    updated.push(await updateFulfillmentTracking(admin, f.id, bucket, from));
  }
  return updated;
}

// The tracking numbers to put on each of N Shopify fulfillments, and the
// NetSuite shipment each bucket came from (which is what names the carrier and
// builds the link).
//
// When the candidate shipments line up one-for-one with the Shopify
// fulfillments, they are paired in order — both are oldest-first, so
// fulfillment i really is shipment i, and each keeps its own carrier instead of
// borrowing the order's. Otherwise the numbers are split the way they always
// were: one per target in order, surplus piled onto the last.
function trackingBuckets(entry, numbers, count, from) {
  const shipments = (from || entry.shipments || []).filter((s) => s.trackingNumbers?.length);
  if (shipments.length === count) {
    return shipments.map((s) => ({ numbers: s.trackingNumbers, shipment: s }));
  }
  const orderWide = {
    shipMethod: entry.trackingShipMethod,
    carrier: null,
    trackingUrlTemplate: sharedTrackingUrlTemplate(entry.shipments),
  };
  return distribute(numbers, count).map((bucket) => ({ numbers: bucket, shipment: orderWide }));
}

// NetSuite's own tracking URL template for numbers that are being split flat —
// i.e. that could not be tied to one shipment each, so no shipment's template
// can be claimed for them individually.
//
// Only when every shipment on the order names the SAME template, because that
// is the only case where the number's own shipment is irrelevant: a template is
// a per-shipping-method fact, and an order that went out by two methods can
// hold two of them. Handing a FedEx template a UPS number would build a link to
// the wrong carrier's site, which is worse than the no link this used to
// produce — it dropped the account's own template on this path entirely.
function sharedTrackingUrlTemplate(shipments) {
  const list = shipments || [];
  if (!list.length) return null;
  const templates = new Set(list.map((s) => s.trackingUrlTemplate || ""));
  const [only] = [...templates];
  return templates.size === 1 && only ? only : null;
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

// Whether a fulfillment already carries the trackingInfo this run would write.
//
// The numbers have to match exactly, as they always did. The company and the
// link are compared only where THIS run has one to send: NetSuite naming no
// carrier is not a reason to blank one the fulfillment already shows, and
// Shopify stores what it is sent — so a fulfillment that disagrees is corrected
// once and matches from then on, rather than being rewritten every run.
//
// This is what puts the account's own tracking link on fulfillments written
// before the template existed. Comparing numbers alone, as this used to, left
// them exactly as the run that created them found them, for good.
function sameTracking(existing, wanted) {
  const have = (existing || []).filter((t) => t?.number);
  const numbers = wanted?.numbers || (wanted?.number ? [wanted.number] : []);
  if (numbers.length !== have.length) return false;
  const urls = wanted?.urls || (wanted?.url ? [wanted.url] : []);
  return numbers.every((number, i) => {
    const found = have.find((t) => t.number === number);
    if (!found) return false;
    if (wanted.company && found.company !== wanted.company) return false;
    return !urls[i] || found.url === urls[i];
  });
}

// Whether writing `pairs` onto `existing` custom attributes would actually
// change anything — skips a needless orderUpdate call when this run found the
// same ship date/status/weight (or tracking number) NetSuite already reported
// last time.
function attributesDiffer(existing, pairs) {
  const have = new Map((existing || []).map((a) => [a.key, a.value]));
  return pairs.some(([key, value]) => have.get(key) !== String(value));
}

// `fulfillments` is a plain list field rather than a connection, so there is no
// cursor to follow and the only lever is how many are asked for. 50 is well
// past what an order ships as here (the busiest on this account is four item
// fulfillments) and past what Shopify will paginate for us either way.
const FULFILLMENT_LIMIT = 50;

async function fetchTrackingContext(admin, orderId) {
  const resp = await admin.graphql(
    `#graphql
    query OrderTrackingContext($id: ID!, $fulfillments: Int!, $fulfillmentOrders: Int!, $lines: Int!) {
      order(id: $id) {
        id
        name
        customAttributes { key value }
        fulfillments(first: $fulfillments) { id status trackingInfo { company number url } }
        fulfillmentOrders(first: $fulfillmentOrders) {
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
    {
      variables: {
        id: orderId,
        fulfillments: FULFILLMENT_LIMIT,
        fulfillmentOrders: PAGE,
        lines: LINE_PAGE,
      },
    },
  );
  const body = await resp.json();
  if (body?.errors?.length) throw new Error(gqlError(body, []));
  const order = body?.data?.order || null;
  if (!order) return null;
  // Followed past the first page, and only for an order that has one: a big
  // order used to come back cut short with nothing saying so, and the lines past
  // the cut were simply not there to be fulfilled (see completeFulfillmentOrders).
  order.fulfillmentOrders = { nodes: await completeFulfillmentOrders(admin, orderId, order.fulfillmentOrders) };
  return order;
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
//
// Built out of the same two pieces the item-wise path uses — what counts as an
// open line, and how open lines are grouped into a fulfillment. This had its own
// copy of both, including its own list of the fulfillment order statuses that
// mean "still shippable", and two copies of a rule like that only stay in step
// until someone edits one of them.
function openFulfillmentOrderGroups(nodes) {
  return groupByFulfillmentOrder(openLinePool(nodes).map((l) => ({ ...l, quantity: l.remaining })));
}

async function updateFulfillmentTracking(admin, fulfillmentId, numbers, shipment) {
  const resp = await admin.graphql(
    `#graphql
    mutation FulfillmentTrackingUpdate($fulfillmentId: ID!, $trackingInfoInput: FulfillmentTrackingInput!, $notifyCustomer: Boolean) {
      fulfillmentTrackingInfoUpdate(fulfillmentId: $fulfillmentId, trackingInfoInput: $trackingInfoInput, notifyCustomer: $notifyCustomer) {
        fulfillment { id trackingInfo { company number url } }
        userErrors { field message }
      }
    }`,
    { variables: { fulfillmentId, trackingInfoInput: trackingInfoFor(numbers, shipment), notifyCustomer: false } },
  );
  const body = await resp.json();
  const payload = body?.data?.fulfillmentTrackingInfoUpdate;
  const errors = payload?.userErrors || [];
  if (errors.length || !payload?.fulfillment) throw new Error(gqlError(body, errors));
  return {
    id: payload.fulfillment.id,
    numbers,
    company: payload.fulfillment.trackingInfo?.[0]?.company || null,
    url: payload.fulfillment.trackingInfo?.[0]?.url || null,
  };
}

async function createFulfillmentWithTracking(admin, lineItemsByFulfillmentOrder, numbers, shipment) {
  const trackingInfo = trackingInfoFor(numbers, shipment);
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
          // null when the fulfillment exists only to correct the order's state
          // (NetSuite shipped it, Shopify never caught up) and there is nothing
          // to track — an empty trackingInfo is not sent in its place.
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
  return {
    id: payload.fulfillment.id,
    numbers,
    company: payload.fulfillment.trackingInfo?.[0]?.company || null,
    url: payload.fulfillment.trackingInfo?.[0]?.url || null,
    created: true,
  };
}

// Writes `pairs` onto the order's custom attribute set — the fallback path
// for netsuite_tracking, and the only path for the ship date/status/weight
// attributes, which have nowhere else to land. orderUpdate replaces the whole
// attribute set, so the existing attributes are read back and re-sent with
// only the given keys changed. Returns the merged set on success so a caller
// writing twice in the same syncTracking call (detail attributes, then a
// tracking-number fallback) can chain off what was just written instead of a
// stale snapshot that the second orderUpdate would otherwise clobber.
async function writeCustomAttributePairs(admin, orderId, existing, pairs) {
  const keys = new Set(pairs.map(([key]) => key));
  const customAttributes = (existing || [])
    .filter((a) => !keys.has(a.key))
    .map((a) => ({ key: a.key, value: a.value }));
  for (const [key, value] of pairs) customAttributes.push({ key, value: String(value) });

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
  return { ok: true, customAttributes };
}

export async function deleteOrder(admin, entry) {
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
//
// The netsuite_shipped_* / netsuite_package_weight pairs are duplicated from
// syncTracking's detailPairs on purpose. The two paths never both run for one
// order — createOrder handles the orders that have no Shopify order yet,
// syncTracking the ones that do (see processOrderRecords) — so without them
// here, an order CREATED by the sync would show its shipment detail only after
// a later run happened to re-match it, and never at all if it never changed
// again. Keep the key names identical to detailPairs: a created order and a
// matched one have to describe the same shipment the same way.
export function buildCustomAttributes(entry) {
  const pairs = [
    ["netsuite_id", entry.externalId],
    ["netsuite_ref", entry.reference],
    ["netsuite_currency", entry.currency],
    ["netsuite_tracking", entry.tracking],
    ["netsuite_shipped_date", entry.trackingShipDate],
    ["netsuite_shipment_status", entry.trackingStatus],
    ["netsuite_shipped_via", entry.trackingShipMethod],
    ["netsuite_package_weight", entry.trackingPackageWeight != null ? String(entry.trackingPackageWeight) : null],
    ["netsuite_shipments", shipmentSummary(entry)],
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
export function buildTags(entry) {
  return [
    extTag(entry.externalId),
    ...(entry.reference ? [`ref:${entry.reference}`] : []),
    ...(entry.status ? [`status:${entry.status}`] : []),
    ...(entry.statusName ? [`ns:${entry.statusName}`] : []),
    ...(entry.otherRefNum ? [`po:${entry.otherRefNum}`] : []),
  ];
}

// Re-exported for the modules that have always imported it from here; it now
// lives in gql.js, which fulfill.server.js can reach without importing this
// file back (see the import at the top).
export { gqlError };
