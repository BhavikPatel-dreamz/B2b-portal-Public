import demoFeed from "../../data/demo-orders.json";
import { fetchSalesOrders, targetedOrderIds } from "../netsuite/client.server.js";

export async function fetchExternalOrders(shop, opts = {}) {
  if (process.env.NETSUITE_USE_DEMO !== "false") {
    // opts.window is ignored here on purpose: the demo records carry no
    // lastModifiedDate, so every window would match none of them and a windowed
    // run in demo mode would look broken rather than like a demo.
    // A targeted call has to narrow the demo feed the same way it narrows a live
    // fetch, or re-syncing one order would run the whole feed. Both identifiers
    // resolveOrderId() accepts are matched: the internal id ("1504") and the
    // document number ("SO1504", or bare "1504").
    //
    // Both sources of a target are honoured, in the same precedence
    // fetchNetsuiteOrders uses: an explicit list (opts.ids — a manual re-sync)
    // wins, and NETSUITE_ORDER_IDS applies to every other run. That env var used
    // to be read only on the live path, so in demo mode it did nothing at all:
    // the banner on the log page said every run syncs only those orders while
    // the run happily processed the whole demo feed.
    const requested = (opts.ids || []).map((v) => String(v).trim()).filter(Boolean);
    const ids = requested.length ? requested : targetedOrderIds();
    if (!ids.length) return demoFeed;
    const source = requested.length ? "requested orders" : "NETSUITE_ORDER_IDS";
    console.log(`[order-sync] demo feed — ${source}, syncing only: ${ids.join(", ")}`);
    const key = (v) => String(v).trim().toUpperCase().replace(/^SO/, "");
    const wanted = new Set(ids.map(key));
    const items = (demoFeed.items || []).filter(
      (rec) => wanted.has(key(rec.id)) || (rec.tranId && wanted.has(key(rec.tranId))),
    );
    const found = new Set(items.flatMap((rec) => [key(rec.id), key(rec.tranId || "")]));
    return {
      items,
      errors: ids
        .filter((raw) => !found.has(key(raw)))
        .map((raw) => ({ id: raw, error: `${source}: "${raw}" is not in the demo feed` })),
    };
  }
  // The one NetSuite sales-order entry point, handed this run's scope: a date
  // range if it has one (window.from/window.to — a preset from the dropdown or a
  // hand-typed custom range, both already resolved to two instants), the
  // watermark otherwise, or an explicit id list for a re-sync.
  const { window, ...rest } = opts;
  return fetchSalesOrders(shop, {
    ...rest,
    ...(window ? { from: window.from, to: window.to } : {}),
  });
}

// NetSuite statuses that mean the order is dead — these map to a delete in
// Shopify. Everything else is a create-or-update (upsert).
//
// These are the record's status *IDs* (single letters, see the status table
// below), NOT the display names. The set previously held names ("cancelled",
// "closed", "rejected") while mapNetsuiteOrder compares them against
// rec.status.id, so has() could never return true and the delete path was
// unreachable — a cancelled NetSuite order was upserted into Shopify instead.
// "rejected" was never a sales-order status at all; the account only ever
// returns A-H.
//
// Only C (Cancelled) qualifies. It is terminal, cannot be undone, and the
// cancelled orders on this account have no invoice behind them.
//
// H (Closed) is deliberately NOT here even though the status reference says a
// closed order "won't be fulfilled or billed": on this account closed sales
// orders do have invoices attached, including Paid In Full ones, so deleting
// them would erase a real, settled sale from Shopify. Closing a sales order
// means the remaining lines will not ship — not that the order was void.
//
// deleteOrder() is the guard on how far this reaches: it exempts
// Celigo-imported orders outright and otherwise only resolves orders carrying
// this sync's own ext:<netsuiteId> tag, so only an order this sync created can
// ever be deleted.
