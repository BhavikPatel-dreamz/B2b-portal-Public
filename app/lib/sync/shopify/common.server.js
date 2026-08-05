import { extTag } from "../mapping.js";

// ---------------------------------------------------------------------------
// GraphQL helpers
// ---------------------------------------------------------------------------
export async function getShopCurrency(admin) {
  const resp = await admin.graphql(`#graphql
    query ShopCurrency { shop { currencyCode } }`);
  const body = await resp.json();
  return body?.data?.shop?.currencyCode || "USD";
}

// Finds the Shopify order previously created for this externalId (by tag).
// Returns the order gid or null.
//
// The returned tags are re-checked rather than trusting the search result: this
// gid is what gets tracking written to it and, on a cancellation, what gets
// DELETED, so a loose search match must never be mistaken for a hit. More than
// one match means the store already holds duplicates — that is surfaced as an
// error instead of silently picking one of them to update or delete.
export async function findOrderIdByExternalId(admin, externalId) {
  const tag = extTag(externalId);
  const resp = await admin.graphql(
    `#graphql
    query FindOrderByTag($query: String!) {
      orders(first: 10, query: $query) {
        nodes { id name tags }
      }
    }`,
    { variables: { query: `tag:'${tag}'` } },
  );
  const body = await resp.json();
  const hits = (body?.data?.orders?.nodes || []).filter((n) => (n.tags || []).includes(tag));
  if (hits.length > 1) {
    throw new Error(`NetSuite id ${externalId} matches ${hits.length} Shopify orders (${hits.map((h) => h.name).join(", ")}) — refusing to guess`);
  }
  return hits[0]?.id || null;
}

// ---------------------------------------------------------------------------
