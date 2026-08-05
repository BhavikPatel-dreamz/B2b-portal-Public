/* eslint-disable react/prop-types -- prop-types is not a dependency in this
   app; these components are typed by their one call site. */
// A visible bar, not just a number: it is the one thing on the page that says a
// run is moving rather than stuck. Same track/fill shape as the credit-usage bar
// on the home page, so a bar means the same thing everywhere in this app.
//
// One count and one colour. `done` is orders finished, `total` is orders this run
// has to do — the number the NetSuite list call came back with. The bar used to
// change colour to mark a fetching phase and a syncing phase; it does not now,
// because the log rows arrive per order (see appendSyncLogRow) and the table
// below is the better answer to "what is it doing".
export function SyncProgressBar({ done, total }) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div style={{ marginBottom: 2 }}>
      <div style={{ height: 8, background: "#e4e5e7", borderRadius: 6, overflow: "hidden" }}>
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: "#008060",
            borderRadius: 6,
            // Matches the ~5s poll interval closely enough that a jump between
            // ticks reads as motion instead of a series of snaps.
            transition: "width 0.6s ease",
          }}
        />
      </div>
      <div style={{ textAlign: "right", fontSize: 11, color: "#6d7175", marginTop: 2 }}>{pct}%</div>
    </div>
  );
}
