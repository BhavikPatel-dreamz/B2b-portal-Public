// A route module with a loader/action only — it never ships to the browser, so
// process.env is available. The eslint config grants the node environment by
// filename (server files), which a route file does not match.
/* eslint-env node */
import prisma from "../db.server.js";
import { dumpTargetedOrders } from "../lib/netsuite/order-dump.server.js";
import { targetedOrderIds } from "../lib/netsuite/client.server.js";

// Dump the NETSUITE_ORDER_IDS orders to a JSON log file.
//
//   GET|POST /api/netsuite/order-dump?token=CRON_SECRET[&shop=xxx.myshopify.com][&ids=SO20742,20249]
//
// Meant to be called by hand — from Postman, or curl — while working out what
// NetSuite is really returning for an order. It writes
// storage/logs/netsuite-orders-<shop>-<day>.json, appending one entry per call,
// and answers with the path plus what went into it.
//
// It does NOT sync: nothing reaches Shopify, the watermark does not move, and no
// sync lock is taken (see order-dump.server.js). Calling it repeatedly, or while
// a real sync is running, is safe.
//
// Auth is CRON_SECRET, the same shared secret the cron endpoint uses, passed as
// ?token= or the x-cron-secret header. There is no browser session on a Postman
// call, so the app authenticates to Shopify with the stored offline token
// instead — which is exactly why this endpoint has to be behind a secret: it
// reads a shop's NetSuite data without a shop admin being present.
async function handle(request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || request.headers.get("x-cron-secret");

  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  // Which shop. The shop is checked against the installed sessions rather than
  // trusted: it becomes part of a filename and is handed to the Shopify admin
  // client, and an arbitrary string should reach neither.
  const installed = [...new Set(
    (await prisma.session.findMany({ where: { isOnline: false }, select: { shop: true } })).map((s) => s.shop),
  )];
  if (!installed.length) return json({ ok: false, error: "no installed shops found" }, 404);

  const asked = url.searchParams.get("shop");
  let shop;
  if (asked) {
    if (!installed.includes(asked)) {
      return json({ ok: false, error: `"${asked}" is not an installed shop`, installed }, 404);
    }
    shop = asked;
  } else if (installed.length === 1) {
    // The overwhelmingly common case while debugging: one store, so naming it on
    // every call is friction with no purpose.
    shop = installed[0];
  } else {
    return json({ ok: false, error: "several shops are installed — name one with ?shop=", installed }, 400);
  }

  // ?ids= overrides NETSUITE_ORDER_IDS for this call, so an order can be looked
  // at without an env change and a redeploy. Same forms the env var takes: a
  // document number ("SO20742"), a bare number, or a raw internal id.
  const idsParam = (url.searchParams.get("ids") || "").split(",").map((s) => s.trim()).filter(Boolean);

  const result = await dumpTargetedOrders(shop, { ids: idsParam });
  if (!result.ok) {
    // 400 rather than 500: every failure this returns is about the request or
    // the configuration (nothing targeted, an id that matches no order, a
    // NetSuite account that refused), not about the server falling over.
    return json({ shop, ...result, envOrderIds: targetedOrderIds() }, 400);
  }
  return json({ shop, ...result });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Both verbs: GET so it can be opened in a browser or curled, POST because a
// Postman collection of "things that do work" is usually written with POST.
export const loader = ({ request }) => handle(request);
export const action = ({ request }) => handle(request);
