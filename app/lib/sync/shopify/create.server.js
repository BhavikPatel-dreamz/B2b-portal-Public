import { createFulfillmentStatus, skuKey } from "../mapping.js";
import { resolveCompanyLocationId } from "./companies.server.js";
import { fetchFulfillmentOrders, planShipmentFulfillments, writeShipmentFulfillments } from "./fulfill.server.js";
import { orderName } from "./match.server.js";
import { buildCustomAttributes, buildTags, gqlError } from "./tracking.server.js";
import { resolveVariantsBySku } from "./variants.server.js";

// Whether this order's shipments are detailed enough to be written as real
// Shopify fulfillments — one per NetSuite item fulfillment, each with the lines
// it carried and its own tracking number, carrier and link (see
// planShipmentFulfillments). An order that has that leaves orderCreate WITHOUT a
// fulfillment status, because the two cannot both be used: a flat
// fulfillmentStatus closes every fulfillment order at create time, and a closed
// fulfillment order can no longer be fulfilled — there would be nothing left to
// hang the tracking on.
//
// SYNC_FULFILLMENT_CREATE=false turns this off in the same breath as it turns
// off the fulfillment writes on the tracking path, and orders go back to the
// flat status they were created with before.
export function fulfilsByShipment(entry) {
  if (process.env.SYNC_FULFILLMENT_CREATE === "false") return false;
  return (entry.shipments || []).some((s) => s.items?.length && s.trackingNumbers?.length);
}

export function buildOrderInput(entry, currencyCode, company, variantIds) {
  // Resolved once and handed to buildTransactions below: read separately, the two
  // could disagree — a mapped status of null became PAID here while
  // buildTransactions saw "not PAID" and attached no payment, leaving exactly the
  // paid-but-no-payment-record order the transaction exists to prevent.
  //
  // PENDING, not PAID, when the mapping produced nothing: mapFinancialStatus
  // deliberately treats an unrecognised NetSuite status as PENDING rather than
  // claim money was collected, and this fallback used to contradict it.
  const financialStatus = entry.financialStatus || "PENDING";
  const order = {
    currency: currencyCode,
    name: orderName(entry),
    poNumber: entry.reference || entry.externalId,
    financialStatus,
    customAttributes: buildCustomAttributes(entry),
    tags: buildTags(entry),
    // A line linked to a real variant sends only the variant and the price:
    // Shopify takes the title, image and SKU from the product itself, and
    // NetSuite's price still wins over the variant's. An unlinked line carries the
    // NetSuite item name as both title and sku, so the code is on the order line
    // as a SKU and not only inside its title.
    lineItems: (entry.lineItems || []).map((li) => {
      const line = {
        quantity: li.quantity ?? 1,
        // Every NetSuite sales-order line is a physical good that ships, so each
        // line is marked as requiring shipping. Without it orderCreate defaults a
        // line to requiresShipping:false — which is what left these orders showing
        // "Shipping not required" against items that were in fact fulfilled and
        // tracked. Set on the base line so it holds for both linked and custom
        // lines (a linked line would otherwise inherit the variant's own flag).
        // requiresShipping: li.item?.itemtype !== 'Service' && li.item?.itemtype !== 'Download'
        requiresShipping: true,
        priceSet: {
          shopMoney: { amount: String(li.price ?? "0"), currencyCode },
        },
      };
      const variantId = variantIds?.get(skuKey(li.title));
      if (variantId) line.variantId = variantId;
      else Object.assign(line, { title: li.title, sku: li.title });
      return line;
    }),
  };
  // NetSuite's fulfillment state has to be set at create time: orderCreate
  // defaults the order to unfulfilled, and the sync never touches an order's
  // fulfillment state afterwards. FULFILLED/PARTIAL are sent; "unfulfilled"
  // has no enum member, so createFulfillmentStatus returns null and the field
  // is left off (which is what gives an unfulfilled order).
  //
  // Unless the order is about to be fulfilled shipment by shipment (see
  // fulfilsByShipment) — those fulfillments ARE the fulfillment state, and they
  // reach the same place with the tracking attached to the right items.
  const fulfillmentStatus = fulfilsByShipment(entry) ? null : createFulfillmentStatus(entry.fulfillmentStatus);
  if (fulfillmentStatus) order.fulfillmentStatus = fulfillmentStatus;
  if (entry.note) order.note = entry.note;
  if (entry.shippingAddress) order.shippingAddress = entry.shippingAddress;
  if (entry.billingAddress) order.billingAddress = entry.billingAddress;
  if (entry.shippingCost > 0) {
    order.shippingLines = [{
      title: entry.shipMethod || "Shipping",
      priceSet: { shopMoney: { amount: String(entry.shippingCost), currencyCode } },
    }];
  }
  if (entry.taxTotal > 0) {
    const subtotal = (entry.lineItems || []).reduce(
      (sum, li) => sum + Number(li.price ?? 0) * Number(li.quantity ?? 1),
      0,
    );
    const rate = subtotal > 0 ? entry.taxTotal / subtotal : 0;
    order.taxLines = [{
      title: "Tax",
      rate: Number(rate.toFixed(6)),
      priceSet: { shopMoney: { amount: String(entry.taxTotal), currencyCode } },
    }];
  }
  const c = entry.customer;
  if (c?.email) {
    order.customer = {
      toUpsert: {
        email: c.email,
        ...(c.firstName ? { firstName: c.firstName } : {}),
        ...(c.lastName ? { lastName: c.lastName } : {}),
        // A B2B order is rejected outright ("no customer_id was provided") unless
        // the customer is identified by id — an email to upsert isn't enough,
        // because the customer has to be the company's contact. It's the same
        // customer either way: the id came from looking this email up.
        ...(company?.customerId ? { id: company.customerId } : {}),
      },
    };
  }
  // Attaches the order to the buyer's company location, which is what makes it a
  // B2B order in Shopify.
  if (company?.companyLocationId) order.companyLocationId = company.companyLocationId;
  // Last — the transaction amount is derived from the money set above.
  const transactions = buildTransactions(order, financialStatus, entry, currencyCode);
  if (transactions) order.transactions = transactions;
  return order;
}

