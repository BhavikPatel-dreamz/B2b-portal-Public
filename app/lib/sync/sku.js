// Comparison key for a SKU. NetSuite item names arrive with the casing and inner
// spacing a human typed ("TPU for AMS", "TPU FOR AMS GRAY 53102"), and a Shopify
// SKU is not guaranteed to match either, so both sides are normalised before
// they're compared.
//
// In a leaf module of its own so the shipment-to-line matching in
// fulfill.server.js can use it without importing mapping.js, which pulls the
// NetSuite client and the db module in behind it. mapping.js re-exports it, so
// everything that already imported it from there is unaffected.
export function skuKey(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}
