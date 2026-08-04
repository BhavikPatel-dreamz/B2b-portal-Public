import prisma from "../db.server.js";
import { syncOrdersFromFeed, logSyncCrash } from "../lib/order-sync.server.js";
import { syncShopifyToApp } from "../lib/shopify-sync.server.js";

// Cron-triggered order sync.
//   GET/POST /api/cron/orders-sync?token=CRON_SECRET[&shop=xxx.myshopify.com][&direction=both]
//
// Example crontab entry (every 15 min):
//   */15 * * * * curl -s "https://YOUR_APP_URL/api/cron/orders-sync?token=THE_SECRET"
//
// direction controls which way orders flow:
//   netsuite -> push app orders out to Shopify via the NetSuite feed (syncOrdersFromFeed)
//   shopify  -> pull Shopify companies + their B2B orders into the app (syncShopifyToApp)
//   both     -> run both (default)
//
// Auth: pass CRON_SECRET as ?token= or the "x-cron-secret" header. There is no
// browser session on a cron call, so we authenticate to Shopify with the stored
// offline token via unauthenticated.admin(shop) inside the sync lib.
async function handle(request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || request.headers.get("x-cron-secret");

  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  // Which shop(s) to sync. Explicit ?shop= wins; otherwise sync every installed
  // shop that has an offline session.
  const shopParam = url.searchParams.get("shop");
  let shops;
  if (shopParam) {
    shops = [shopParam];
  } else {
    const sessions = await prisma.session.findMany({
      where: { isOnline: false },
      select: { shop: true },
    });
    shops = [...new Set(sessions.map((s) => s.shop))];
  }

  if (!shops.length) {
    return json({ ok: false, error: "no installed shops found" }, 404);
  }

  // Which direction(s) to run. Default runs both.
  const direction = (url.searchParams.get("direction") || "both").toLowerCase();
  const runNetsuite = direction === "both" || direction === "netsuite";
  const runShopify = direction === "both" || direction === "shopify";

  if (!runNetsuite && !runShopify) {
    return json(
      { ok: false, error: `invalid direction "${direction}" (use netsuite|shopify|both)` },
      400,
    );
  }

  const runs = [];
  for (const shop of shops) {
    const startedAt = new Date();

    // NetSuite -> Shopify: push app orders out through the feed.
    if (runNetsuite) {
      try {
        runs.push(await syncOrdersFromFeed(shop));
      } catch (err) {
        // A run that died before producing a summary (NetSuite auth, a Shopify
        // connection error) writes its own log entry — syncOrdersFromFeed only logs
        // the runs it finishes, and a cron process's console output is gone.
        const logFile = await logSyncCrash(shop, startedAt, err);
        runs.push({ shop, ok: false, error: err?.message || String(err), logFile });
      }
    }

    // Shopify -> app: pull Shopify companies + their B2B orders into the app.
    if (runShopify) {
      try {
        const result = await syncShopifyToApp(shop);
        runs.push({ shop, direction: "shopify", ok: true, ...result });
      } catch (err) {
        runs.push({
          shop,
          direction: "shopify",
          ok: false,
          error: err?.message || String(err),
        });
      }
    }
  }

  return json({ ok: true, ranAt: new Date().toISOString(), direction, runs });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Support both GET (simple cron/curl) and POST.
export const loader = ({ request }) => handle(request);
export const action = ({ request }) => handle(request);
