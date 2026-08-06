import fs from "node:fs";
import path from "node:path";
import prisma from "../../db.server.js";
import { orderAttemptLimit } from "./log.server.js";

// ---------------------------------------------------------------------------
// Run log — storage/logs/order-sync-<shop>-<date>.log
// ---------------------------------------------------------------------------
// One appended block per cron run, so "what did the 09:15 run do, and why did
// those three orders fail" is answerable after the fact — the console output of a
// cron process is usually gone. The file is per day (per shop), which keeps it
// findable by date and stops a single file growing without bound.
//
// Writing the log must never be what breaks a sync, so every failure here is
// swallowed with a warning.
const LOG_DIR = "storage/logs";

// The run mode a manual re-sync logs under (see startResync). It reads as a
// normal live run to saveSyncLogRows — only "export…" modes are dry runs — but the
// file log words a few lines differently for it.
export const MANUAL_MODE = "manual re-sync";

function syncLogPath(shop, startedAt) {
  const day = startedAt.toISOString().slice(0, 10);
  return path.join(path.resolve(LOG_DIR), `order-sync-${shop}-${day}.log`);
}

// One line per order, plus indented detail lines for anything worth reading:
// the reason it was skipped, the error that failed it, the company chain that
// was built for it, the payment that was recorded.
function syncLogOrderLines(r) {
  const state = !r.ok ? "FAIL" : r.skipped ? "SKIP" : "OK  ";
  const ref = [r.externalId, r.reference].filter(Boolean).join(" ");
  const head = `  ${state} ${String(r.action || "?").padEnd(9)} ${ref}`;
  const lines = [];

  if (r.name || r.id) {
    lines.push(`${head} -> ${[r.name, r.id].filter(Boolean).join(" ")}`);
  } else {
    lines.push(head);
  }
  if (r.matchedBy) lines.push(`         matched by: ${r.matchedBy}${r.via && r.via !== r.matchedBy ? ` (${r.via})` : ""}`);
  if (r.financialStatus || r.fulfillmentStatus) {
    lines.push(`         status: ${r.financialStatus || "-"} / ${r.fulfillmentStatus || "-"}${r.total ? ` | total ${r.total}` : ""}`);
  }
  if (r.netsuiteCompany || r.company) {
    lines.push(`         company: ${r.company || "?"} / ${r.companyLocation || "?"}${r.companyCreated ? ` (created: ${r.companyCreated})` : ""}`);
  }
  if (r.lines) lines.push(`         items: ${r.lines}`);
  if (r.transactions?.length) lines.push(`         payment: ${r.transactions.join(" | ")}`);
  if (r.tracking) lines.push(`         tracking: ${r.tracking}`);
  // The shipment NetSuite reported, whether or not it carried a tracking
  // number. Without this line a skipped tracking row said only "no tracking
  // numbers", which reads as "nothing shipped" — and on this account the
  // opposite is usually true: the goods shipped, the number just wasn't
  // recorded. Only printed for rows that looked at a shipment at all.
  if (r.netsuiteFulfillments) {
    const parts = [
      `${r.netsuiteFulfillments} fulfillment(s)`,
      `${r.netsuiteTrackingNumbers || 0} tracking number(s)`,
      r.shipmentDate && `shipped ${r.shipmentDate}`,
      r.shipmentStatus,
      r.shippedVia && `via ${r.shippedVia}`,
      r.packageWeight != null && `${r.packageWeight} lb`,
    ].filter(Boolean);
    lines.push(`         shipment: ${parts.join(" | ")}`);
    // The requested method, only when it disagrees with what actually carried
    // the goods — printing both every time would bury the case that matters.
    if (r.shipMethod && r.shipMethod !== r.shippedVia) {
      lines.push(`         requested method: ${r.shipMethod}`);
    }
  }
  if (r.deletedId) lines.push(`         deleted: ${r.deletedId}`);
  if (r.reason) lines.push(`         reason: ${r.reason}`);
  if (r.warning) lines.push(`         warning: ${r.warning}`);
  if (r.error) lines.push(`         error: ${r.error}`);
  return lines;
}