// The payment record for the order. PAID means every invoice linked to the sales
// order is Paid In Full (see mapFinancialStatus) — the one state where the money
// is known to have arrived, so the one state that gets a transaction.
// PARTIALLY_PAID deliberately gets none: entry.invoices carries each invoice's
// status but not its amount, and inventing an amount would invent a payment.
//
// Without a transaction an order created as PAID has no payment behind it, which
// leaves it out of payment/payout reporting and blocks refunds. Set
// SYNC_ORDER_TRANSACTIONS=false to go back to the status-only behaviour.
export function buildTransactions(order, financialStatus, entry, currencyCode) {
  if (process.env.SYNC_ORDER_TRANSACTIONS === "false") return null;
  if (financialStatus !== "PAID") return null;
  const amount = orderInputTotal(order);
  if (!(amount > 0)) return null;
  const tx = {
    kind: "SALE",
    status: "SUCCESS",
    // "manual" is Shopify's own gateway for money taken outside a payment
    // provider, which is what a NetSuite invoice is.
    gateway: process.env.NETSUITE_PAYMENT_GATEWAY || "manual",
    amountSet: { shopMoney: { amount: amount.toFixed(2), currencyCode } },
  };
  // The order date, so a backfilled order isn't recorded as paid today.
  const processedAt = isoDateTime(entry.tranDate);
  if (processedAt) tx.processedAt = processedAt;
  return [tx];
}

// The total Shopify will compute for this order input (line items + shipping +
// tax). Summed in cents: a float sum can land a cent off, which would leave a
// "paid" order showing an outstanding balance.
function orderInputTotal(order) {
  const cents = (v) => Math.round(Number(v || 0) * 100);
  let total = 0;
  for (const li of order.lineItems || []) {
    total += cents(li.priceSet?.shopMoney?.amount) * Number(li.quantity ?? 1);
  }
  for (const sl of order.shippingLines || []) total += cents(sl.priceSet?.shopMoney?.amount);
  for (const tl of order.taxLines || []) total += cents(tl.priceSet?.shopMoney?.amount);
  return total / 100;
}

