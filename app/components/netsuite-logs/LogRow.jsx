/* eslint-disable react/prop-types -- prop-types is not a dependency in this
   app; these components are typed by their one call site. */
import { formatRunAt, statusTone, syncLabel } from "../../lib/netsuite/logs.shared.js";
import { SelectCheckbox } from "./SelectCheckbox.jsx";

// One log row. The selection cell and the re-sync cell only exist in the "Failed &
// skipped (latest)" view; both are conditional on the same `selectable` flag the
// header uses, so the two can never disagree about how many columns there are.
export function LogRow({ row, selectable, selected, syncing, timeZone, onToggle, onSync, onOpenDetail }) {
  return (
    <s-table-row>
      {selectable && (
        // Empty for a row with nothing to retry — a success, a whole run that
        // named no order, or an older attempt at an order that has a newer row.
        // The cell stays so the columns still line up.
        <s-table-cell>
          {row.canSync && (
            <SelectCheckbox checked={selected} label={syncLabel(row)} onToggle={onToggle} />
          )}
        </s-table-cell>
      )}
      <s-table-cell>{formatRunAt(row.runAt, timeZone)}</s-table-cell>
      <s-table-cell>{row.reference || row.externalId || "—"}</s-table-cell>
      <s-table-cell>{row.action}</s-table-cell>
      <s-table-cell>
        <s-badge tone={statusTone(row.status)}>{row.status}</s-badge>
      </s-table-cell>
      <s-table-cell>{row.orderName || "—"}</s-table-cell>
      <s-table-cell>
        <s-text tone={row.status === "failed" ? "critical" : "neutral"}>
          {row.message || "—"}
        </s-text>
      </s-table-cell>
      <s-table-cell>
        <s-button variant="tertiary" onClick={onOpenDetail}>
          Details
        </s-button>
      </s-table-cell>
      {selectable && (
        <s-table-cell>
          {row.canSync ? (
            <s-button
              variant="secondary"
              icon="refresh"
              accessibilityLabel={syncLabel(row)}
              onClick={onSync}
              {...(syncing ? { disabled: true } : {})}
            ></s-button>
          ) : (
            // A dash rather than a blank, so "no button here" reads as deliberate:
            // nothing on this row is left to re-sync.
            <s-text tone="neutral">—</s-text>
          )}
        </s-table-cell>
      )}
    </s-table-row>
  );
}