function syncLogBlock(run) {
  const { shop, startedAt, finishedAt, since, window, targeted, mode, summary, results, error, files, extra } = run;
  const seconds = ((new Date(finishedAt) - new Date(startedAt)) / 1000).toFixed(1);
  const manual = mode === MANUAL_MODE;
  const lines = [
    "=".repeat(78),
    `[${startedAt}] order-sync ${shop}${mode ? ` (${mode})` : ""} — finished in ${seconds}s`,
  ];
  // A manual re-sync has no date window to report — the order list *is* the scope.
  if (window) {
    // Both ends, not just "since": this run was asked for a stretch that has
    // already ended, so what it did NOT look at is as much of the story as what
    // it did. The watermark note is here because a windowed run leaves it alone,
    // which is what stops "I synced the last hour" from skipping yesterday.
    lines.push(`  window: modified between ${window.from.toISOString()} and ${window.to.toISOString()} (${window.label}) — watermark not moved`);
    // NetSuite can only be asked for whole days (its q filter is date-granular),
    // so a short window always pulls more than it needs and drops the surplus.
    // Said out loud, because otherwise "the last hour matched 40 orders and synced
    // 3" reads like orders went missing.
    if (run.outsideWindow) {
      lines.push(`  ${run.outsideWindow} fetched order(s) fell outside the window (NetSuite filters by day) and were not synced`);
    }
  } else if (!manual) {
    lines.push(`  window: ${since ? `modified since ${since}` : "first run (initial lookback window)"}`);
  }
  if (targeted?.length) {
    const how = manual ? "requested" : "NETSUITE_ORDER_IDS";
    lines.push(`  targeted (${how}): ${targeted.join(", ")} (date window and watermark ignored)`);
  }
  if (run.stoppedEarly) lines.push(`  STOPPED EARLY: ${run.stoppedEarly}`);

  if (error) {
    // The run died before it could process anything — a NetSuite auth failure, a
    // Shopify connection error. This is the case the console would have lost.
    lines.push(`  RUN FAILED: ${error}`);
    return `${lines.join("\n")}\n`;
  }

  if (summary) {
    const byAction = {};
    for (const r of results || []) {
      const key = `${r.action || "?"}${!r.ok ? " failed" : r.skipped ? " skipped" : ""}`;
      byAction[key] = (byAction[key] || 0) + 1;
    }
    const breakdown = Object.entries(byAction).map(([k, n]) => `${k}: ${n}`).join(", ");
    lines.push(`  orders: ${summary.total} | success: ${summary.ok} | failed: ${summary.failed}`);
    if (breakdown) lines.push(`  breakdown: ${breakdown}`);
    // Failures first: the reason anyone opens this file.
    const ordered = [...(results || [])].sort((a, b) => Number(Boolean(a.ok)) - Number(Boolean(b.ok)));
    for (const r of ordered) lines.push(...syncLogOrderLines(r));
    // Quarantined orders are the reason a run can show failures AND still move
    // the watermark, so they have to be named — otherwise the two lines below
    // look like they contradict each other.
    if (run.quarantined?.length) {
      const list = run.quarantined.map((q) => `${q.order} (${q.attempts} runs)`).join(", ");
      lines.push(`  quarantined (SYNC_MAX_ORDER_ATTEMPTS=${orderAttemptLimit()}): ${list}`);
      lines.push("  ^ these keep failing and no longer hold the watermark back. They are still in the failed list and can be re-synced by hand.");
    }
    // A windowed run never moves the watermark in the first place, and its window
    // line has already said so.
    const holding = summary.failed - (run.quarantined?.length || 0);
    if (!manual && !window && (holding > 0 || run.stoppedEarly)) {
      const why = holding > 0 ? `${holding} failed` : "stopped early";
      lines.push(`  watermark NOT advanced (${why}) — the next run re-pulls this window and continues.`);
    }
  }
  // Only worth a line when it did something or broke — an empty slot saying
  // "nothing to do" on every single run would be noise.
  if (extra?.failed) lines.push(`  extra work FAILED: ${extra.error}`);
  else if (extra && !extra.skipped) lines.push(`  extra work: ${JSON.stringify(extra)}`);
  for (const [label, file] of Object.entries(files || {})) lines.push(`  ${label}: ${file}`);
  return `${lines.join("\n")}\n`;
}

