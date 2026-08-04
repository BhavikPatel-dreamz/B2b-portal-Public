// ---------------------------------------------------------------------------
// Your extra scheduled work
// ---------------------------------------------------------------------------
// Already wired into the schedule: CRON_JOBS in app/lib/cron-jobs.server.js runs
// this on every cron tick AND on every press of the log page's Sync now button,
// once per shop. Write what you need in the marked block below — nothing else
// has to change.
//
// `shop` is the myshopify domain ("vijay-checkout.myshopify.com"). It defaults to
// null so this can also be called by hand from a script with no shop in context,
// which is why the first thing it does is check for one.
//
// WHAT YOU RETURN is this job's `result` in the cron's JSON response and in the
// Sync now toast. Return something worth reading — what it did and how much, not
// just `true`:
//
//     return { updated: 12, skippedAlreadyDone: 3 };
//
// THROWING IS SAFE. runCronJobs catches it, logs it, reports this job as failed,
// and still runs the jobs after it. You do not need a try/catch for "this job
// broke"; you need one only if a PART of the work is allowed to fail while the
// rest carries on.
//
// You also do not need: a lock (startCronJobs holds one for the whole job list —
// taking another would deadlock on it), a shop loop (the callers already loop),
// or any registration beyond the entry that is already in CRON_JOBS.
//
// One thing to watch: jobs run one after another, and SYNC_MAX_RUN_MS is the
// ORDER SYNC's own budget, not a limit on this. Long work needs its own.

// The authenticated Shopify Admin GraphQL client for a shop.
//
// A scheduled run has no browser session, so it authenticates with the stored
// offline token — the same way the order sync does. Imported lazily rather than
// at the top of the file so that merely importing this module doesn't drag in
// the whole Shopify app config; that keeps it usable from a plain script or a
// test with no environment set up.
export async function adminFor(shop) {
  const { unauthenticated } = await import("../shopify.server.js");
  const { admin } = await unauthenticated.admin(shop);
  return admin;
}

export async function extraFunction(shop = null) {
  if (!shop) return { skipped: true, reason: "no shop given" };

  // =========================================================================
  // >>> WRITE YOUR WORK HERE <<<
  //
  // Example — count this shop's draft orders:
  //
  //   const admin = await adminFor(shop);
  //   const resp = await admin.graphql(`#graphql
  //     query DraftCount { draftOrders(first: 1) { nodes { id } } }`);
  //   const body = await resp.json();
  //   return { drafts: body?.data?.draftOrders?.nodes?.length ?? 0 };
  //
  // =========================================================================

  // Delete this once there is real work above — it is what makes an empty job
  // say so in the cron's response instead of quietly reporting success.
  return {
    skipped: true,
    reason: "extraFunction is empty — add your work in app/lib/extra-function.server.js",
  };
}
