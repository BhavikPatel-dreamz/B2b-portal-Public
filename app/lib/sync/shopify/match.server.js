import { findOrderIdByExternalId } from "./common.server.js";

// Matching — which Shopify order does this NetSuite order belong to?
// ---------------------------------------------------------------------------
// Two very different kinds of sales order come out of NetSuite:
//
//  1. Celigo-imported orders. These ORIGINATED in Shopify; the Celigo connector
//     pushed them into NetSuite and stamped the source store onto the billing
//     and/or shipping address (custrecord_celigo_shopify_store), with the
//     Shopify order reference in otherRefNum. BOTH must be present to take this
//     route — the store marker says "Shopify owns this order", otherRefNum is
//     the only thing that says WHICH order, and one without the other is not
//     enough to act on. Shopify is the system of record for everything except
//     fulfillment, so these are never created here (that would duplicate the
//     merchant's own order) and never field-overwritten — the only thing pushed
//     back is tracking, and only when otherRefNum resolves to a real order.
//
//  2. Everything else. Found by the ext:<netsuiteId> tag written at create time:
//     found → tracking-only update, not found → create.
//
// Returns { id, via, allowCreate, reason }.
export async function resolveShopifyOrder(admin, entry) {
  if (entry.isCeligoOrder && entry.otherRefNum) {
    const id = await findOrderByShopifyRef(admin, entry.otherRefNum);
    return {
      id,
      via: "otherRefNum",
      allowCreate: false,
      reason: id ? null : `otherRefNum "${entry.otherRefNum}" did not match any Shopify order — not creating (Celigo order)`,
    };
  }
  return {
    id: await findOrderIdByExternalId(admin, entry.externalId),
    via: "netsuite_id",
    allowCreate: true,
    reason: null,
  };
}

const ORDER_GID = /^gid:\/\/shopify\/Order\/\d+$/;

// Resolves a NetSuite otherRefNum to a Shopify order gid, or null. Celigo
// writes one of three shapes into that field depending on how the connector is
// configured, so all three are tried: a full gid, the numeric Shopify order id
// ("5123456789012"), or the order number/name ("1030" / "#1030").
async function findOrderByShopifyRef(admin, ref) {
  const raw = String(ref).trim();
  if (!raw) return null;
  if (ORDER_GID.test(raw)) return (await orderExists(admin, raw)) ? raw : null;

  const number = raw.replace(/^#/, "").trim();
  if (!number) return null;
  // otherRefNum is a free-text NetSuite field, so on a non-Celigo-shaped value
  // ("ANA PO23911", "n/a") the lookup is abandoned rather than fed into the
  // order search as-is. Nothing matches -> nothing is updated.
  if (!/^[A-Za-z0-9-]+$/.test(number)) return null;

  // Shopify order ids are long (13+ digits); order numbers are short. Only try
  // the id lookup when the value is plausibly an id, so a 4-digit order number
  // doesn't cost an extra round trip.
  if (/^\d{10,}$/.test(number)) {
    const gid = `gid://shopify/Order/${number}`;
    if (await orderExists(admin, gid)) return gid;
  }
  return findOrderByName(admin, number);
}

async function orderExists(admin, gid) {
  const resp = await admin.graphql(
    `#graphql
    query OrderById($id: ID!) {
      order(id: $id) { id name }
    }`,
    { variables: { id: gid } },
  );
  const body = await resp.json();
  return Boolean(body?.data?.order?.id);
}

// Looks the order up by its number/name. `name:` search is fuzzy enough to
// return neighbours (e.g. "1030" can surface "#10300"), so the results are
// filtered down to an exact name match and an ambiguous hit is treated as an
// error rather than guessed at.
async function findOrderByName(admin, number) {
  const wanted = new Set([`#${number}`.toLowerCase(), number.toLowerCase()]);
  for (const q of [`name:#${number}`, `name:${number}`]) {
    const resp = await admin.graphql(
      `#graphql
      query FindOrderByName($query: String!) {
        orders(first: 10, query: $query) {
          nodes { id name legacyResourceId }
        }
      }`,
      { variables: { query: q } },
    );
    const body = await resp.json();
    const hits = (body?.data?.orders?.nodes || []).filter(
      (n) => wanted.has(String(n.name || "").toLowerCase()) || String(n.legacyResourceId) === number,
    );
    if (hits.length === 1) return hits[0].id;
    if (hits.length > 1) {
      throw new Error(`otherRefNum "${number}" matched ${hits.length} Shopify orders (${hits.map((h) => h.name).join(", ")}) — refusing to guess`);
    }
  }
  return null;
}

// The Shopify order name = configurable prefix + the NetSuite reference
// (tranId, e.g. "SO1504") when present, otherwise the raw NetSuite id.
export function orderName(entry) {
  const prefix = process.env.NETSUITE_ORDER_PREFIX || "";
  return `${prefix}${entry.reference || entry.externalId}`;
}

// ---------------------------------------------------------------------------
