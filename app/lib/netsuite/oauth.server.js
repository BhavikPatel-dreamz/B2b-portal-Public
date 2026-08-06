import crypto from "node:crypto";
import prisma from "../../db.server.js";
import { oauthAuthorizeUrl, oauthTokenUrl } from "./endpoints.server.js";

// ---------------------------------------------------------------------------
// NetSuite OAuth 2.0 (Authorization Code Grant)
// ---------------------------------------------------------------------------
// NetSuite's Integration record issues one Consumer Key/Secret pair that
// serves as both the OAuth 1.0 TBA consumer credentials and the OAuth 2.0
// client_id/client_secret (same record, different grant-type checkbox) — so
// NETSUITE_CONSUMER_KEY/SECRET are reused here as the OAuth2 client creds.
// Docs: https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_157771733782.html

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`NetSuite OAuth: missing ${name} env var`);
  return v;
}

// The redirect URI has to match the one registered on the NetSuite Integration
// record character for character, and NetSuite only checks it AFTER the user has
// logged in — a mismatch comes back as the login page saying "Your login attempt
// was not successful", with nothing said about the URI. Same for a wrong
// client_id or a scope the integration doesn't grant: every parameter problem
// wears the same login failure.
//
// So it gets its own env var. Deriving it from SHOPIFY_APP_URL alone can't work
// in dev: `shopify app dev` overwrites that with a fresh tunnel URL on every run,
// so the redirect_uri moves while the Integration record's stays put, and connect
// silently breaks the next morning. Set NETSUITE_REDIRECT_URI to the exact string
// pasted into NetSuite (Setup → Integration → Manage Integrations → your record →
// OAuth 2.0 → Redirect URI) and it stops mattering where the app is running.
export function redirectUri() {
  const explicit = (process.env.NETSUITE_REDIRECT_URI || "").trim();
  // Used verbatim, not normalised: NetSuite compares the raw string, so
  // "helpfully" adding or stripping a trailing slash here is itself a mismatch.
  if (explicit) return assertHttps(explicit);

  const appUrl = (process.env.SHOPIFY_APP_URL || "").trim().replace(/\/+$/, "");
  if (!appUrl) {
    throw new Error(
      "NetSuite OAuth: set NETSUITE_REDIRECT_URI to the Redirect URI registered on the NetSuite Integration record. "
        + "(SHOPIFY_APP_URL is empty, and under `shopify app dev` its tunnel value changes every run, so it can't be used as the callback.)",
    );
  }
  return assertHttps(`${appUrl}/api/netsuite/callback`);
}

function assertHttps(uri) {
  if (!/^https:\/\//i.test(uri)) {
    throw new Error(
      `NetSuite OAuth: redirect URI must start with https:// — got "${uri}". NetSuite rejects http and localhost callbacks.`,
    );
  }
  return uri;
}

// Signs `shop` into a state param NetSuite echoes back on the callback, so we
// can recover which shop started the flow without cookies/session storage
// across the external redirect (NetSuite's redirect is a bare top-level nav).
//
// A random nonce is included so every Connect click produces a unique state —
// NetSuite rejects repeated state values with a "login attempt" error.
export function signState(shop) {
  const nonce = crypto.randomBytes(16).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ shop, nonce }), "utf8").toString("base64url");
  const sig = crypto
    .createHmac("sha256", required("SHOPIFY_API_SECRET"))
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyState(state) {
  const [payload, sig] = String(state || "").split(".");
  if (!payload || !sig) return null;
  const expected = crypto
    .createHmac("sha256", required("SHOPIFY_API_SECRET"))
    .update(payload)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.shop || null;
  } catch {
    // Fallback: old-format state without nonce (plain shop string)
    return Buffer.from(payload, "base64url").toString("utf8");
  }
}

export function buildAuthorizeUrl(shop) {
  const uri = redirectUri();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: required("NETSUITE_CONSUMER_KEY"),
    redirect_uri: uri,
    // Both scopes have to be ticked on the Integration record; asking for one it
    // doesn't grant fails the login rather than the authorization.
    scope: "restlets rest_webservices",
    // NetSuite requires state to be at least 24 characters — signState is well
    // past that, but a shorter one would fail the same anonymous way.
    state: signState(shop),
  });
  // Logged because this is the string NetSuite compares against, and the only way
  // to see the mismatch is to read both sides: everything else about a wrong
  // redirect URI is invisible until the login page refuses the user.
  console.info(`[netsuite] authorize for ${shop} with redirect_uri=${uri}`);
  return oauthAuthorizeUrl(params);
}

