#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Which shipped orders the sales-order filter cannot see
// ---------------------------------------------------------------------------
// The sync finds work by asking NetSuite for sales orders whose lastModifiedDate
// moved. Fulfilling an order does not move it: the Item Fulfillment is a separate
// record, the sales order's lines go to "Item Fulfilled", and the sales order's
// own timestamp stays where it was. So an order shipped today but last edited
// three weeks ago is invisible to every window a run can ask for, and its
// tracking numbers sit in NetSuite until something unrelated touches the order.
//
// This measures that gap on a real account. For each Item Fulfillment changed in
// the range it prints the fulfillment's date, its sales order's date, and whether
// the sales order would have been picked up. The MISSED rows are the orders the
// second discovery pass exists to catch.
//
//   node --env-file=.env scripts/netsuite-fulfillment-gap.mjs --from 2026-08-01 --to 2026-08-07
//   node --env-file=.env scripts/netsuite-fulfillment-gap.mjs --from 2026-08-01 --to 2026-08-07 --curl-only
//
// Options:
//   --from YYYY-MM-DD   start of the range (required)
//   --to   YYYY-MM-DD   end of the range, inclusive (required)
//   --shop <domain>     which store's NetSuite connection to use; defaults to
//                       the only connected one
//   --tz <IANA>         zone the dates are read in; defaults to SYNC_TIMEZONE,
//                       then UTC
//   --limit N           SuiteQL page size (default 1000)
//   --missed-only       print only the rows the current sync would miss
//   --curl-only         print the curl and stop, without calling anything
//   --out <file>        write the JSON result to a file as well as stdout
//
// Read-only: two SELECTs, no writes, and (like netsuite-orders.mjs) it does not
// save a refreshed token back — a script racing the app to store one is a good
// way to invalidate the app's copy.
//
// The id half of the query is suiteqlQuery.orderIdsWithChangedFulfillments, the
// same builder the sync's discovery pass calls, so what this measures cannot
// drift from what the sync then does about it.
//
// Reading the output:
//   • MISSED rows > 0 — the gap is real, and the fulfillment discovery pass is
//     what closes it. Run this again afterwards and the same orders should show
//     up in the run's logs as "whose fulfillment changed".
//   • MISSED rows = 0 — this account bumps the sales order's own timestamp when
//     a fulfillment is written, so the sync was never blind here and a missing
//     shipment in Shopify has some other cause. Check the skip conditions in
//     app/lib/sync/shopify/tracking.server.js instead.

// A standalone node CLI: it reads process.env and uses Buffer, neither of which
// the eslint config grants outside the server-file filename pattern.
/* eslint-env node */
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";

