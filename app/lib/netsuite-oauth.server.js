import crypto from "node:crypto";
import prisma from "../db.server.js";

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

function accountId() {
  return required("NETSUITE_ACCOUNT_ID");
}

function authorizeBase() {
  return `https://${accountId()}.app.netsuite.com`;
}

function tokenUrl() {
  return `https://${accountId()}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token`;
}

export function redirectUri() {
  return `${required("SHOPIFY_APP_URL")}/api/netsuite/callback`;
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
  const params = new URLSearchParams({
    response_type: "code",
    client_id: required("NETSUITE_CONSUMER_KEY"),
    redirect_uri: redirectUri(),
    scope: "restlets rest_webservices",
    state: signState(shop),
  });
  return `${authorizeBase()}/app/login/oauth2/authorize.nl?${params.toString()}`;
}

async function tokenRequest(body) {
  const consumerKey = required("NETSUITE_CONSUMER_KEY");
  const consumerSecret = required("NETSUITE_CONSUMER_SECRET");
  const basicAuth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");

  const res = await fetch(tokenUrl(), {
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
export async function setLastSyncedAt(shop, date, from = null) {
  await prisma.netsuiteAppSettings.upsert({
    where: { shop },
    update: { lastSyncedAt: date, lastSyncFrom: from },
    create: { shop, lastSyncedAt: date, lastSyncFrom: from },
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
    data: { syncStartedAt: startedAt },
  });
  if (count === 1) return { acquired: true, token: startedAt };

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
  await prisma.netsuiteAppSettings.updateMany({
    where: { shop, syncStartedAt: token },
    data: { syncStartedAt: null },
  });
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
  const settings = await prisma.netsuiteAppSettings.findUnique({
    where: { shop },
    select: { syncStartedAt: true },
  });
  const startedAt = settings?.syncStartedAt ?? null;
  if (!startedAt) return null;
  return startedAt.getTime() > Date.now() - lockStaleMs() ? startedAt : null;
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