async function tokenRequest(body) {
  const consumerKey = required("NETSUITE_CONSUMER_KEY");
  const consumerSecret = required("NETSUITE_CONSUMER_SECRET");
  const basicAuth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");

  const res = await fetch(oauthTokenUrl(), {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(body).toString(),
    // Bounded like every other NetSuite call: this one runs before the first
    // request of a sync, so a stall here would hang the whole run (see the
    // timeout note in netsuite.server.js).
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`NetSuite token request failed: ${res.status} ${text}`);
  }
  return JSON.parse(text);
}

export function exchangeCodeForTokens(code) {
  return tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
  });
}

export function refreshAccessToken(refreshToken) {
  return tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

export async function saveTokens(shop, tokens) {
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  const existing = await prisma.netsuiteAppSettings.findUnique({
    where: { shop },
    select: { connectedAt: true },
  });

  await prisma.netsuiteAppSettings.upsert({
    where: { shop },
    create: {
      shop,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiresAt: expiresAt,
      connectedAt: new Date(),
    },
    update: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiresAt: expiresAt,
      ...(existing?.connectedAt ? {} : { connectedAt: new Date() }),
    },
  });
}

const EXPIRY_SKEW_MS = 60_000;

export async function getValidAccessToken(shop) {
  const settings = await prisma.netsuiteAppSettings.findUnique({ where: { shop } });
  if (!settings?.refreshToken) {
    throw new Error(`NetSuite not connected for shop ${shop} — visit /api/netsuite/connect first`);
  }

  const expiresAt = settings.tokenExpiresAt?.getTime() ?? 0;
  if (expiresAt - EXPIRY_SKEW_MS > Date.now()) {
    return settings.accessToken;
  }

  const tokens = await refreshAccessToken(settings.refreshToken);
  await saveTokens(shop, tokens);
  return tokens.access_token;
}

export async function disconnectTokens(shop) {
  await prisma.netsuiteAppSettings.updateMany({
    where: { shop },
    data: {
      accessToken: null,
      refreshToken: null,
      tokenExpiresAt: null,
      connectedAt: null,
    },
  });
}

// Incremental-sync watermark: the start time of the last successful order sync.
export async function getLastSyncedAt(shop) {
  const settings = await prisma.netsuiteAppSettings.findUnique({
    where: { shop },
    select: { lastSyncedAt: true },
  });
  return settings?.lastSyncedAt ?? null;
}

// upsert, not updateMany: updateMany matches zero rows when the shop has no
// NetsuiteAppSettings row yet and reports success anyway, so the watermark was
// silently never written and every run re-pulled the initial window forever.
// `shop` is @unique, and every other column is optional, so creating the row
// here is safe.
//
// `from` is the other end of the window this run covered (the `since` it ran
// with, null on a first run). Stored alongside the watermark so the app can say
// what the last scheduled run actually looked at, not just when it happened —
// see getSyncSchedule.
//
// Also clears syncListOffset: the watermark only ever advances here when a
// period is FULLY drained (see runOrderSync), so whatever cursor a previous
// capped run left behind belongs to a period that no longer exists — a fresh
// one starts its list from the top. Leaving a stale offset in place would have
// the next period's first run skip straight past however many candidates the
// old period happened to end on, silently dropping that many real orders.
export async function setLastSyncedAt(shop, date, from = null) {
  await prisma.netsuiteAppSettings.upsert({
    where: { shop },
    update: { lastSyncedAt: date, lastSyncFrom: from, syncListOffset: null },
    create: { shop, lastSyncedAt: date, lastSyncFrom: from },
  });
}

// The same move, made by a WINDOWED run (Sync now) that finished cleanly: the
// watermark goes to the END of the window that was just covered, not to the run's
// start time — a run asked about 1pm→2pm proves nothing about 2pm→now.
//
// Only ever forwards. Syncing an old custom range by hand is a normal thing to
// do, and letting it drag the watermark backwards would have the next scheduled
// run re-read everything since. The comparison is written into the UPDATE rather
// than done in JS so a cron run finishing at the same moment can't lose to a
// read-then-write race.
//
// The trade-off this accepts: the stretch between the old watermark and the
// window's start is now behind the watermark without ever having been read, so a
// hand-run window is also a decision to skip whatever the schedule still owed
// before it. That is the point — it is what stops a shop whose scheduled runs
// have never succeeded from re-reading the whole initial lookback forever.
export async function advanceWatermarkToWindow(shop, { from, to }) {
  await prisma.netsuiteAppSettings.upsert({
    where: { shop },
    update: {},
    create: { shop },
  });
  await prisma.netsuiteAppSettings.updateMany({
    where: {
      shop,
      OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: to } }],
    },
    // syncListOffset clears for the same reason it does above: the period that
    // cursor belonged to is behind the watermark now.
    data: { lastSyncedAt: to, lastSyncFrom: from ?? null, syncListOffset: null },
  });
}