export function writeSyncLog(run) {
  try {
    fs.mkdirSync(path.resolve(LOG_DIR), { recursive: true });
    const file = syncLogPath(run.shop, new Date(run.startedAt));
    fs.appendFileSync(file, syncLogBlock(run));
    return file;
  } catch (err) {
    console.warn(`[order-sync] could not write the run log: ${err?.message || err}`);
    return null;
  }
}

// One order's result as an OrderSyncLog row. Split out because the same mapping
// is now used twice: once per order while the run works (see appendSyncLogRow)
// and once at the end for the rows that describe the run rather than an order.
function syncLogRow(base, r) {
  return {
    ...base,
    externalId: r.externalId ? String(r.externalId) : null,
    reference: r.reference || null,
    action: r.action || "unknown",
    status: !r.ok ? "failed" : r.skipped ? "skipped" : "success",
    orderName: r.name || null,
    orderId: r.id || null,
    company: r.company || r.netsuiteCompany || null,
    message: r.error || r.reason || r.warning || null,
    detail: JSON.stringify(r),
  };
}

// The `base` every row of one run shares. `runAt` is the run's start for all of
// them, which is what groups a run together in the table and what the newest-first
// ordering sorts on.
export function syncLogBase(run) {
  return {
    shop: run.shop,
    runAt: new Date(run.startedAt),
    mode: run.mode?.startsWith("export") ? "export" : "live",
  };
}

// Write ONE order's row, the moment that order is done.
//
// The rows used to be written in a single batch when the run ended, which meant
// that for however long a run took — minutes, on a big window — the table said
// nothing at all, and everything arrived at once at the end. Now each order lands
// as it finishes, so the table fills in while the run works and the newest row is
// always the order being worked on.
//
// `finishedAt` is per row here, and means what it says: when THAT order finished,
// not when the run did.
//
// Never allowed to fail the sync, for the same reason the batch write wasn't: the
// order is already in Shopify by this point, and losing the log of it is not a
// reason to report the run as broken.
export async function appendSyncLogRow(base, result) {
  try {
    await prisma.orderSyncLog.create({
      data: { ...syncLogRow(base, result), finishedAt: new Date() },
    });
  } catch (err) {
    console.warn(`[order-sync] ${base.shop}: could not write the log row for ${result.externalId}: ${err?.message || err}`);
  }
}

