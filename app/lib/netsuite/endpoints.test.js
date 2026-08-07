// This test sets process.env, and a .test.js file does not match the server-file
// pattern that the eslint config gives the node environment to.
/* eslint-env node */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  accountHost,
  oauthAuthorizeUrl,
  oauthTokenUrl,
  recordPath,
  recordUrl,
  suiteqlQuery,
  suiteqlUrl,
} from "./endpoints.server.js";

// Every NetSuite URL this app calls, pinned. These are the strings that decide
// whether a request reaches the right account on the right host — the kind of
// thing that is invisible in review and obvious only in production — so they are
// asserted whole rather than by pattern.

const ENV = ["NETSUITE_ACCOUNT_URL", "NETSUITE_ACCOUNT_ID"];
const saved = {};

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.NETSUITE_ACCOUNT_URL = "https://5895946-sb1.suitetalk.api.netsuite.com";
  process.env.NETSUITE_ACCOUNT_ID = "5895946_SB1";
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const REST = "https://5895946-sb1.suitetalk.api.netsuite.com/services/rest";

describe("hosts", () => {
  it("lowercases the account id and writes underscores as hyphens", () => {
    // 5895946_SB1 copied out of the NetSuite UI resolves to no host at all in
    // that form — this transformation is the whole reason the helper exists.
    assert.equal(accountHost(), "5895946-sb1");
  });

  it("tolerates surrounding whitespace in the env var", () => {
    process.env.NETSUITE_ACCOUNT_ID = "  5895946_SB1  ";
    assert.equal(accountHost(), "5895946-sb1");
  });

  it("does not double the slash when the account URL has a trailing one", () => {
    process.env.NETSUITE_ACCOUNT_URL = "https://5895946-sb1.suitetalk.api.netsuite.com/";
    assert.equal(recordUrl("/salesorder/1504"), `${REST}/record/v1/salesorder/1504`);
  });

  it("says which env var is missing rather than building a broken URL", () => {
    delete process.env.NETSUITE_ACCOUNT_URL;
    assert.throws(() => recordUrl("/salesorder/1"), /NETSUITE_ACCOUNT_URL/);
    delete process.env.NETSUITE_ACCOUNT_ID;
    assert.throws(() => oauthTokenUrl(), /NETSUITE_ACCOUNT_ID/);
  });
});

describe("record endpoints", () => {
  it("builds a plain sales-order GET", () => {
    assert.equal(recordUrl(recordPath.salesOrder("1504")), `${REST}/record/v1/salesorder/1504`);
  });

  it("expands sublists only when asked", () => {
    // Without expandSubResources SuiteTalk returns "item" as a bare link instead
    // of inline lines, which is how every order once mapped to zero line items.
    assert.equal(
      recordUrl(recordPath.salesOrder("1504", { expand: true })),
      `${REST}/record/v1/salesorder/1504?expandSubResources=true`,
    );
  });

  it("builds the sales-order list with limit, offset and filter", () => {
    assert.equal(
      recordPath.salesOrderList({ limit: 10, offset: 20, q: 'lastModifiedDate ON_OR_AFTER "8/4/2026"' }),
      "/salesorder?limit=10&offset=20&q=lastModifiedDate+ON_OR_AFTER+%228%2F4%2F2026%22",
    );
  });

  // The filter the sync really sends (see ORDER_DATE_FORMATS): the quotes and the
  // colons inside an ISO literal have to reach NetSuite intact, and a quote that
  // leaked through unencoded would end the query-string value early.
  it("encodes an ISO datetime filter without mangling its quotes or colons", () => {
    assert.equal(
      recordPath.salesOrderList({
        limit: 1000,
        offset: 0,
        q: 'lastModifiedDate ON_OR_AFTER "2026-08-05T23:53:00Z" AND lastModifiedDate ON_OR_BEFORE "2026-08-06T00:54:00Z"',
      }),
      "/salesorder?limit=1000&offset=0&q=lastModifiedDate+ON_OR_AFTER+%222026-08-05T23%3A53%3A00Z%22+AND+lastModifiedDate+ON_OR_BEFORE+%222026-08-06T00%3A54%3A00Z%22",
    );
  });

  // Singular and un-parameterised: it is the preference of whoever the token
  // belongs to, which is the user the q filter is parsed on behalf of.
  it("reads the user preference without an id", () => {
    assert.equal(
      recordUrl(recordPath.userPreference()),
      `${REST}/record/v1/preference/userPreference`,
    );
  });

  it("omits q entirely when there is no filter", () => {
    // Not "q=" — an empty filter is a different request from no filter.
    assert.equal(recordPath.salesOrderList({ limit: 10, offset: 0 }), "/salesorder?limit=10&offset=0");
  });

  it("escapes a tranId lookup so it cannot break out of the q string", () => {
    assert.equal(
      recordPath.salesOrderByTranId("SO20742"),
      "/salesorder?q=tranId%20IS%20%22SO20742%22&limit=5",
    );
    // The quotes that delimit the literal are encoded, so a value carrying one
    // cannot terminate it early.
    assert.match(recordPath.salesOrderByTranId('SO"1'), /^\/salesorder\?q=tranId%20IS%20%22SO%221%22&limit=5$/);
  });
});