// The other half of draining a backlog bigger than one list call across
// runs: how far into the current period's list a previous capped-but-clean run
// got. 0 for a period that hasn't been capped yet (or ever).
export async function getSyncListOffset(shop) {
  const settings = await prisma.netsuiteAppSettings.findUnique({
    where: { shop },
    select: { syncListOffset: true },
  });
  return settings?.syncListOffset ?? 0;
}

// Moves the list cursor forward WITHOUT touching the watermark — the run that
// calls this got capped again, so this period is still not fully drained, and
// advancing the watermark here would let a later run believe it was. Only the
// position within the (unchanged) day-granular query moves.
export async function setSyncListOffset(shop, offset) {
  await prisma.netsuiteAppSettings.upsert({
    where: { shop },
    update: { syncListOffset: offset },
    create: { shop, syncListOffset: offset },
  });
}

// The windowed-run equivalent of getSyncListOffset/setSyncListOffset — see the
// schema comment on syncWindowOffset for why a windowed run needs its own
// session (query + hours) rather than just an offset: unlike the watermark,
// there is no other state that already identifies "which period is this".
export async function getSyncWindowResume(shop) {
  const settings = await prisma.netsuiteAppSettings.findUnique({
    where: { shop },
    select: { syncWindowOffset: true, syncWindowQuery: true, syncWindowHours: true },
  });
  return {
    offset: settings?.syncWindowOffset ?? 0,
    query: settings?.syncWindowQuery ?? null,
    hours: settings?.syncWindowHours ?? null,
  };
}

// Persists where a capped-but-clean windowed run got to, alongside the exact
// question it was answering (query + hours) so a later request can tell
// whether it is safe to resume from this or whether it is asking something
// else and must start over.
export async function setSyncWindowResume(shop, { offset, query, hours }) {
  await prisma.netsuiteAppSettings.upsert({
    where: { shop },
    update: { syncWindowOffset: offset, syncWindowQuery: query, syncWindowHours: hours },
    create: { shop, syncWindowOffset: offset, syncWindowQuery: query, syncWindowHours: hours },
  });
}

// Called once a windowed run's candidate list is fully drained (not capped) —
// there is nothing left to resume, and leaving the old session behind would
// only risk a later, unrelated request mistaking it for a match by coincidence.
export async function clearSyncWindowResume(shop) {
  await prisma.netsuiteAppSettings.updateMany({
    where: { shop },
    data: { syncWindowOffset: null, syncWindowQuery: null, syncWindowHours: null },
  });
}

// What the last successful scheduled run covered: { from, to }. `to` is the
// watermark — the run's own start time, which is where the next run picks up —
// and `from` is where that run started reading. Both null before the first
// successful sync.
export async function getLastSyncWindow(shop) {
  const settings = await prisma.netsuiteAppSettings.findUnique({
    where: { shop },
    select: { lastSyncedAt: true, lastSyncFrom: true },
  });
  return { from: settings?.lastSyncFrom ?? null, to: settings?.lastSyncedAt ?? null };
}

// ---------------------------------------------------------------------------
// Per-shop sync run lock
// ---------------------------------------------------------------------------
// Cron fires on a fixed interval and has no idea whether the previous run is
// still going. Two runs over the same window race: both look up the same new B2B
// company, both find none, and both create it — and every later order for that
// company then fails on "the shop has 2 companies named X". The lock is a single
// conditional UPDATE, which the database applies atomically, so exactly one
// caller can win it.
//
// A run that dies without releasing (process killed, host restarted) would
// otherwise block the shop forever, so a lock older than the stale timeout is
// taken over. The timeout has to stay comfortably above SYNC_MAX_RUN_MS or a
// still-healthy long run would be taken over while it works.
const DEFAULT_LOCK_STALE_MS = 30 * 60 * 1000;