import { oauthTokenUrl, suiteqlQuery, suiteqlUrl } from "../app/lib/netsuite/endpoints.server.js";
import { suiteqlTimestamp } from "../app/lib/netsuite/orders-query.server.js";
import { parseCustomRange } from "../app/lib/sync/windows.js";
import { isValidTimeZone } from "../app/lib/timezone/index.js";

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = { limit: "1000" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (["curl-only", "missed-only", "help"].includes(key)) out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

function die(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

if (args.help || !args.from || !args.to) {
  die("usage: node --env-file=.env scripts/netsuite-fulfillment-gap.mjs --from YYYY-MM-DD --to YYYY-MM-DD [--missed-only] [--curl-only]");
}

const prisma = new PrismaClient();

// The zone the two dates are read in. The app resolves this per shop (env
// override, else the Shopify store's own zone); a standalone script cannot reach
// the Shopify admin API, so it takes the env var or UTC and says which it used
// rather than pretending to know.
const timeZone = args.tz || (isValidTimeZone(process.env.SYNC_TIMEZONE) ? process.env.SYNC_TIMEZONE : "UTC");
if (!isValidTimeZone(timeZone)) die(`"${timeZone}" is not a timezone this runtime knows.`);

const range = parseCustomRange(args.from, args.to, timeZone);
if (range.error) die(range.error);

// suiteqlTimestamp, not a local renderer: this has to be spelled exactly the way
// the sync spells it, or the script would be measuring a different range than
// the one a run reads.
const from = suiteqlTimestamp(range.from, timeZone);
const to = suiteqlTimestamp(range.to, timeZone);

// The same query the sync's discovery pass sends, wrapped so the sales order's
// own timestamp comes back alongside — which is the whole comparison. The wrap
// lives here rather than in endpoints.server.js because the sync needs only the
// ids; the join back to `transaction` is this diagnostic's question alone.
const idsQuery = suiteqlQuery.orderIdsWithChangedFulfillments(from, to);
const gapQuery =
  `SELECT so.id AS orderid, so.tranid, so.status,
          TO_CHAR(so.lastmodifieddate, 'YYYY-MM-DD HH24:MI:SS') AS solastmodified,
          TO_CHAR(MAX(f.lastmodifieddate), 'YYYY-MM-DD HH24:MI:SS') AS fulfillmentlastmodified,
          COUNT(DISTINCT f.id) AS fulfillments
     FROM transaction f
     JOIN transactionline fl ON fl.transaction = f.id
     JOIN transaction so ON so.id = fl.createdfrom
    WHERE f.type = 'ItemShip'
      AND f.lastmodifieddate >= TO_DATE('${from}', 'YYYY-MM-DD HH24:MI:SS')
      AND f.lastmodifieddate <= TO_DATE('${to}', 'YYYY-MM-DD HH24:MI:SS')
    GROUP BY so.id, so.tranid, so.status, so.lastmodifieddate
    ORDER BY so.id`;

const url = suiteqlUrl({ limit: Number(args.limit), offset: 0 });

console.log(`
  range     ${args.from} -> ${args.to}   (read as ${timeZone})
  instants  ${range.from.toISOString()} -> ${range.to.toISOString()}
  literals  ${from} -> ${to}   (account time, as SuiteQL compares them)

  the sync's own discovery query:
${idsQuery.split("\n").map((l) => `  ${l.trim()}`).join("\n")}
`);

// The SQL is full of single quotes ('ItemShip', the date masks), and the curl
// body is wrapped in single quotes, so they have to be escaped the way a POSIX
// shell wants them or the printed command is one you cannot actually paste —
// which would defeat the point of printing it.
function shellSingleQuoted(text) {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

console.log(`  curl:

export NS_TOKEN="<access token>"
curl -sS -X POST \\
  -H "Authorization: Bearer $NS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -H "Prefer: transient" \\
  "${url}" \\
  -d ${shellSingleQuoted(JSON.stringify({ q: gapQuery.replace(/\s+/g, " ") }))}
`);

if (args["curl-only"]) process.exit(0);

try {
  const token = await accessToken(await resolveShop());
  const rows = await suiteql(url, token, gapQuery);

  // The comparison this script exists to make. A row is MISSED when the
  // fulfillment moved inside the range but the sales order's own timestamp did
  // not — which is exactly what the sales-order filter keys on, so the current
  // sync could not have discovered it.
  const judged = rows.map((r) => {
    const so = String(r.solastmodified || "");
    const seen = so >= from && so <= to;
    return { ...r, seenByCurrentSync: seen };
  });
  const missed = judged.filter((r) => !r.seenByCurrentSync);

  console.log(`  ${rows.length} sales order(s) had a fulfillment created or changed in this range.`);
  console.log(`  ${missed.length} of them have a sales-order timestamp OUTSIDE it — invisible to the current sync.\n`);

  const shown = args["missed-only"] ? missed : judged;
  if (shown.length) {
    console.log(`  ${"SO".padEnd(10)}${"tranid".padEnd(14)}${"SO modified".padEnd(21)}${"fulfillment modified".padEnd(21)}status`);
    for (const r of shown) {
      const flag = r.seenByCurrentSync ? "  seen  " : "  MISSED";
      console.log(
        `${flag} ${String(r.orderid).padEnd(9)}${String(r.tranid || "").padEnd(14)}${String(r.solastmodified || "").padEnd(21)}${String(r.fulfillmentlastmodified || "").padEnd(21)}${r.status || ""}`,
      );
    }
    console.log("");
  }

  const result = {
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    timeZone,
    literals: { from, to },
    total: rows.length,
    missed: missed.length,
    rows: judged,
  };

  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(result, null, 2));
    console.log(`  written to ${args.out}`);
  }
} catch (err) {
  die(err?.message || String(err));
} finally {
  await prisma.$disconnect();
}

// SuiteQL is a POST, not a GET — and it is refused outright without the
// `Prefer: transient` header. Pages the same way nsSuiteQl does, so a range with
// more fulfillments than one page cannot come back silently short.
async function suiteql(baseUrl, token, q) {
  const rows = [];
  const limit = Number(args.limit);
  for (let offset = 0; ; offset += limit) {
    const res = await fetch(suiteqlUrl({ limit, offset }), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        Prefer: "transient",
      },
      body: JSON.stringify({ q }),
      signal: AbortSignal.timeout(120000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`NetSuite SuiteQL failed: ${res.status} ${text.slice(0, 400)}`);
    const body = text ? JSON.parse(text) : null;
    const page = body?.items ?? [];
    rows.push(...page);
    if (!body?.hasMore || !page.length) return rows;
  }
}

// Which store's NetSuite connection to borrow. Named explicitly, or the only
// connected one — a script that picked arbitrarily between two accounts would be
// the worst kind of convenient.
async function resolveShop() {
  if (args.shop) return args.shop;
  const connected = await prisma.netsuiteAppSettings.findMany({
    where: { refreshToken: { not: null } },
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
