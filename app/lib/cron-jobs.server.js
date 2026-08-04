import { extraFunction } from "./extra-function.server.js";
import { acquireSyncLock, releaseSyncLock } from "./netsuite-oauth.server.js";
import { logSyncCrash, syncOrdersFromFeed } from "./order-sync.server.js";

// ---------------------------------------------------------------------------
// What the scheduled run does
// ---------------------------------------------------------------------------
// The list below IS the schedule's work. Both callers walk it:
//
//   • the cron endpoint          — app/routes/api.cron.orders-sync.jsx
//   • the log page's "Sync now"  — app/routes/api.orders-sync-now.jsx
//
// so neither of them names a job directly, and neither has to change when the
// work does.
//
// ===========================================================================
// >>> TO ADD ANOTHER SCHEDULED TASK, ADD ONE ENTRY TO CRON_JOBS BELOW. <<<
//     Nothing else needs touching: the cron picks it up on its next tick and
//     the Sync now button picks it up on its next press, both per shop, both
//     already reporting its result and surviving its failure.
// ===========================================================================
//
// An entry is:
//
//   name    stable id, used in the JSON response and the logs. Don't rename a
//           live one — whoever greps the cron output for it will stop finding it.
//   label   how it's named to a human, in a toast or a log line.
//   run     async (shop, { window }) => result. `window` is set only when the run
//           was asked for an explicit stretch of time (the log page's range
//           dropdown). A job with no notion of a window simply ignores the
//           argument and does its normal work — that is why it is passed to
//           every job rather than only to the ones that asked for it.
//   onCrash optional. Called when `run` throws, to record the failure wherever
//           that job keeps its own history. The throw is caught and reported
//           either way; this is only for a job that has somewhere better to put
//           it than the response body.
//
// Order matters: jobs run one after another, never in parallel, because they
// share a shop's rate limits and API budget and a scheduled run is not in a
// hurry.
export const CRON_JOBS = [
  {
    name: "order-sync",
    label: "NetSuite order sync",
    // `lock` is forwarded so the sync doesn't try to take a lock the caller is
    // already holding. Undefined when runCronJobs was called directly, in which
    // case the sync takes its own — both paths work.
    run: (shop, { window, lock } = {}) => syncOrdersFromFeed(shop, { ...(window ? { window } : {}), lock }),
    // A run that died before producing a summary still has to leave a row in the
    // log table — a cron process's console output is gone by the time anyone
    // wonders what happened.
    onCrash: (shop, startedAt, err) => logSyncCrash(shop, startedAt, err),
  },

  // The slot kept open for whatever comes next, and the example of what a
  // second entry looks like: no lock (the caller holds one for the whole list),
  // no window (a job with no use for one doesn't declare the argument), no error
  // handling (runCronJobs catches, logs and reports, and the jobs after it still
  // run). It is wired up and running already — it just has nothing to do yet,
  // and says so in its result rather than reporting a silent success. Write the
  // work in extra-function.server.js and it starts happening on the next tick,
  // with no change here.
  {
    name: "extra-function",
    label: "Extra scheduled work",
    run: (shop) => extraFunction(shop),
  },
];

// Runs every job for one shop, in order.
//
// A job that throws is recorded and the rest still run: the whole point of a
// list is that one broken task doesn't cancel the others, and a scheduled run
// that stops at its first failure would quietly stop doing everything after it.
export async function runCronJobs(shop, options = {}) {
  const jobs = [];
  for (const job of CRON_JOBS) {
    const startedAt = new Date();
    try {
      jobs.push({ name: job.name, label: job.label, ok: true, result: await job.run(shop, options) });
    } catch (err) {
      const error = err?.message || String(err);
      console.error(`[cron] ${shop}: job "${job.name}" failed:`, error);
      try {
        await job.onCrash?.(shop, startedAt, err);
      } catch (logErr) {
        // Failing to record a failure is not a reason to lose the failure.
        console.warn(`[cron] ${shop}: job "${job.name}" could not log its crash:`, logErr?.message || logErr);
      }
      jobs.push({ name: job.name, label: job.label, ok: false, error });
    }
  }
  return jobs;
}

// Starts the scheduled run for a shop and comes back as soon as it is RUNNING,
// not when it has finished.
//
// This exists because the log page's Sync now button used to wait for the whole
// run over an HTTP request: a 50-order run spends ~70s in NetSuite alone (a
// second of deliberate rate-limit sleep per order), and a tunnel or proxy that
// cuts the connection at 60–100s made a perfectly good sync look like it had
// failed. Now the button gets an answer immediately and the page watches the
// lock instead.
//
// The lock is taken HERE, and awaited, which is the whole trick: by the time this
// returns, `syncStartedAt` is set, so the page that asked for the run already
// sees a run in progress. Acquiring it inside the background task would leave a
// gap where the page sees "not running" and reports the sync as finished before
// it began.
//
// Holding it across the whole job list (rather than per job) is also more correct
// than it was: the jobs of one scheduled run are one exclusive unit per shop.
export async function startCronJobs(shop, options = {}) {
  const startedAt = new Date();
  const lock = await acquireSyncLock(shop, startedAt);
  if (!lock.acquired) {
    return { started: false, heldSince: lock.heldSince ?? null };
  }

  const promise = (async () => {
    try {
      return await runCronJobs(shop, { ...options, lock });
    } finally {
      await releaseSyncLock(shop, lock.token);
    }
  })();
  // Nothing may reject out of here unobserved: a caller that doesn't await the
  // promise (the Sync now route, deliberately) would otherwise take the process
  // down with an unhandled rejection. runCronJobs already catches per job, so
  // this only ever fires if the release itself throws.
  promise.catch((err) => {
    console.error(`[cron] ${shop}: scheduled run failed outside its jobs:`, err?.message || err);
  });

  return { started: true, promise };
}

// The one job's result, by name — for a caller that needs to say something
// specific about it (the Sync now toast reports the order counts). Returns
// undefined if that job isn't in the list any more, which callers must treat as
// "not run" rather than "ran and did nothing".
export function jobResult(jobs, name) {
  return jobs.find((j) => j.name === name);
}