// The rest of the run's rows — the ones that describe the RUN rather than one
// order: a crash, a stop before any order was reached, or a clean run with
// nothing to do. The per-order rows are already in the table by now
// (appendSyncLogRow), so they are deliberately not written again here.
//
// Like the file log, a failure here is never allowed to fail the sync.
// `logged` is the set of results already written by appendSyncLogRow while the
// run worked, compared by identity. Everything in run.results that is NOT in it
// still needs a row here — the fetch failures, which never reach
// processOrderRecords, and every result of an export dry run, which has no
// per-order loop at all. Filtering rather than skipping is what keeps those from
// silently disappearing now that the per-order rows are written earlier.
export async function saveSyncLogRows(run, logged = new Set()) {
  const finishedAt = run.finishedAt ? new Date(run.finishedAt) : null;
  const base = { ...syncLogBase(run), finishedAt };

  const rows = run.error
    ? [{ ...base, action: "run", status: "failed", message: run.error, detail: JSON.stringify({ error: run.error }) }]
    : (run.results || []).filter((r) => !logged.has(r)).map((r) => syncLogRow(base, r));
  // Whether this run put ANY per-order row in the table — counting both the ones
  // written as it went and the ones about to be written above. The blocks below
  // used to ask `rows.length`, which was the whole story when every row was built
  // here; it no longer is. Getting this wrong in either direction is visible: too
  // eager and a busy run gets a spurious "nothing to do" row, too shy and a
  // stopped run leaves the table completely silent.
  const wroteOrderRows = logged.size > 0 || rows.length > 0;
  // A run that stopped before it reached a single order has no per-order rows, so
  // without this it would leave nothing at all in the table — the one place
  // anyone looks after pressing Stop sync, and the last place that should stay
  // silent about it. Same shape as the crash row: one "run" row, carrying the
  // reason.
  if (!wroteOrderRows && run.stoppedEarly) {
    rows.push({
      ...base,
      action: "run",
      status: "skipped",
      message: run.stoppedEarly,
      detail: JSON.stringify({ reason: run.stoppedEarly }),
    });
  } else if (!wroteOrderRows && !run.error) {
    // A run that finished cleanly and simply had nothing to do — a narrow window
    // ("last 1 hour") with no orders modified in it, most often. Without a row
    // here the table looks EXACTLY the same after this run as it did after one
    // that never ran at all, and there is no way from the page alone to tell
    // "nothing happened" from "nothing to do" — which is precisely the question
    // someone is asking when they picked a short window and the table stayed
    // empty. outsideWindow, when this was a windowed run, is the difference
    // between "0 orders exist in this window" (outsideWindow: 0, nothing to see)
    // and "N orders exist nearby but none fall inside this exact window" (a
    // real count, proof the window is doing its job rather than matching
    // nothing because something upstream is broken).
    // Targeted mode (NETSUITE_ORDER_IDS or a manual re-sync) resolves a hand-picked
    // id list and ignores the window entirely (see fetchNetsuiteOrders), so it has
    // to be checked before run.window here — otherwise a targeted run that also
    // carried a dropdown window would blame the window for zero matches, when the
    // window was never looked at.
    const scope = run.targeted?.length
      ? `${run.targeted.length} targeted order(s)`
      : run.window
        ? `${run.window.label} (${run.window.from.toISOString()} → ${run.window.to.toISOString()})`
        : run.since
          ? `orders modified since ${run.since}`
          : "this run's scope";
    const outside = run.outsideWindow
      ? ` — ${run.outsideWindow} order(s) nearby were modified outside it`
      : "";
    rows.push({
      ...base,
      action: "run",
      status: "skipped",
      message: `No matching orders for ${scope}${outside}.`,
      detail: JSON.stringify({
        reason: "no matching orders",
        window: run.window ? { from: run.window.from.toISOString(), to: run.window.to.toISOString(), label: run.window.label } : null,
        outsideWindow: run.outsideWindow || 0,
        since: run.since || null,
        targeted: run.targeted || [],
      }),
    });
  } else if (run.stoppedEarly) {
    // The run DID find and process orders, but stoppedEarly is also set here for
    // a reason that isn't about any one of them — most often the filter
    // capping the run, which is exactly the situation that makes a window pick
    // ("last 1 hour" vs "last 3 hours") look like it did nothing: every window
    // wide enough to contain more than the limit reports the same capped count,
    // and until now nothing said why — this reason lived only in the server's
    // own file log (storage/logs), never in the table anyone actually looks at.
    // A second row, not a replacement for the per-order ones: those are still
    // the record of what happened to each order, this is the record of what
    // happened to the RUN.
    rows.push({
      ...base,
      action: "run",
      status: "skipped",
      message: run.stoppedEarly,
      detail: JSON.stringify({ reason: run.stoppedEarly }),
    });
  }
  if (!rows.length) return 0;

  try {
    await prisma.orderSyncLog.createMany({ data: rows });
    return rows.length;
  } catch (err) {
    // One bad row (an oversized detail payload, an odd character) must not cost
    // every other order's log entry — createMany is all-or-nothing, so fall back
    // to inserting one at a time and keep whatever succeeds. Slower, but this
    // only happens when the batch insert has already failed once.
    console.warn(`[order-sync] could not save the run log as a batch, retrying row by row: ${err?.message || err}`);
    let saved = 0;
    for (const row of rows) {
      try {
        await prisma.orderSyncLog.create({ data: row });
        saved++;
      } catch (rowErr) {
        console.warn(`[order-sync] could not save one sync log row: ${rowErr?.message || rowErr}`);
        // Whatever made this specific row unsaveable (oversized detail, a bad
        // character) is a formatting problem, not proof nothing happened to
        // this order — fall back to a minimal row with the same identity so
        // the order doesn't just vanish from the table, and say why it's thin.
        try {
          await prisma.orderSyncLog.create({
            data: {
              ...base,
              externalId: row.externalId ?? null,
              reference: row.reference ?? null,
              action: row.action ?? "unknown",
              status: row.status ?? "failed",
              orderName: row.orderName ?? null,
              orderId: row.orderId ?? null,
              company: row.company ?? null,
              message: `Could not save full log row: ${rowErr?.message || rowErr}`,
              detail: JSON.stringify({ reason: "log row save failed", error: rowErr?.message || String(rowErr) }),
            },
          });
          saved++;
        } catch (fallbackErr) {
          console.warn(`[order-sync] could not save fallback row either: ${fallbackErr?.message || fallbackErr}`);
        }
      }
    }
    return saved;
  }
}

