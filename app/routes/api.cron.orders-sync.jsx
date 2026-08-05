import prisma from "../db.server.js";
import { startCronJobs } from "../lib/cron/jobs.server.js";
import { cronIntervalMinutes, crontabLine, intervalLabel } from "../lib/cron/schedule.js";

// Cron-triggered scheduled run.
//   GET/POST /api/cron/orders-sync?token=CRON_SECRET[&shop=xxx.myshopify.com]
//
// The interval lives in CRON_INTERVAL_MINUTES (default 180) and the crontab line
// for it is printed by this endpoint's response and shown on the log page, so the
// schedule the app describes and the one the host runs come from one number.
// Install the line it gives you, e.g. every 15 minutes:
//   */15 * * * * curl -fsS "https://YOUR_APP_URL/api/cron/orders-sync?token=THE_SECRET" > /dev/null
//
// WHAT it runs is not decided here: it walks CRON_JOBS (app/lib/cron/jobs.server.js),
// which is where another scheduled task gets added. This route only works out
// which shops to run for, and reports what came back.
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

  // One shop at a time, and inside each shop one job at a time (runCronJobs) —
  // they share the same Shopify and NetSuite rate limits, and a scheduled run has
  // nowhere to be.
  const runs = [];
  for (const shop of shops) {
    // The cron waits for its own run: it is a server-to-server call with no
    // browser on the other end, and a caller that gets the summary back can log
    // and alert on it. (The log page's Sync now uses the same starter but
    // deliberately does NOT wait — see api.orders-sync-now.jsx.)
    const { started, promise, heldSince } = await startCronJobs(shop);
    if (!started) {
      const since = heldSince?.toISOString() || "unknown";
      console.warn(`[cron] ${shop}: a run started at ${since} is still going — skipping this tick.`);
      runs.push({ shop, skipped: true, reason: `a run started at ${since} is still in progress` });
      continue;
    }
    runs.push({ shop, jobs: await promise });
  }

  const minutes = cronIntervalMinutes(process.env.CRON_INTERVAL_MINUTES);
  return json({
    ok: true,
    ranAt: new Date().toISOString(),
    // Echoed so a `curl` of this endpoint answers "am I installed on the schedule
    // this app thinks it has?" without anyone reading the code for it.
    schedule: {
      everyMinutes: minutes,
      every: intervalLabel(minutes),
      crontab: crontabLine(minutes, process.env.SHOPIFY_APP_URL),
    },
    runs,
  });
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