describe("suiteql", () => {
  it("carries the page the caller asked for", () => {
    assert.equal(suiteqlUrl({ limit: 1000, offset: 2000 }), `${REST}/query/v1/suiteql?limit=1000&offset=2000`);
  });
});

describe("suiteql queries", () => {
  const batch = ["101", "202"];

  it("builds the invoice lookup with the batch inlined", () => {
    const q = suiteqlQuery.invoicesForOrders(batch);
    assert.match(q, /WHERE tl\.createdfrom IN \(101,202\) AND inv\.type = 'CustInvc'/);
    // The link goes through transactionline because no field on either record
    // names the other — if this join is ever "simplified" away, invoices stop
    // being found and every order silently falls back to PENDING.
    assert.match(q, /FROM transactionline tl/);
  });

  it("builds the customer email fallback", () => {
    assert.equal(
      suiteqlQuery.customerEmails(batch),
      "SELECT id, email FROM customer WHERE id IN (101,202) AND email IS NOT NULL",
    );
  });

  it("builds the tracking lookup through the fulfillment join", () => {
    const q = suiteqlQuery.trackingForOrders(batch);
    // Tracking numbers are NOT on the itemfulfillment REST record — they live
    // in trackingnumbermap/trackingnumber, which is why this is SuiteQL.
    assert.match(q, /LEFT JOIN trackingnumbermap m ON m\.transaction = f\.id/);
    assert.match(q, /LEFT JOIN trackingnumber n ON n\.id = m\.trackingnumber/);
    assert.match(q, /f\.type = 'ItemShip'/);
    assert.match(q, /WHERE tl\.createdfrom IN \(101,202\)/);
  });

  it("LEFT JOINs the tracking tables so shipped-but-untracked orders still answer", () => {
    // An inner join here reported the ship date, status, carrier and weight of
    // ONLY the fulfillments that happen to carry a tracking number — 1212 of
    // this account's 17920 shipped orders. The other ~93% came back as if
    // nothing had shipped at all. If either of these ever becomes a plain JOIN,
    // that silent loss comes straight back.
    const q = suiteqlQuery.trackingForOrders(batch);
    assert.doesNotMatch(q, /(?<!LEFT )JOIN trackingnumbermap/);
    assert.doesNotMatch(q, /(?<!LEFT )JOIN trackingnumber\b/);
  });

  it("pre-aggregates package weight instead of joining the package rows directly", () => {
    // Weight is per fulfillment, but this query returns one row per fulfillment
    // LINE x tracking number. Joining itemfulfillmentpackage in directly
    // multiplies against those rows — fulfillment 3538 has 9 packages and 9
    // tracking numbers, and a direct join reports 9x its real 153 lb.
    const q = suiteqlQuery.trackingForOrders(batch);
    assert.match(q, /LEFT JOIN \(SELECT itemfulfillment, SUM\(packageweight\) AS packageweight/);
    assert.match(q, /GROUP BY itemfulfillment\) w ON w\.itemfulfillment = f\.id/);
  });

  it("renders the ship date as YYYY-MM-DD rather than the account's own format", () => {
    // Raw, SuiteQL hands trandate back in the ACCOUNT's display format
    // ("8/5/2026") — ambiguous between US and rest-of-world spelling, and not
    // what anything downstream wants to store, sort or compare.
    assert.match(suiteqlQuery.trackingForOrders(batch), /TO_CHAR\(f\.trandate, 'YYYY-MM-DD'\) AS shipdate/);
  });

  it("reads the carrier that actually shipped, off the fulfillment", () => {
    assert.match(suiteqlQuery.trackingForOrders(batch), /BUILTIN\.DF\(f\.shipmethod\) AS shipmethod/);
  });

  it("reads the carrier field alongside the service, as the fallback for a blank service", () => {
    // shipcarrier is "UPS", "FedEx/USPS/More" or empty on this account. It is
    // what a shipment is shown as when its shipmethod is blank, which most of
    // this account's fulfillments are (see carrierName).
    assert.match(suiteqlQuery.trackingForOrders(batch), /f\.shipcarrier/);
  });

  it("reads the shipping methods whole, so the tracking URL can be found by value", () => {
    // SELECT * rather than naming a custom field: the field's id is whatever the
    // account typed, and requiring a particular name would hinge the feature on
    // a spelling. It also means no field name from the environment is ever
    // spliced into this SQL.
    assert.equal(
      suiteqlQuery.shipItemsForTrackingUrl(batch),
      "SELECT * FROM shipitem WHERE id IN (101,202)",
    );
  });

  it("reads each shipment's items in a query of their own", () => {
    const q = suiteqlQuery.shipmentItemsForOrders(batch);
    // Not folded into trackingForOrders: that returns one row per fulfillment x
    // tracking number, and multiplying the item lines through it repeats every
    // line down every number.
    assert.match(q, /fl\.transaction AS fulfillmentid/);
    assert.match(q, /BUILTIN\.DF\(fl\.item\) AS item, SUM\(ABS\(fl\.quantity\)\) AS quantity/);
    assert.match(q, /WHERE fl\.createdfrom IN \(101,202\)/);
    assert.match(q, /GROUP BY fl\.createdfrom, fl\.transaction, fl\.mainline, BUILTIN\.DF\(fl\.item\)/);
  });

  it("keeps the mainline row, which is all 93% of this account's fulfillments have", () => {
    // 3821 of 4108 fulfillments in 2026 are a single mainline row and nothing
    // else. Reading only the positive detail lines found items on the other 287
    // and left every shipment on the rest empty — which silently turns the
    // item-wise fulfillment write back into the flat one it replaced.
    const q = suiteqlQuery.shipmentItemsForOrders(batch);
    assert.match(q, /\(fl\.mainline = 'T' OR fl\.quantity > 0\)/);
    assert.match(q, /fl\.mainline/);
  });

  it("drops the mirror rows and the carrier's own charge line from the shipment items", () => {
    // NetSuite writes each shipped detail line twice, once positive and once
    // negative for the inventory movement; without quantity > 0 every item would
    // come back at net zero. ShipItem is the freight charge ("FedEx Ground®") —
    // a cost, not something that ships, and it would otherwise be fulfilled as
    // an item in Shopify.
    const q = suiteqlQuery.shipmentItemsForOrders(batch);
    assert.match(q, /fl\.quantity > 0/);
    assert.match(q, /fl\.itemtype <> 'ShipItem'/);
  });

  it("refuses a non-numeric id rather than inlining it into SQL", () => {
    // The ids go in as a bare IN list, so this is the guard that keeps a value
    // from anywhere else in the app out of the query text.
    for (const build of [suiteqlQuery.invoicesForOrders, suiteqlQuery.customerEmails, suiteqlQuery.trackingForOrders, suiteqlQuery.shipmentItemsForOrders]) {
      assert.throws(() => build(["101", "1) OR 1=1 --"]), /non-numeric/);
      assert.throws(() => build(["101", ""]), /non-numeric/);
      assert.throws(() => build(["101", "12a"]), /non-numeric/);
    }
  });

  it("refuses an empty batch rather than emitting IN ()", () => {
    // IN () is a syntax error in Oracle, so this would fail at NetSuite with a
    // message about the query rather than about the caller.
    assert.throws(() => suiteqlQuery.customerEmails([]), /empty id list/);
  });

  it("accepts numeric ids given as numbers, not just strings", () => {
    assert.match(suiteqlQuery.customerEmails([101, 202]), /IN \(101,202\)/);
  });

  it("finds orders by their FULFILLMENT's date, which is the half the SO filter cannot see", () => {
    // The sales-order list call filters on the SO's own lastModifiedDate, and
    // fulfilling an order does not move it. This query is the other half of
    // discovery: it starts from the shipment and works back to the order.
    const q = suiteqlQuery.orderIdsWithChangedFulfillments("2026-08-04 08:00:00", "2026-08-04 10:00:00");
    assert.match(q, /f\.type = 'ItemShip'/);
    // lastmodifieddate, not createddate — editing the tracking detail on an
    // existing fulfillment is exactly the case that was being missed.
    assert.match(q, /f\.lastmodifieddate >= TO_DATE\('2026-08-04 08:00:00', 'YYYY-MM-DD HH24:MI:SS'\)/);
    assert.match(q, /f\.lastmodifieddate <= TO_DATE\('2026-08-04 10:00:00', 'YYYY-MM-DD HH24:MI:SS'\)/);
    // The SO link is only reachable through transactionline — NetSuite rejects
    // `/itemfulfillment?q=createdFrom IS <id>` outright.
    assert.match(q, /JOIN transactionline fl ON fl\.transaction = f\.id/);
    assert.match(q, /SELECT DISTINCT fl\.createdfrom AS orderid/);
  });

  it("refuses a malformed timestamp rather than inlining it into SQL", () => {
    // idList's counterpart: the only query here that bounds on dates rather than
    // ids still splices literals into the text, so the shape is re-checked next
    // to the string being built.
    const ok = "2026-08-04 08:00:00";
    for (const bad of ["2026-08-04", "2026-8-4 08:00:00", "", null, undefined, "2026-08-04 08:00:00' OR '1'='1"]) {
      assert.throws(() => suiteqlQuery.orderIdsWithChangedFulfillments(bad, ok), /malformed timestamp/);
      assert.throws(() => suiteqlQuery.orderIdsWithChangedFulfillments(ok, bad), /malformed timestamp/);
    }
  });
});

describe("oauth", () => {
  it("puts the token exchange on the API host", () => {
    assert.equal(oauthTokenUrl(), `${REST}/auth/oauth2/v1/token`);
  });

  it("puts the authorize page on the app host, not the API host", () => {
    // The two are not interchangeable: the authorize page 404s on the suitetalk
    // host, and a REST call to the app host comes back as a login page whose
    // HTML then fails to parse as JSON.
    const url = new URL(oauthAuthorizeUrl(new URLSearchParams({ client_id: "KEY" })));
    assert.equal(url.host, "5895946-sb1.app.netsuite.com");
    assert.equal(url.pathname, "/app/login/oauth2/authorize.nl");
    assert.equal(url.searchParams.get("client_id"), "KEY");
  });

  it("derives the token host from the account id, not the account URL", () => {
    // They are separate env vars and can disagree; this pins which one governs.
    process.env.NETSUITE_ACCOUNT_URL = "https://example.invalid";
    assert.match(oauthTokenUrl(), /^https:\/\/5895946-sb1\.suitetalk\.api\.netsuite\.com\//);
  });
});
