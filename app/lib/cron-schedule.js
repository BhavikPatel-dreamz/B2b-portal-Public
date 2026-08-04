// How often the scheduled sync runs, and everything derived from that: the
// crontab expression to install, and when the next run is due.
//
// CRON_INTERVAL_MINUTES is the single knob. Nothing here *causes* the cron to
// fire — that is the crontab entry on the host — so the point of keeping the
// interval in one place is that the schedule the app SHOWS and the crontab line
// it tells you to install are computed from the same number. Change the env var,
// re-read the schedule card, install the line it now prints.
//
// Deliberately not a .server module: the log page renders this in the browser
// while the cron endpoint uses it on the server. The env var itself is read
// server-side and the resolved number is handed to the page.
export const DEFAULT_CRON_INTERVAL_MINUTES = 180;

// A crontab step can only be written in ONE field, so only two shapes of
// interval are expressible as a single entry:
//
//   under an hour   `*/N * * * *`   N = 1..59 minutes
//   whole hours     `0 */H * * *`   H = 1..24 hours, i.e. N a multiple of 60
//
// Everything else is rejected and falls back to the default. "Every 90 minutes"
// is the one people reach for, and a crontab cannot say it — it would need two
// entries firing at different times each hour, which is not a schedule this app
// could describe honestly. Showing an interval the crontab cannot run would be a
// lie on the page, so it is not offered.
export function cronIntervalMinutes(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_CRON_INTERVAL_MINUTES;
  if (n < 60) return n;
  if (n % 60 === 0 && n / 60 <= 24) return n;
  return DEFAULT_CRON_INTERVAL_MINUTES;
}

// The crontab time spec for that interval. 60 and 1440 get their plain spellings
// rather than `0 */1 * * *` and `0 */24 * * *`, which mean the same thing written
// in a way that reads as a mistake.
export function cronExpression(minutes) {
  if (minutes < 60) return `*/${minutes} * * * *`;
  if (minutes === 60) return "0 * * * *";
  if (minutes === 1440) return "0 0 * * *";
  return `0 */${minutes / 60} * * *`;
}

// "every 15 minutes", "every hour", "every 3 hours" — how the interval is named
// to a person, on the schedule card and in a log line.
export function intervalLabel(minutes) {
  if (minutes === 1) return "every minute";
  if (minutes < 60) return `every ${minutes} minutes`;
  if (minutes === 60) return "every hour";
  if (minutes === 1440) return "every day";
  return `every ${minutes / 60} hours`;
}

// When the cron next fires, following the real semantics of a `*/N` step rather
// than "last run + N": the step restarts at the top of its own field. With
// `*/7` in the minute field the fires are :00 :07 … :56 and the last gap of the
// hour is 4 minutes, not 7 — and the same is true of an hour step across
// midnight. A missed run doesn't shift the next one either; the crontab doesn't
// know it was missed.
//
// Computed in UTC, to match how the rest of this page reads timestamps. That
// holds as long as the cron host's clock is UTC, which is the normal server
// setup; on a host set to another zone the real fire times are offset by it.
export function nextCronRunAt(minutes, now = new Date()) {
  const next = new Date(now);
  next.setUTCSeconds(0, 0);

  if (minutes < 60) {
    // The soonest whole minute strictly after `now`, then forward to one the
    // step lands on.
    next.setUTCMinutes(next.getUTCMinutes() + 1);
    while (next.getUTCMinutes() % minutes !== 0) {
      next.setUTCMinutes(next.getUTCMinutes() + 1);
    }
    return next;
  }

  const hours = minutes / 60;
  next.setUTCMinutes(0);
  next.setUTCHours(next.getUTCHours() + 1);
  while (next.getUTCHours() % hours !== 0) {
    next.setUTCHours(next.getUTCHours() + 1);
  }
  return next;
}

// The URL the crontab entry calls. The token is the shared secret from
// CRON_SECRET; it is left as a placeholder here rather than baked in, so the
// schedule card can show the line to copy without putting the secret itself on a
// page that gets screenshared.
export function cronUrl(appUrl, token = "<CRON_SECRET>") {
  // SHOPIFY_APP_URL is blank under `shopify app dev` (the CLI supplies the tunnel
  // URL at runtime instead), and a line starting at "/api/..." would read as a
  // path the crontab could use. It can't — say so with the placeholder.
  const base = String(appUrl || "").replace(/\/+$/, "") || "https://YOUR_APP_URL";
  return `${base}/api/cron/orders-sync?token=${token}`;
}

export function crontabLine(minutes, appUrl, token) {
  return `${cronExpression(minutes)} curl -fsS "${cronUrl(appUrl, token)}" > /dev/null`;
}
