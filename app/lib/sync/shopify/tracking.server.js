import { extTag } from "../mapping.js";
import { findOrderIdByExternalId } from "./common.server.js";

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
    // Log-only from here down: neither ship method is sent to Shopify (see
    // trackingInput for why carrier text isn't handed to trackingInfo.company),
    // and ship date/status/weight have no native Shopify fulfillment field to
    // land on either — they're written as custom attributes below instead, and
    // ride along here just so the sync log shows them next to the tracking
    // numbers they describe.
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
  try {
    if (fulfillments.length) {
      // Already fulfilled in Shopify and NetSuite has no numbers to add.
      if (!numbers.length) {
        return { ...base, ok: true, skipped: true, name: ctx.name, reason: `already fulfilled in Shopify (${fulfillments.length}); ${noTrackingReason(entry)}` };
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
      return { ...base, ok: true, skipped: true, name: ctx.name, reason: `no open fulfillment order to fulfil; ${noTrackingReason(entry)}` };
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
    const attr = await writeCustomAttributePairs(admin, orderId, ctx.customAttributes, [["netsuite_tracking", numbers.join(", ")]]);
    return { ...attr, ...base, ok: attr.ok, name: ctx.name, via: "customAttribute", tracking: numbers.join(", "), warning: message };
  }

  const attr = await writeCustomAttributePairs(admin, orderId, ctx.customAttributes, [["netsuite_tracking", numbers.join(", ")]]);
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

// Whether writing `pairs` onto `existing` custom attributes would actually
// change anything — skips a needless orderUpdate call when this run found the
// same ship date/status/weight (or tracking number) NetSuite already reported
// last time.
function attributesDiffer(existing, pairs) {
  const have = new Map((existing || []).map((a) => [a.key, a.value]));
  return pairs.some(([key, value]) => have.get(key) !== String(value));
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

// Surfaces either GraphQL top-level errors (e.g. access denied) or userErrors.
export function gqlError(body, userErrors) {
  if (body?.errors?.length) {
    return body.errors.map((e) => e.message).join("; ");
  }
  if (userErrors?.length) {
    return userErrors.map((e) => `${(e.field || []).join(".")} ${e.message}`.trim()).join("; ");
  }
  return "unknown GraphQL error";
}
