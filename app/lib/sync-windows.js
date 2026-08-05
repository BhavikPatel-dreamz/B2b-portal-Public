// The ranges the log page's "Sync now" control offers, and the labels that name
// them everywhere afterwards — the toast, the run log, the log row's detail.
//
// Deliberately NOT a .server module: the dropdown that renders these ships to the
// browser, while the sync that runs them does not. Keeping the list in one place
// is what stops the two disagreeing about what "last 2 hours" means.
//
// `value` is what the form field carries; `hours` is how far back the window
// reaches from the moment Sync now is pressed.
//
// Every entry here is a WINDOW, so every run started from the page leaves the
// watermark alone. There used to be a "Current (since last sync)" entry with no
// window — the scheduled run fired by hand, and the only option that advanced
// the watermark. It is gone deliberately: advancing the watermark is now the
// cron's alone, so nothing pressed on the page can move where the schedule
// picks up from. The first entry is what the dropdown starts on.
export const SYNC_WINDOWS = [
  { value: "1", hours: 1, label: "Last 1 hour" },
  { value: "2", hours: 2, label: "Last 2 hours" },
  { value: "6", hours: 6, label: "Last 6 hours" },
  { value: "12", hours: 12, label: "Last 12 hours" },
  { value: "24", hours: 24, label: "Last day" },
  { value: "48", hours: 48, label: "Last 2 days" },
];

// What the dropdown is set to before anyone touches it. Taken from the list
// rather than written out again, so reordering the options cannot leave the
// default pointing at an entry that is no longer first — or, worse, at a value
// the list does not hold at all, which the Sync now route rejects outright.
export const DEFAULT_SYNC_WINDOW = SYNC_WINDOWS[0].value;

// The pair of instants a range means: `to` is the moment it is asked for, `from`
// is exactly that many hours earlier. Epoch arithmetic on absolute instants, so
// the server's (or the browser's) timezone never enters into it — the two can
// compute this independently and cannot disagree.
//
// It lives here, next to the list, because BOTH sides need it: the page shows
// the pair under the dropdown so the range is not just a name, and the run uses
// it as the window it really syncs. The page cannot import order-sync.server.js
// to get it, so without this the two would each do their own arithmetic — and a
// preview that quietly disagreed with the run would be worse than none.
export function windowRange(hours, at = new Date()) {
  return { from: new Date(at.getTime() - hours * 60 * 60 * 1000), to: at };
}

export function windowLabel(hours) {
  const match = SYNC_WINDOWS.find((w) => w.hours === Number(hours));
  return match?.hours ? match.label.toLowerCase() : `last ${hours} hour(s)`;
}
