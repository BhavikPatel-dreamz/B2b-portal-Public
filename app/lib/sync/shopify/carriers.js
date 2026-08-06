// What NetSuite says shipped it
// ---------------------------------------------------------------------------
// Shopify renders a fulfillment's tracking as "<company> tracking: <number>".
// Both halves come from NetSuite and nowhere else: the company is the shipping
// service off the item fulfillment ("FedEx Ground®", "UPS® Ground Customer
// Account"), verbatim, and the number is the number. Nothing is normalised down
// to a carrier brand and nothing is inferred from the shape of a number — an
// order says what the shipping record says, or says nothing.
//
// The link is a different matter, because NetSuite has none to give. Checked
// across the account: the trackingnumber record holds an id and the number and
// no other column, the transaction row carries only shipcarrier / shipmethod / a
// trackingnumberlist id, the REST itemfulfillment record has no tracking or URL
// field, and neither does the shipping item ("FedEx Ground®" has a carrier and a
// service code and nothing linkable). NetSuite's own UI does show tracking
// numbers as links when Shipping Label Integration is on — but it builds those
// as it renders them, so there is nothing an API can read back.
//
// So the URL is resolved in two steps, best source first:
//
//   1. a URL template on the Shipping Item record in NetSuite, if someone has
//      filled one in (see attachTrackingUrls) — the account's own answer, and it
//      wins whenever it exists;
//   2. otherwise the carrier's public tracking URL, recognised from the shipping
//      service NetSuite recorded ("FedEx Ground®" -> FedEx's).
//
// Step 2 is a fallback and only a fallback. It does not touch the company shown
// on the order — that stays NetSuite's text, verbatim — and it never invents a
// carrier: it only decides which known tracking site a number is looked up on,
// and a service it cannot place gets no link rather than a guessed one.

// The carrier for a shipment: NetSuite's shipping service, falling back to its
// coarser carrier field ("UPS", "FedEx/USPS/More") when the service is blank,
// and null when the shipping record names neither — which is the case for most
// of this account's fulfillments.
export function carrierName(shipMethod, carrier) {
  return String(shipMethod || carrier || "").trim() || null;
}

// The carriers whose tracking page this file knows, for step 2. Matched against
// NetSuite's shipping service text, and ordered because the first match wins and
// some names contain others: "DHL eCommerce" before "DHL", and "FedEx SmartPost"
// (a FedEx label that USPS delivers, tracked at FedEx) before either on its own.
const CARRIER_LINKS = [
  { match: /fedex\s*smart\s*post/i, url: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}` },
  { match: /fedex|federal express/i, url: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}` },
  { match: /\bups\b|united parcel/i, url: (n) => `https://www.ups.com/track?loc=en_US&tracknum=${n}` },
  { match: /usps|postal service|priority mail|first[- ]class/i, url: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}` },
  { match: /dhl\s*e[-\s]?commerce/i, url: (n) => `https://www.dhl.com/en/express/tracking.html?AWB=${n}&brand=DHL` },
  { match: /\bdhl\b/i, url: (n) => `https://www.dhl.com/en/express/tracking.html?AWB=${n}&brand=DHL` },
  { match: /canada post|postes canada/i, url: (n) => `https://www.canadapost-postescanada.ca/track-reperage/en#/resultList?searchFor=${n}` },
  { match: /purolator/i, url: (n) => `https://www.purolator.com/en/shipping/tracker?pin=${n}` },
  { match: /\btnt\b/i, url: (n) => `https://www.tnt.com/express/en_us/site/tracking.html?searchType=con&cons=${n}` },
  { match: /\bgls\b/i, url: (n) => `https://gls-group.eu/EU/en/parcel-tracking?match=${n}` },
  { match: /\bdpd\b/i, url: (n) => `https://track.dpd.co.uk/search?reference=${n}` },
  { match: /royal mail/i, url: (n) => `https://www.royalmail.com/track-your-item#/tracking-results/${n}` },
  { match: /australia post|auspost/i, url: (n) => `https://auspost.com.au/mypost/track/#/details/${n}` },
];

// Last resort, when the shipment names no service at all — 5 of this account's
// 1452 tracked fulfillments. Only shapes that belong to one carrier and no other
// are here, because a link to the wrong carrier's site is worse than no link:
//   1Z + 16 alphanumerics  -> UPS, a format nothing else uses
//   22 digits starting 9   -> USPS IMpb
//   12 or 15 digits        -> FedEx
const NUMBER_SHAPES = [
  { match: /^1Z[0-9A-Z]{16}$/i, url: (n) => `https://www.ups.com/track?loc=en_US&tracknum=${n}` },
  { match: /^9\d{21}$/, url: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}` },
  { match: /^(\d{12}|\d{15})$/, url: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}` },
];

// The tracking link for one number.
//
// `template` is NetSuite's own, off the shipping method, and wins outright when
// it is there. {number} is where the number goes; a template without it gets the
// number appended, because a field filled in as a bare prefix
// ("https://www.fedex.com/fedextrack/?trknbr=") is the obvious way to fill one
// in and failing on it would mean a field that looks right and links nowhere.
// A template that is not a URL at all is ignored rather than half-built into
// one: a link to nowhere on a customer's order is worse than no link.
//
// With no template, the carrier is recognised from `carrierText` (the shipping
// service, then the carrier field) and, failing that, from the number's own
// shape. Nothing recognised means no link.
export function trackingUrlFor(template, number, carrierText) {
  if (!number) return null;
  const url = String(template || "").trim();
  if (/^https?:\/\//i.test(url)) {
    return url.includes("{number}")
      ? url.replaceAll("{number}", encodeURIComponent(number))
      : url + encodeURIComponent(number);
  }

  const text = String(carrierText || "").trim();
  const carrier = (text && CARRIER_LINKS.find((c) => c.match.test(text)))
    || NUMBER_SHAPES.find((s) => s.match.test(String(number).trim()));
  return carrier ? carrier.url(encodeURIComponent(number)) : null;
}

// The trackingInfo for a Shopify fulfillment write. Shopify takes either a
// single number/url pair or parallel numbers/urls arrays, and the arrays have to
// stay index-aligned — every number gets its own link off the same template.
//
// null when there is nothing to send at all, so a fulfillment created only to
// correct an order's state (NetSuite shipped it, Shopify never caught up) is not
// handed an empty trackingInfo.
export function trackingInfoFor(numbers, shipment) {
  const list = (numbers || []).filter(Boolean);
  const company = carrierName(shipment?.shipMethod, shipment?.carrier);
  if (!list.length) return company ? { company } : null;

  // Both carrier fields are offered to the URL step: the service names the
  // carrier on nearly every tracked shipment, and the carrier field is what a
  // handful of them have instead.
  const carrierText = [shipment?.shipMethod, shipment?.carrier].filter(Boolean).join(" ");
  const urls = list.map((n) => trackingUrlFor(shipment?.trackingUrlTemplate, n, carrierText));
  if (list.length === 1) {
    return { ...(company ? { company } : {}), number: list[0], ...(urls[0] ? { url: urls[0] } : {}) };
  }
  return {
    ...(company ? { company } : {}),
    numbers: list,
    // All-or-nothing: Shopify pairs urls to numbers by position, so a partial
    // list would hang the wrong link off the wrong number.
    ...(urls.every(Boolean) ? { urls } : {}),
  };
}