function lockStaleMs() {
  const n = Number(process.env.SYNC_LOCK_STALE_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LOCK_STALE_MS;
}

// Returns { acquired: true, token } — `token` must be handed back to
// releaseSyncLock — or { acquired: false, heldSince } when another run owns it.
export async function acquireSyncLock(shop, startedAt = new Date()) {
  // updateMany below can only match a row that exists; a shop syncing for the
  // first time has none yet.
  await prisma.netsuiteAppSettings.upsert({
    where: { shop },
    update: {},
    create: { shop },
  });

  const staleBefore = new Date(startedAt.getTime() - lockStaleMs());
  const { count } = await prisma.netsuiteAppSettings.updateMany({
    where: {
      shop,
      OR: [{ syncStartedAt: null }, { syncStartedAt: { lt: staleBefore } }],
    },
    // The stop request is cleared as part of taking the lock: it belonged to the
    // run that has just ended (or to one that died holding the lock), and a flag
    // left behind would stop the next run before it did anything — the failure
    // mode being that Stop sync, pressed once, silently becomes permanent.
    //
    // The progress counters reset here rather than on release, so the numbers
    // from the last run stay readable until a new one actually starts.
    data: {
      syncStartedAt: startedAt,
      syncStopRequestedAt: null,
      syncTotalOrders: null,
      syncDoneOrders: null,
      syncPhase: null,
    },
  });
  if (count === 1) {
    // Armed with the lock, for the same reason the flag is cleared with it: the
    // signal belongs to this run and to no other. See fireStopSignal.
    armStopSignal(shop, startedAt);
    return { acquired: true, token: startedAt };
  }

  const held = await prisma.netsuiteAppSettings.findUnique({
    where: { shop },
    select: { syncStartedAt: true },
  });
  return { acquired: false, heldSince: held?.syncStartedAt ?? null };
}

// Clears the lock, but ONLY if this run still owns it: a run that overran the
// stale timeout and was taken over must not release the lock the new run is
// holding.
export async function releaseSyncLock(shop, token) {
  if (!token) return;
  const { count } = await prisma.netsuiteAppSettings.updateMany({
    where: { shop, syncStartedAt: token },
    data: { syncStartedAt: null, syncStopRequestedAt: null },
  });
  // Only when this run really did still own the lock. A run that overran the
  // stale timeout and was taken over must not drop the signal armed by the run
  // that took over from it — the same reason the row update is scoped to `token`.
  if (count) disarmStopSignal(shop, token);
}

// ---------------------------------------------------------------------------
// Stopping a run that is already going
// ---------------------------------------------------------------------------
// A scheduled run happens in the background with nobody holding its promise, so
// there is no request to cancel and no handle to kill — and killing it is not
// what anyone wants anyway: a run interrupted between the two calls that create
// an order and attach its company leaves exactly the half-made record the sync
// lock exists to prevent. So a stop is a REQUEST, written here and read by the
// run itself at the points where it is safe to stop: between orders and between
// jobs. What it finished is logged and the watermark stays where it was, which
// is the same shape as the run-time budget's stopped-early exit.
//
// Refused when nothing is running, so the button can't arm a flag that the NEXT
// run would then pick up.
//
// The flag in the database is the thing that is true; the in-process signal
// beside it (see fireStopSignal) is only how fast the run finds out.
export async function requestSyncStop(shop) {
  const runningSince = await getSyncRunningSince(shop);
  if (!runningSince) return { requested: false, runningSince: null };

  const existing = await prisma.netsuiteAppSettings.findUnique({
    where: { shop },
    select: { syncStopRequestedAt: true },
  });
  if (existing?.syncStopRequestedAt) {
    return { requested: true, already: true, runningSince, requestedAt: existing.syncStopRequestedAt };
  }

  const requestedAt = new Date();
  // Scoped to the lock this stop was asked about: if that run ended and another
  // took over between the check above and here, the flag would otherwise land on
  // a run nobody asked to stop.
  const { count } = await prisma.netsuiteAppSettings.updateMany({
    where: { shop, syncStartedAt: runningSince },
    data: { syncStopRequestedAt: requestedAt },
  });
  if (!count) return { requested: false, runningSince: null };
  // Wake the run NOW if it is in this process — see fireStopSignal.
  fireStopSignal(shop);
  return { requested: true, already: false, runningSince, requestedAt };
}

// ---------------------------------------------------------------------------
// The in-process half of a stop: making the run notice at once
// ---------------------------------------------------------------------------
// The flag above is durable and works across processes, but on its own it is
// only ever seen when something goes looking for it, and a run spends most of
// its time NOT looking: asleep in a rate-limit pause, or waiting out a 429
// back-off that doubles to 24 seconds. Pressing Stop and then watching the sync
// carry on for another minute is what that felt like.
//
// So the stop is delivered twice. The row is written for correctness — another
// process's run, or this one at its next boundary, still finds it. This
// AbortController is written for latency: the Stop route and the background run
// are usually the same Node process, so aborting it wakes every sleep in that
// run in the same tick the button was pressed.
//
// Keyed by shop and armed when the lock is taken, so a signal can never outlive
// the run it belongs to and stop the next one — the same hazard the flag itself
// is cleared for in acquireSyncLock. Each entry carries the lock `token`
// (syncStartedAt) it was armed with, for the same reason releaseSyncLock scopes
// its own UPDATE to `token`: a stale-lock takeover and the old run's release can
// land in either order, and without this the old run's release — resolving
// after the new run has already armed — could delete the NEW run's controller
// instead of its own. Scoping the delete to the token it was armed with makes
// that a no-op: it only ever removes the entry it created.
const stopSignals = new Map();

// Called when a run takes the lock: a fresh, un-aborted signal for the new run.
function armStopSignal(shop, token) {
  stopSignals.set(shop, { controller: new AbortController(), token });
}

// Called when a run releases the lock. Dropped rather than aborted — an abort
// here would look, to anything still holding the signal, exactly like a stop
// nobody asked for. Only removes the entry if it's still the one THIS run
// armed — see the note above stopSignals.
function disarmStopSignal(shop, token) {
  if (stopSignals.get(shop)?.token === token) stopSignals.delete(shop);
}

// Called by requestSyncStop. A no-op when the run is in another process, which
// is exactly the case the database flag covers.
function fireStopSignal(shop) {
  stopSignals.get(shop)?.controller.abort();
}

// True when this process's run has already been told to stop — free to ask, no
// query behind it. Callers use it to avoid a database round trip they know the
// answer to.
export function isStopSignalled(shop) {
  return Boolean(stopSignals.get(shop)?.controller.signal.aborted);
}

// Read by the run at every point where stopping is safe — between orders, between
// jobs, between fetched pages, and around every deliberate pause. Cheap enough to
// ask that often: the in-process signal answers most calls with no query at all,
// and an order costs several API calls, so one indexed lookup beside it is noise.
export async function isSyncStopRequested(shop) {
  if (isStopSignalled(shop)) return true;
  const settings = await prisma.netsuiteAppSettings.findUnique({
    where: { shop },
    select: { syncStopRequestedAt: true },
  });
  return Boolean(settings?.syncStopRequestedAt);
}

// How often a sleep that is waiting out a long pause re-asks the DATABASE. Only
// matters when the run and the Stop button are in different processes; in one
// process the signal has already woken it and this never fires.
const STOP_POLL_MS = 1000;

// sleep(), except a stop cuts it short.
//
// Every deliberate pause in a run goes through this: the per-order rate-limit
// second, the paging pauses, the 429 back-off. They exist to be polite to
// NetSuite, and once a run has been called off there is nothing left to be
// polite about — finishing the pause only delays the stop by exactly its length.
//
// Resolves true if it slept the whole way, false if a stop cut it short. Callers
// that are about to do more work should check the answer rather than assume they
// waited.
export async function sleepUnlessStopped(shop, ms) {
  const controller = stopSignals.get(shop)?.controller;
  if (controller?.signal.aborted) return false;

  return new Promise((resolve) => {
    let poll;
    const finish = (slept) => {
      clearTimeout(timer);
      clearInterval(poll);
      controller?.signal.removeEventListener("abort", onAbort);
      resolve(slept);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    controller?.signal.addEventListener("abort", onAbort, { once: true });

    // The cross-process fallback, and only worth its queries on a pause long
    // enough for one to land inside it — a one-second rate-limit sleep is
    // shorter than the delay polling would save.
    if (ms > STOP_POLL_MS * 2) {
      poll = setInterval(async () => {
        try {
          if (await isSyncStopRequested(shop)) finish(false);
        } catch {
          // A failed lookup is not a stop. Sleep on and let the next boundary ask.
        }
      }, STOP_POLL_MS);
    }
  });
}

// Thrown when a NetSuite call gives up because the run was stopped rather than
// because anything went wrong. Carried out through the same throw path as a real
// failure — the callers that care tell the two apart by this flag, so a stopped
// run doesn't fill its log with errors describing work nobody wanted done.
export class SyncStoppedError extends Error {
  constructor(message) {
    super(message);
    this.name = "SyncStoppedError";
    this.syncStopped = true;
  }
}

export function isSyncStoppedError(err) {
  return Boolean(err?.syncStopped);
}

// When the currently-running sync started, or null if none is running.
//
// This is what the log page watches after Sync now: the run happens in the
// background, so "is it still going" has to be a question about shared state
// rather than about an HTTP request that has long since returned.
//
// A lock past the stale timeout reports as NOT running, matching what
// acquireSyncLock would do with it — a process that died without releasing must
// not leave the page spinning forever.
export async function getSyncRunningSince(shop) {
  const { runningSince } = await getSyncRunState(shop);
  return runningSince;
}

// The same question plus "and has it been asked to stop", in one query — what
// the log page needs to draw the Stop sync button: offered while a run is going,
// and reporting "Stopping…" once pressed, because the run only notices at its
// next order boundary and the seconds in between must not look like the press
// did nothing.
//
// stopRequestedAt is reported only alongside a live run, for the same reason
// requestSyncStop refuses when nothing is running: a flag with no run behind it
// is stale state, not a pending stop.
export async function getSyncRunState(shop) {
  const settings = await prisma.netsuiteAppSettings.findUnique({
    where: { shop },
    select: {
      syncStartedAt: true,
      syncStopRequestedAt: true,
      syncTotalOrders: true,
      syncDoneOrders: true,
      syncPhase: true,
    },
  });
  const startedAt = settings?.syncStartedAt ?? null;
  const running = startedAt && startedAt.getTime() > Date.now() - lockStaleMs();
  return {
    runningSince: running ? startedAt : null,
    stopRequestedAt: running ? settings?.syncStopRequestedAt ?? null : null,
    // Reported whether or not a run is going: while one is, they are its
    // progress; afterwards they are what the last one got through.
    totalOrders: settings?.syncTotalOrders ?? null,
    doneOrders: settings?.syncDoneOrders ?? null,
    // "fetching" (reading NetSuite) or "syncing" (writing to Shopify) — which
    // stretch the two numbers above describe. See setSyncTotal.
    phase: settings?.syncPhase ?? null,
  };
}

// How many orders this run has to do — set once per phase, as soon as the count
// is known and before the first one is touched. Until it is set the page can
// only say "running"; after it, it can say how far along.
//
// A run has two phases with two different counts: `phase` says which one this
// call is reporting. "fetching" is set by fetchNetsuiteOrders once the listing
// is in (before a single order is expanded); "syncing" — the default, and the
// only phase this had before fetching got its own progress — is set once the
// fetched set is in hand and about to be written to Shopify. `done` resets to 0
// on the switch, which is what makes the page's counter restart rather than
// read "53 of 12" when a run moves from fetching 53 into syncing 12 of them.
//
// `done` takes an explicit value, not just a reset, for the run that finishes
// its whole set in one step rather than order by order — the export dry run
// writes every record at once, and leaving it at 0 would report "0 of 50" for a
// run that handled all fifty.
export async function setSyncTotal(shop, total, done = 0, phase = "syncing") {
  await prisma.netsuiteAppSettings.updateMany({
    where: { shop },
    data: { syncTotalOrders: total, syncDoneOrders: done, syncPhase: phase },
  });
}

// One more done in the CURRENT phase. `increment` rather than a count passed
// in, so two writers can never talk each other's number backwards, and so a
// caller does not have to hold the running total. Safe to call from both
// phases with no extra bookkeeping: setSyncTotal's phase switch already reset
// the counter this increments, so the same call means "one fetched" during
// fetching and "one synced" during syncing.
//
// Never allowed to fail the run: this is a progress bar. An order that synced
// and then failed to be counted is still synced, and taking the sync down over
// it would be absurd.
export async function bumpSyncDone(shop) {
  try {
    await prisma.netsuiteAppSettings.updateMany({
      where: { shop },
      data: { syncDoneOrders: { increment: 1 } },
    });
  } catch (err) {
    console.warn(`[order-sync] ${shop}: could not record sync progress: ${err?.message || err}`);
  }
}

export async function getConnectionStatus(shop) {
  const settings = await prisma.netsuiteAppSettings.findUnique({
    where: { shop },
    select: { refreshToken: true, connectedAt: true },
  });
  return {
    connected: Boolean(settings?.refreshToken),
    connectedAt: settings?.connectedAt ?? null,
  };
}
