import { skuKey } from "../mapping.js";
import { gqlError } from "./tracking.server.js";

// Line items — NetSuite item name -> Shopify variant
// ---------------------------------------------------------------------------
// The NetSuite item name IS the SKU on this account ("3DXTECH-WHITE",
// "500-196-30", "8-00147"), so it's what a Shopify variant is looked up by. A hit
// links the order line to the real product — its image, its analytics, the
// customer seeing a product rather than a line of text. A miss leaves the line as
// what it already was, a custom line item, and never holds the order back: plenty
// of NetSuite lines are not products at all ("Certificate of Conformance"), and an
// order refused over one of those would be an order that never reaches Shopify.
//
// Batched and cached per run because a 50-order window carries ~140 distinct
// items, and one round trip each is 140 round trips.
const VARIANT_SKU_BATCH = 25;

// Fills `cache` (skuKey -> variant gid, or null for "looked up, not found") for
// every sku it hasn't already resolved.
export async function resolveVariantsBySku(admin, skus, cache) {
  const wanted = new Map();
  for (const sku of skus) {
    const key = skuKey(sku);
    // Embedded quotes and backslashes would break out of the search term. A sku
    // carrying them is left unresolved rather than half-escaped into a query that
    // matches something else.
    if (!key || cache.has(key) || /["\\]/.test(sku)) continue;
    wanted.set(key, sku);
  }
  if (!wanted.size) return cache;

  const entries = [...wanted.entries()];
  for (let i = 0; i < entries.length; i += VARIANT_SKU_BATCH) {
    const batch = entries.slice(i, i + VARIANT_SKU_BATCH);
    // Recorded as "not found" up front so a sku that the search doesn't return is
    // never looked up twice in the same run.
    for (const [key] of batch) cache.set(key, null);

    const query = batch.map(([, sku]) => `sku:"${sku}"`).join(" OR ");
    let nodes = [];
    try {
      const resp = await admin.graphql(
        `#graphql
        query VariantsBySku($query: String!) {
          productVariants(first: 250, query: $query) {
            nodes { id sku }
          }
        }`,
        { variables: { query } },
      );
      const body = await resp.json();
      if (body?.errors?.length) throw new Error(gqlError(body));
      nodes = body?.data?.productVariants?.nodes || [];
    } catch (err) {
      // A failed lookup must not fail the order — the lines simply stay custom.
      console.warn(`[order-sync] variant lookup by sku failed (${err?.message || err}); those lines stay unlinked.`);
      continue;
    }

    // Shopify's search is fuzzy, so the decision is an exact sku match on the
    // results. Two variants sharing a sku is ambiguous: linking the order to the
    // wrong product is worse than leaving the line custom, so it's left alone.
    const bySku = new Map();
    for (const node of nodes) {
      const key = skuKey(node.sku);
      if (!wanted.has(key)) continue;
      if (bySku.has(key)) bySku.set(key, "ambiguous");
      else bySku.set(key, node.id);
    }
    for (const [key, value] of bySku) {
      if (value === "ambiguous") {
        console.warn(`[order-sync] sku "${wanted.get(key)}" matches more than one Shopify variant — leaving that line unlinked.`);
        continue;
      }
      cache.set(key, value);
    }
  }
  return cache;
}

// ---------------------------------------------------------------------------
