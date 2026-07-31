import prisma from "../db.server.js";
import { syncOrdersFromFeed, logSyncCrash } from "../lib/order-sync.server.js";

// Cron-triggered order sync.
//   GET/POST /api/cron/orders-sync?token=CRON_SECRET[&shop=xxx.myshopify.com]
//
// Example crontab entry (every 15 min):
//   */15 * * * * curl -s "https://YOUR_APP_URL/api/cron/orders-sync?token=THE_SECRET"
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

  const runs = [];
  for (const shop of shops) {
    const startedAt = new Date();
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

  return json({ ok: true, ranAt: new Date().toISOString(), runs });
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
