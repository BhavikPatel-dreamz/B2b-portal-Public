import { requestSyncStop } from "../lib/netsuite-oauth.server.js";
import { authenticate } from "../shopify.server";

// Stop the background run that is going right now, from the log page's Stop
// sync button.
//
//   POST /api/orders-sync-stop
//
// This does not kill anything. The run it stops was started detached (see
// startCronJobs) — often by the cron endpoint, possibly in another process — so
// there is no request to abort and no handle to cancel, and aborting one mid
// order would leave behind exactly the half-created order the sync lock exists
// to prevent. What it does is set a flag the run reads at its own safe points:
// between two orders and between two jobs. So the answer here is "asked", not
// "stopped", and the page keeps polling the lock to see it actually end.
//
// The delay between the two is one order — up to a few seconds of Shopify calls
// plus the deliberate rate-limit sleep — which is why the button reports
// "Stopping…" rather than going quiet.
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const { requested, already, runningSince } = await requestSyncStop(session.shop);
  if (!requested) {
    return { ok: false, error: "No sync is running — there is nothing to stop." };
  }

  const since = runningSince ? ` (started ${runningSince.toISOString()})` : "";
  return {
    ok: true,
    stopping: true,
    message: already
      ? `Stop already requested for the run in progress${since} — it finishes the order it is on first.`
      : `Stopping the sync${since}. It stops after the order it is on; everything already synced stays synced.`,
  };
};
