// Finds the tracking URL on a NetSuite Shipping Item record.
//
// Matched on the VALUE, not on the field's name. A custom field's id is whatever
// the person who created it typed — custitem_tracking_url, custitem_track_link,
// custitem2 — and a sync that only recognised one spelling would be a sync that
// silently does nothing on an account that spelled it differently. What cannot
// vary is what is IN the field: a tracking URL is an http(s) address.
//
// Two things qualify, in order:
//   1. any column whose value carries the {number} placeholder — that is a
//      tracking URL template and nothing else is;
//   2. an http(s) value in a column whose NAME mentions track/url/link.
//
// Rule 2 is name-guarded on purpose. A shipping item can hold other URLs (a
// carrier's home page, a rate card, a label service), and hanging one of those
// off a customer's tracking number would be worse than having no link at all.
// `pinned` (NETSUITE_TRACKING_URL_FIELD) skips both rules and reads exactly the
// column named, for an account whose field neither rule finds.
const URLISH_FIELD = /track|url|link/i;

export function pickTrackingUrlTemplate(row, pinned) {
  if (pinned) return httpUrl(row?.[pinned]);
  const entries = Object.entries(row || {}).filter(([key]) => key !== "links");
  for (const [, value] of entries) {
    const url = httpUrl(value);
    if (url && url.includes("{number}")) return url;
  }
  for (const [key, value] of entries) {
    if (!URLISH_FIELD.test(key)) continue;
    const url = httpUrl(value);
    if (url) return url;
  }
  return null;
}

function httpUrl(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return /^https?:\/\//i.test(text) ? text : null;
}
