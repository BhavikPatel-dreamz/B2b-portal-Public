#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Query NetSuite sales orders by date range, from the command line
// ---------------------------------------------------------------------------
// Prints the exact curl it is about to run, then runs it. The point is both
// halves: you get the data, and you get a command you can paste into Postman or
// a terminal and change by hand.
//
//   node --env-file=.env scripts/netsuite-orders.mjs --from 2026-08-01 --to 2026-08-05
//   node --env-file=.env scripts/netsuite-orders.mjs --from 2026-08-01 --to 2026-08-05 --expand
//   node --env-file=.env scripts/netsuite-orders.mjs --from 2026-08-01 --to 2026-08-05 --curl-only
//
// Options:
//   --from YYYY-MM-DD   start of the range (required)
//   --to   YYYY-MM-DD   end of the range, inclusive (required)
//   --shop <domain>     which store's NetSuite connection to use; defaults to
//                       the only connected one
//   --tz <IANA>         zone the dates are read in; defaults to SYNC_TIMEZONE,
//                       then UTC
//   --limit N           page size (default 50)
//   --offset N          where to start in the result set (default 0)
//   --expand            after listing, fetch the full record for each id
//   --curl-only         print the curl and stop, without calling anything
//   --out <file>        write the JSON response to a file as well as stdout
//
// The q filter is built by the SAME function the real sync uses
// (buildOrdersQuery in app/lib/netsuite/orders-query.server.js), so what this
// prints is what a run would really send — this cannot drift from the sync.
// A standalone node CLI: it reads process.env and uses Buffer, neither of which
// the eslint config grants outside the server-file filename pattern.
/* eslint-env node */
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";

import { buildOrdersQuery } from "../app/lib/netsuite/orders-query.server.js";
import { oauthTokenUrl, recordPath, recordUrl } from "../app/lib/netsuite/endpoints.server.js";
import { parseCustomRange } from "../app/lib/sync/windows.js";
import { isValidTimeZone } from "../app/lib/timezone/index.js";

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = { limit: "50", offset: "0" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (["expand", "curl-only", "help"].includes(key)) out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

function die(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

if (args.help || !args.from || !args.to) {
  die("usage: node --env-file=.env scripts/netsuite-orders.mjs --from YYYY-MM-DD --to YYYY-MM-DD [--expand] [--curl-only]");
}

// The zone the two dates are read in. The app resolves this per shop (env
// override, else the Shopify store's own zone); a standalone script cannot reach
// the Shopify admin API, so it takes the env var or UTC and says which it used
// rather than pretending to know.
const timeZone = args.tz || (isValidTimeZone(process.env.SYNC_TIMEZONE) ? process.env.SYNC_TIMEZONE : "UTC");
if (!isValidTimeZone(timeZone)) die(`"${timeZone}" is not a timezone this runtime knows.`);

const range = parseCustomRange(args.from, args.to, timeZone);
if (range.error) die(range.error);

// The same builder the sync calls. `null` for the watermark, because an explicit
// range replaces it — exactly as a "Custom range" Sync now does.
const q = buildOrdersQuery(null, { from: range.from, to: range.to }, timeZone);
const listPath = recordPath.salesOrderList({ limit: Number(args.limit), offset: Number(args.offset), q });
const listUrl = recordUrl(listPath);

console.log(`
  range     ${args.from} -> ${args.to}   (read as ${timeZone})
  instants  ${range.from.toISOString()} -> ${range.to.toISOString()}

  filter sent to NetSuite (names the range's own instants):
  q         ${q}
`);

console.log(`  curl:

export NS_TOKEN="<access token>"
curl -sS -X GET \\
  -H "Authorization: Bearer $NS_TOKEN" \\
  -H "Accept: application/json" \\
  "${listUrl}"
`);

if (args["curl-only"]) process.exit(0);

const prisma = new PrismaClient();

try {
  const token = await accessToken(await resolveShop());
  const body = await callNetsuite(listUrl, token);
  const ids = (body?.items || []).map((i) => String(i.id));

  console.log(`  ${body?.totalResults ?? ids.length} order(s) match; this page listed ${ids.length}.`);
  console.log(`  ids: ${ids.join(", ") || "(none)"}\n`);

  let result = { q, range: { from: range.from.toISOString(), to: range.to.toISOString() }, timeZone, list: body };

  if (args.expand && ids.length) {
    // The list endpoint returns ids only, so each has to be fetched. This is the
    // expensive half of a real run too — one request per order.
    console.log(`  expanding ${ids.length} record(s)…\n`);
    const orders = [];
    for (const id of ids) {
      const url = recordUrl(recordPath.salesOrder(id, { expand: true }));
      orders.push(await callNetsuite(url, token));
    }
    // Re-applied here for the same reason the sync does it: the q filter above is
    // day-granular, so the list is wider than the range that was asked for, and
    // only the expanded record carries a real lastModifiedDate to check.
    const inRange = orders.filter((o) => {
      const t = Date.parse(o?.lastModifiedDate);
      return !Number.isFinite(t) || (t >= range.from.getTime() && t <= range.to.getTime());
    });
    console.log(`  ${inRange.length} of ${orders.length} expanded order(s) fall inside the exact range.\n`);
    result = { ...result, orders, inRange: inRange.map((o) => String(o.id)) };
  }

  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(result, null, 2));
    console.log(`  written to ${args.out}`);
  } else if (!args.expand) {
    console.log(JSON.stringify(body, null, 2));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
} catch (err) {
  die(err?.message || String(err));
} finally {
  await prisma.$disconnect();
}

// Which store's NetSuite connection to borrow. Named explicitly, or the only
// connected one — a script that picked arbitrarily between two accounts would be
// the worst kind of convenient.
async function resolveShop() {
  if (args.shop) return args.shop;
  const connected = await prisma.netsuiteAppSettings.findMany({
    where: { NOT: { refreshToken: null } },
    select: { shop: true },
  });
  if (!connected.length) die("No shop has a NetSuite connection — visit /api/netsuite/connect first.");
  if (connected.length > 1) {
    die(`Several shops are connected — name one with --shop:\n    ${connected.map((c) => c.shop).join("\n    ")}`);
  }
  return connected[0].shop;
}

// A usable access token for that shop, refreshed if the stored one has expired.
// Deliberately does NOT write the refreshed token back: this is a read-only
// diagnostic, and a script racing the app to save a token is a good way to
// invalidate the app's copy.
async function accessToken(shop) {
  const settings = await prisma.netsuiteAppSettings.findUnique({ where: { shop } });
  if (!settings?.refreshToken) die(`NetSuite is not connected for ${shop} — visit /api/netsuite/connect first.`);

  const expiresAt = settings.tokenExpiresAt?.getTime() ?? 0;
  if (expiresAt - 60_000 > Date.now() && settings.accessToken) return settings.accessToken;

  const key = process.env.NETSUITE_CONSUMER_KEY;
  const secret = process.env.NETSUITE_CONSUMER_SECRET;
  if (!key || !secret) die("NETSUITE_CONSUMER_KEY / NETSUITE_CONSUMER_SECRET are needed to refresh the token.");

  const res = await fetch(oauthTokenUrl(), {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: settings.refreshToken }).toString(),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) die(`Token refresh failed: ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text).access_token;
}

async function callNetsuite(url, token) {
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`NetSuite GET failed: ${res.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}
