import { requestSyncStop } from "../lib/netsuite/oauth.server.js";
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
// to prevent. What it does is set a flag the run reads at every point where
// putting the work down is safe: between two orders, between two jobs, between
// two fetched pages, and around every deliberate pause. So the answer here is
// "asked", not "stopped", and the page keeps polling the lock to see it end.
//
// The gap between the two used to be most of a minute — a run asleep in a
// rate-limit pause or a 429 back-off wasn't looking at the flag, and the whole
// fetch phase had nowhere to stop at all. Now requestSyncStop also wakes the run
// in-process (see fireStopSignal) and every pause is cut short, so the worst case
// is the order currently being written to Shopify, which is finished on purpose:
// half an order is worse than a slow stop.
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
      : `Stopping the sync${since}. It puts everything down after the order it is on; everything already synced stays synced.`,
  };
};
