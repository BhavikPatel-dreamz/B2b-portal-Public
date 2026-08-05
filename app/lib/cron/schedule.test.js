import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cronExpression,
  cronIntervalMinutes,
  cronUrl,
  crontabLine,
  intervalLabel,
  nextCronRunAt,
} from "./schedule.js";

describe("cronIntervalMinutes", () => {
  it("takes any whole number of minutes under an hour", () => {
    for (const n of [1, 5, 15, 30, 45, 59]) {
      assert.equal(cronIntervalMinutes(String(n)), n);
    }
  });

  it("takes whole hours, expressed in minutes", () => {
    assert.equal(cronIntervalMinutes("60"), 60);
    assert.equal(cronIntervalMinutes(180), 180);
    assert.equal(cronIntervalMinutes("1440"), 1440);
  });

  // A crontab step lives in ONE field, so "every 90 minutes" cannot be written
  // as a single entry. Accepting it would put an interval on the page that the
  // crontab could never run — the page would be lying about the schedule.
  it("rejects an interval no single crontab entry can express", () => {
    for (const bad of [61, 90, 100, 150, 1441, 2880]) {
      assert.equal(cronIntervalMinutes(bad), 180, `expected fallback for ${bad}`);
    }
  });

  it("falls back to 180 for anything that is not a positive whole number", () => {
    for (const bad of [undefined, null, "", "   ", "abc", "0", "-5", "2.5", "1e3", {}, []]) {
      assert.equal(cronIntervalMinutes(bad), 180, `expected fallback for ${JSON.stringify(bad)}`);
    }
  });
});

describe("cronExpression", () => {
  it("steps the minute field under an hour", () => {
    assert.equal(cronExpression(15), "*/15 * * * *");
    assert.equal(cronExpression(1), "*/1 * * * *");
    assert.equal(cronExpression(59), "*/59 * * * *");
  });

  it("steps the hour field for whole hours", () => {
    assert.equal(cronExpression(180), "0 */3 * * *");
    assert.equal(cronExpression(360), "0 */6 * * *");
  });

  // `*/1` in the hour field and `*/24` are both legal and both read as mistakes.
  it("spells hourly and daily plainly", () => {
    assert.equal(cronExpression(60), "0 * * * *");
    assert.equal(cronExpression(1440), "0 0 * * *");
  });

  it("always emits five fields", () => {
    for (const n of [1, 15, 59, 60, 180, 1440]) {
      assert.equal(cronExpression(n).split(" ").length, 5, `${n} produced "${cronExpression(n)}"`);
    }
  });
});

describe("intervalLabel", () => {
  it("names the interval the way a person would", () => {
    assert.equal(intervalLabel(1), "every minute");
    assert.equal(intervalLabel(15), "every 15 minutes");
    assert.equal(intervalLabel(60), "every hour");
    assert.equal(intervalLabel(180), "every 3 hours");
    assert.equal(intervalLabel(1440), "every day");
  });
});

describe("nextCronRunAt — under an hour", () => {
  const at = (iso) => new Date(iso);

  it("returns the next minute the step lands on", () => {
    assert.equal(nextCronRunAt(15, at("2026-08-04T05:43:21Z")).toISOString(), "2026-08-04T05:45:00.000Z");
    assert.equal(nextCronRunAt(5, at("2026-08-04T05:43:21Z")).toISOString(), "2026-08-04T05:45:00.000Z");
    assert.equal(nextCronRunAt(30, at("2026-08-04T05:43:21Z")).toISOString(), "2026-08-04T06:00:00.000Z");
  });

  it("moves past a boundary it is sitting exactly on", () => {
    // "Next" has to mean the next one — a page loaded at exactly :45 must not
    // claim the :45 run is still to come.
    assert.equal(nextCronRunAt(15, at("2026-08-04T05:45:00Z")).toISOString(), "2026-08-04T06:00:00.000Z");
  });

  // The interesting case: a minute step restarts at the top of every hour, so an
  // interval that doesn't divide 60 has a SHORT last gap. "last run + N" would
  // put this at 06:03 and be wrong every single hour.
  it("restarts the step on the hour for an interval that does not divide 60", () => {
    assert.equal(nextCronRunAt(7, at("2026-08-04T05:57:00Z")).toISOString(), "2026-08-04T06:00:00.000Z");
    assert.equal(nextCronRunAt(7, at("2026-08-04T05:59:59Z")).toISOString(), "2026-08-04T06:00:00.000Z");
    assert.equal(nextCronRunAt(7, at("2026-08-04T06:00:30Z")).toISOString(), "2026-08-04T06:07:00.000Z");
  });

  it("rolls over the hour, the day and the year", () => {
    assert.equal(nextCronRunAt(15, at("2026-08-04T23:50:00Z")).toISOString(), "2026-08-05T00:00:00.000Z");
    assert.equal(nextCronRunAt(30, at("2026-12-31T23:45:00Z")).toISOString(), "2027-01-01T00:00:00.000Z");
  });

  it("always lands on a whole minute the step allows", () => {
    for (const minutes of [1, 5, 15, 20, 30, 59]) {
      const now = at("2026-08-04T05:43:21.987Z");
      const next = nextCronRunAt(minutes, now);
      assert.equal(next.getUTCSeconds(), 0);
      assert.equal(next.getUTCMilliseconds(), 0);
      assert.equal(next.getUTCMinutes() % minutes, 0);
      assert.ok(next > now);
    }
  });
});

describe("nextCronRunAt — whole hours", () => {
  const at = (iso) => new Date(iso);

  it("returns the next hour boundary, on the minute", () => {
    assert.equal(nextCronRunAt(180, at("2026-08-04T05:43:00Z")).toISOString(), "2026-08-04T06:00:00.000Z");
    assert.equal(nextCronRunAt(720, at("2026-08-04T05:43:00Z")).toISOString(), "2026-08-04T12:00:00.000Z");
    assert.equal(nextCronRunAt(60, at("2026-08-04T05:43:00Z")).toISOString(), "2026-08-04T06:00:00.000Z");
  });

  // Same restart rule one field up: an hour step restarts at midnight.
  it("restarts the hour step at midnight", () => {
    assert.equal(nextCronRunAt(300, at("2026-08-04T21:10:00Z")).toISOString(), "2026-08-05T00:00:00.000Z");
    assert.equal(nextCronRunAt(300, at("2026-08-04T00:30:00Z")).toISOString(), "2026-08-04T05:00:00.000Z");
  });

  it("handles a daily schedule", () => {
    assert.equal(nextCronRunAt(1440, at("2026-12-31T10:00:00Z")).toISOString(), "2027-01-01T00:00:00.000Z");
  });
});

describe("cronUrl", () => {
  it("does not put the secret in the line by default", () => {
    const line = crontabLine(15, "https://example.com");
    assert.match(line, /token=<CRON_SECRET>/);
    assert.ok(!line.includes("token=e48"), "a real-looking token must not appear");
    assert.match(line, /^\*\/15 \* \* \* \* curl/);
  });

  it("strips trailing slashes so the path is not doubled", () => {
    assert.equal(
      cronUrl("https://example.com///", "abc"),
      "https://example.com/api/cron/orders-sync?token=abc",
    );
  });

  // SHOPIFY_APP_URL is blank under `shopify app dev`. A line starting at "/api/"
  // would look like something a crontab could call, and it isn't.
  it("shows a placeholder host when the app URL is unset", () => {
    for (const blank of [undefined, null, ""]) {
      assert.match(cronUrl(blank), /^https:\/\/YOUR_APP_URL\/api\/cron\/orders-sync/);
    }
  });
});
