// This test writes to a temp dir and reads process.env; a .test.js file does not
// match the server-file pattern the eslint config gives the node environment to.
/* eslint-env node */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// The dump's file handling, exercised directly. dumpTargetedOrders itself needs a
// NetSuite account and a database, so what is tested here is the part that has
// neither and that a bad day actually turns on: how the JSON file accumulates,
// and what happens when it is already there or already broken.
//
// These mirror readDump/dumpPath in order-dump.server.js. They are duplicated
// rather than exported-for-test because exporting internals only to assert them
// makes the module's surface a lie about what callers may use.

function dumpPath(dir, shop, at) {
  const safeShop = String(shop).toLowerCase().replace(/[^a-z0-9.-]/g, "_");
  return path.join(dir, `netsuite-orders-${safeShop}-${at.toISOString().slice(0, 10)}.json`);
}

function readDump(file, shop) {
  const empty = { shop, entries: [] };
  if (!fs.existsSync(file)) return empty;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed?.entries) ? parsed : empty;
  } catch {
    fs.renameSync(file, `${file}.corrupt-1`);
    return empty;
  }
}

function appendEntry(dir, shop, at, entry) {
  const file = dumpPath(dir, shop, at);
  fs.mkdirSync(dir, { recursive: true });
  const doc = readDump(file, shop);
  doc.shop = shop;
  doc.updatedAt = at.toISOString();
  doc.entries.push(entry);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nsdump-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const SHOP = "acme.myshopify.com";
const AT = new Date("2026-08-05T09:14:22.431Z");

describe("the dump file", () => {
  it("is named per shop and per day, beside the text run log", () => {
    assert.equal(path.basename(dumpPath(dir, SHOP, AT)), "netsuite-orders-acme.myshopify.com-2026-08-05.json");
  });

  it("cannot be steered out of the log directory by the shop parameter", () => {
    // The route checks the shop is installed, which is the real guard. This is
    // the one that holds even if that check is ever loosened.
    const file = dumpPath(dir, "../../etc/passwd", AT);
    assert.equal(path.dirname(file), dir, "the file must stay in the log directory");
    assert.doesNotMatch(path.basename(file), /[/\\]/);
  });

  it("accumulates one entry per call instead of overwriting", () => {
    const file = appendEntry(dir, SHOP, AT, { at: "1", requestedIds: ["SO1"] });
    appendEntry(dir, SHOP, AT, { at: "2", requestedIds: ["SO2"] });
    appendEntry(dir, SHOP, AT, { at: "3", requestedIds: ["SO3"] });
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(doc.entries.length, 3);
    assert.deepEqual(doc.entries.map((e) => e.at), ["1", "2", "3"]);
    assert.equal(doc.shop, SHOP);
  });

  it("stays a single parseable JSON document as it grows", () => {
    // The reason the whole file is rewritten rather than appended to: a log you
    // cannot JSON.parse is not much of a JSON log.
    const file = appendEntry(dir, SHOP, AT, { at: "1" });
    appendEntry(dir, SHOP, AT, { at: "2" });
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, "utf8")));
  });

  it("starts a new day's file without touching yesterday's", () => {
    const day1 = appendEntry(dir, SHOP, AT, { at: "1" });
    const day2 = appendEntry(dir, SHOP, new Date("2026-08-06T00:00:01.000Z"), { at: "2" });
    assert.notEqual(day1, day2);
    assert.equal(JSON.parse(fs.readFileSync(day1, "utf8")).entries.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(day2, "utf8")).entries.length, 1);
  });

  it("moves a corrupt file aside rather than destroying it", () => {
    // Someone may be mid-read of the very file that failed to parse; replacing
    // it silently would delete the thing they were trying to look at.
    const file = dumpPath(dir, SHOP, AT);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, "{ this is not json");
    appendEntry(dir, SHOP, AT, { at: "1" });

    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).entries.length, 1, "a fresh file is started");
    const aside = fs.readdirSync(dir).find((f) => f.includes(".corrupt-"));
    assert.ok(aside, "the unparseable file is kept");
    assert.equal(fs.readFileSync(path.join(dir, aside), "utf8"), "{ this is not json");
  });

  it("treats a valid JSON file of the wrong shape as empty, not as entries", () => {
    const file = dumpPath(dir, SHOP, AT);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ shop: SHOP, entries: "not-an-array" }));
    appendEntry(dir, SHOP, AT, { at: "1" });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).entries.map((e) => e.at), ["1"]);
  });

  it("leaves no .tmp behind once the write lands", () => {
    appendEntry(dir, SHOP, AT, { at: "1" });
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")).length, 0);
  });
});
