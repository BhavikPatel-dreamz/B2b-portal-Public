// The ranges the log page's "Sync now" control offers, and the labels that name
// them everywhere afterwards — the toast, the run log, the log row's detail.
//
// Deliberately NOT a .server module: the dropdown that renders these ships to the
// browser, while the sync that runs them does not. Keeping the list in one place
// is what stops the two disagreeing about what "last 2 hours" means.
//
// `value` is what the form field carries; `hours` is how far back the window
// reaches from the moment Sync now is pressed. hours 0 is the scheduled run's own
// behaviour: no window at all, pick up from the watermark.
export const SYNC_WINDOWS = [
  { value: "", hours: 0, label: "Current (since last sync)" },
  { value: "1", hours: 1, label: "Last 1 hour" },
  { value: "2", hours: 2, label: "Last 2 hours" },
  { value: "6", hours: 6, label: "Last 6 hours" },
  { value: "12", hours: 12, label: "Last 12 hours" },
  { value: "24", hours: 24, label: "Last day" },
  { value: "48", hours: 48, label: "Last 2 days" },
];

export function windowLabel(hours) {
  const match = SYNC_WINDOWS.find((w) => w.hours === Number(hours));
  return match?.hours ? match.label.toLowerCase() : `last ${hours} hour(s)`;
}