// Retention. Without this both logs grow for the life of the app — a cron running
// every 15 minutes over 50 orders writes ~5k rows a day. Nothing here is allowed
// to fail the sync either; an unprunable log is not a broken run.
const DEFAULT_RETENTION_DAYS = 90;

function retentionDays() {
  const n = Number(process.env.SYNC_LOG_RETENTION_DAYS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RETENTION_DAYS;
}

export async function pruneSyncLogs(shop) {
  const days = retentionDays();
  // 0 turns retention off rather than deleting everything.
  if (!days) return;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  try {
    const { count } = await prisma.orderSyncLog.deleteMany({
      where: { shop, runAt: { lt: cutoff } },
    });
    if (count) console.log(`[order-sync] pruned ${count} log row(s) older than ${days} day(s).`);
  } catch (err) {
    console.warn(`[order-sync] could not prune old log rows: ${err?.message || err}`);
  }

  // The daily files are named order-sync-<shop>-<YYYY-MM-DD>.log, so the date in
  // the name is what decides — no need to stat anything.
  try {
    const dir = path.resolve(LOG_DIR);
    if (!fs.existsSync(dir)) return;
    const prefix = `order-sync-${shop}-`;
    const cutoffDay = cutoff.toISOString().slice(0, 10);
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith(".log")) continue;
      const day = name.slice(prefix.length, -4);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoffDay) {
        fs.unlinkSync(path.join(dir, name));
        console.log(`[order-sync] pruned old log file ${name}.`);
      }
    }
  } catch (err) {
    console.warn(`[order-sync] could not prune old log files: ${err?.message || err}`);
  }
}

// For the cron route: a run that threw before syncOrdersFromFeed could return
// leaves no summary, and that is exactly the run worth keeping.
export async function logSyncCrash(shop, startedAt, error) {
  const run = {
    shop,
    startedAt: (startedAt instanceof Date ? startedAt : new Date(startedAt)).toISOString(),
    finishedAt: new Date().toISOString(),
    error: error?.message || String(error),
  };
  const logFile = writeSyncLog(run);
  await saveSyncLogRows(run);
  return logFile;
}

