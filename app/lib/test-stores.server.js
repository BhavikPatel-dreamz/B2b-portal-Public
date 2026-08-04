// Which shops see the app's internals.
//
// The schedule card's technical half — the raw NetSuite `q` filter, the
// crontab line with the app's URL in it, the banners naming env vars like
// SYNC_ORDER_EXPORT — is written for whoever runs this app, not for a merchant
// using it. On a real store it is noise at best; at worst it is a description of
// the infrastructure handed to anyone who opens the page.
//
// So it is shown only on the stores named in TEST_STORE_SHOP_NAME, comma
// separated:
//
//   TEST_STORE_SHOP_NAME=vijay-checkout.myshopify.com,another-dev.myshopify.com
//
// UNSET OR EMPTY MEANS NOBODY. An allowlist that defaults to "everyone" is not an
// allowlist — it would leak on every store the day someone forgets to set it,
// and that failure is silent. `*` is there for a dev machine that wants it on
// everywhere, and has to be typed on purpose.
//
// `raw` is a parameter with an env default so this can be tested without
// touching process.env.
export function testStores(raw = process.env.TEST_STORE_SHOP_NAME) {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// The handle part of a shop domain: "vijay-checkout.myshopify.com" →
// "vijay-checkout". Accepted as well as the full domain because "the shop name"
// is what people type, and an allowlist that silently doesn't match is worse
// than one that is generous about the form of the name.
function handle(shop) {
  return String(shop ?? "").trim().toLowerCase().replace(/\.myshopify\.com$/, "");
}

export function isTestStore(shop, raw = process.env.TEST_STORE_SHOP_NAME) {
  const allowed = testStores(raw);
  if (!allowed.length) return false;
  if (allowed.includes("*")) return true;
  const wanted = handle(shop);
  if (!wanted) return false;
  return allowed.some((entry) => handle(entry) === wanted);
}