// NetSuite sends date-only strings ("2025-12-31"); Shopify's DateTime wants a
// full ISO 8601 timestamp.
function isoDateTime(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Fulfils a just-created order shipment by shipment: one Shopify fulfillment per
// NetSuite item fulfillment, carrying the lines that shipment contained and its
// own tracking number, carrier and link. This is the whole point of leaving the
// flat fulfillmentStatus off above — the order reaches the same fulfilled state,
// but with the tracking against the items it actually covers.
//
// Best-effort by design. The order itself is already created and correct; a
// failure here leaves it unfulfilled with its tracking still recorded in the
// netsuite_tracking attribute, and the next run re-matches it and takes the
// tracking path, which fulfils it the same way. Failing the create over this
// would instead leave the run reporting an order it did in fact create.
async function fulfilCreatedOrder(admin, entry, orderId) {
  if (!fulfilsByShipment(entry)) return {};
  try {
    const fulfillmentOrders = await fetchFulfillmentOrders(admin, orderId);
    const plan = planShipmentFulfillments(
      (entry.shipments || []).filter((s) => s.items?.length),
      fulfillmentOrders,
      { fulfillRemainder: entry.fulfillmentStatus === "FULFILLED" },
    );
    if (!plan.plans.length) {
      return { fulfillmentWarning: "NetSuite's shipment items matched no line on the created order; left unfulfilled for the tracking path to pick up" };
    }
    const { created, failed } = await writeShipmentFulfillments(admin, plan);
    return {
      fulfillments: created,
      tracking: created.flatMap((c) => c.numbers).join(", ") || null,
      shipmentsPlanned: `${plan.plans.length} of ${(entry.shipments || []).length} NetSuite shipment(s) fulfilled item-wise`,
      ...(failed.length ? { fulfillmentWarning: failed.join("; ") } : {}),
    };
  } catch (err) {
    return { fulfillmentWarning: `order created, but fulfilling it by shipment failed: ${err?.message || String(err)}` };
  }
}

export async function createOrder(admin, entry, currencyCode, caches) {
  // A create needs an email, and it is worth failing over rather than working
  // around. Shopify will happily accept an order with no customer at all, but
  // that order belongs to nobody: the buyer can't see it in their account, and
  // nothing afterwards can attach it to one. On a company order it is fatal
  // anyway (see lookupCompanyLocation) — this check only makes the same
  // requirement explicit for an order with no company name, which would
  // otherwise be created silently and look like a success in the log.
  //
  // Two sources have already been tried by this point: the sales order's own
  // Email field and, when that is blank, the customer record's
  // (linkedCustomerEmail — see fetchCustomerEmails in netsuite.server.js). So
  // reaching here means NetSuite holds no address for this buyer anywhere, and
  // the fix is in NetSuite, not here. The message says exactly that, because
  // "no customer email" alone reads like a bug in the sync.
  //
  // Only creates are affected. An order already in Shopify takes the
  // tracking-only update path and never comes through here.
  if (!entry.customer?.email) {
    return {
      ok: false,
      action: "create",
      error: "no customer email: the NetSuite order's Email field is blank and so is its customer record — an order cannot be created without one",
    };
  }

  // An order naming a company is a B2B order and MUST carry its company
  // location, so an unresolvable company blocks the create instead of quietly
  // producing an order the buyer's company can't see. The company, its contact
  // and its location are all created when missing, so "unresolvable" means the
  // NetSuite data or the shop is ambiguous, not merely that this is the
  // company's first order. Orders with no company name skip this entirely and
  // are created exactly as before.
  let link = null;
  if (entry.companyName) {
    link = await resolveCompanyLocationId(admin, entry, caches.company);
    if (!link.companyLocationId) {
      return {
        ok: false,
        action: "create",
        error: `company "${entry.companyName}": ${link.error}`,
      };
    }
  }

  // Which of this order's items exist in Shopify. Looked up before the create so
  // the lines can be linked to their variants; a miss is not an error (see
  // resolveVariantsBySku).
  const variantIds = await resolveVariantsBySku(
    admin,
    (entry.lineItems || []).map((li) => li.title),
    caches.variant,
  );

  const order = buildOrderInput(entry, currencyCode, link, variantIds);
  if (entry.currency && entry.currency !== currencyCode) {
    console.warn(
      `[order-sync] ${entry.externalId}: NetSuite currency ${entry.currency} != shop ${currencyCode}; amounts created as ${currencyCode}.`,
    );
  }

  // Shopify only emails the customer on order create (update/delete don't
  // trigger notifications) — always suppressed, unconditionally, so synced
  // NetSuite orders never email a real customer.
  //
  // BYPASS is also the default, but it is stated because it matters now that
  // lines carry real variants: these orders were already fulfilled and billed in
  // NetSuite, and claiming their stock again in Shopify would double-count every
  // unit. It also keeps a re-synced order from drawing the same stock twice.
  const options = {
    sendReceipt: false,
    sendFulfillmentReceipt: false,
    inventoryBehaviour: "BYPASS",
  };

  const resp = await admin.graphql(
    `#graphql
    mutation OrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
      orderCreate(order: $order, options: $options) {
        order {
          id
          name
          poNumber
          displayFinancialStatus
          displayFulfillmentStatus
          shippingAddress { address1 city provinceCode zip countryCodeV2 }
          billingAddress { address1 city provinceCode zip countryCodeV2 }
          totalShippingPriceSet { shopMoney { amount currencyCode } }
          totalTaxSet { shopMoney { amount currencyCode } }
          totalPriceSet { shopMoney { amount currencyCode } }
          customer { id firstName lastName defaultEmailAddress { emailAddress } }
          purchasingEntity {
            ... on PurchasingCompany {
              company { id name }
              location { id name }
            }
          }
          transactions { id kind status amountSet { shopMoney { amount currencyCode } } }
        }
        userErrors { field message }
      }
    }`,
    { variables: { order, options } },
  );
  const body = await resp.json();
  const payload = body?.data?.orderCreate;
  const errors = payload?.userErrors || [];
  if (errors.length || !payload?.order) {
    return { ok: false, action: "create", error: gqlError(body, errors) };
  }
  const o = payload.order;
  const purchasing = o.purchasingEntity;
  const shipments = await fulfilCreatedOrder(admin, entry, o.id);
  // How many lines found their product and how many stayed as text, so an item
  // that isn't in Shopify is visible in the log instead of only in the order.
  const linked = order.lineItems.filter((li) => li.variantId).length;
  return {
    ok: true,
    action: "create",
    lines: `${order.lineItems.length} line(s): ${linked} linked to a variant, ${order.lineItems.length - linked} custom`,
    id: o.id,
    name: o.name,
    poNumber: o.poNumber,
    financialStatus: o.displayFinancialStatus,
    // What orderCreate itself returned. When the order was fulfilled shipment by
    // shipment afterwards, the fulfillments below are the state that matters and
    // this reads UNFULFILLED, which is what the order was for the second it took
    // to write them.
    fulfillmentStatus: o.displayFulfillmentStatus,
    ...shipments,
    customer: o.customer?.defaultEmailAddress?.emailAddress || null,
    shipping: o.totalShippingPriceSet?.shopMoney?.amount || null,
    tax: o.totalTaxSet?.shopMoney?.amount || null,
    total: o.totalPriceSet?.shopMoney?.amount || null,
    shippedTo: o.shippingAddress?.city || null,
    ...(entry.companyName
      ? {
        netsuiteCompany: entry.companyName,
        company: purchasing?.company?.name || null,
        companyLocation: purchasing?.location?.name || null,
        companyLocationId: purchasing?.location?.id || null,
        // What the B2B chain had to create for this order, if anything.
        ...(link?.created?.length ? { companyCreated: link.created.join(", ") } : {}),
      }
      : {}),
    transactions: (o.transactions || []).map(
      (t) => `${t.kind}/${t.status} ${t.amountSet?.shopMoney?.amount || "?"}`,
    ),
  };
}

