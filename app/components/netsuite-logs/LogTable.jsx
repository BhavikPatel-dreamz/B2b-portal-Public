/* eslint-disable react/prop-types -- prop-types is not a dependency in this
   app; these components are typed by their one call site. */
import { LogFilters } from "./LogFilters.jsx";
import { LogRow } from "./LogRow.jsx";
import { SelectCheckbox } from "./SelectCheckbox.jsx";

// The log table: its filter row, its header, and one LogRow per entry. Paging and
// filtering are both done in the query (see loadLogPage), so this renders the page
// it was handed and reports what was clicked.
export function LogTable({
  rows,
  filters,
  timeZone,
  page,
  hasPrev,
  hasNext,
  syncableIds,
  chosen,
  syncing,
  onApply,
  onClear,
  onToggleRow,
  onToggleAll,
  onSyncRows,
  onOpenDetail,
}) {
  // Selection and the re-sync column only exist in the "Failed & skipped (latest)"
  // view — the plain log is for reading, and anything re-syncable is in that view
  // anyway.
  const selectable = filters.retryable;

  return (
    <s-section padding="none">
      <s-table
        paginate
        hasPreviousPage={hasPrev}
        hasNextPage={hasNext}
        onPreviousPage={() => onApply({ page: String(page - 1) })}
        onNextPage={() => onApply({ page: String(page + 1) })}
      >
        <LogFilters filters={filters} timeZone={timeZone} onApply={onApply} onClear={onClear} />

        <s-table-header-row>
          {selectable && (
            <s-table-header>
              {syncableIds.length > 0 && (
                <SelectCheckbox
                  checked={chosen.length === syncableIds.length}
                  indeterminate={chosen.length > 0 && chosen.length < syncableIds.length}
                  label="Select every row on this page"
                  onToggle={onToggleAll}
                />
              )}
            </s-table-header>
          )}
          <s-table-header listSlot="primary">Run time</s-table-header>
          <s-table-header>NetSuite order</s-table-header>
          <s-table-header>Action</s-table-header>
          <s-table-header listSlot="secondary">Status</s-table-header>
          <s-table-header>Shopify order</s-table-header>
          <s-table-header>Reason / error</s-table-header>
          <s-table-header>Detail</s-table-header>
          {/* Its own column, not a second button beside Details: the two of them in
              one cell wrap onto separate lines as soon as the reason text is long,
              which is most of the time. */}
          {selectable && <s-table-header>Re-sync</s-table-header>}
        </s-table-header-row>

        <s-table-body>
          {rows.map((row) => (
            <LogRow
              key={row.id}
              row={row}
              selectable={selectable}
              selected={chosen.includes(row.id)}
              syncing={syncing}
              timeZone={timeZone}
              onToggle={() => onToggleRow(row.id)}
              onSync={() => onSyncRows([row.id])}
              onOpenDetail={() => onOpenDetail(row)}
            />
          ))}
        </s-table-body>
      </s-table>

      {rows.length === 0 && (
        <s-box padding="base">
          <s-paragraph tone="neutral">
            No log entries for this filter. Runs are logged by the cron sync
            (/api/cron/orders-sync).
          </s-paragraph>
        </s-box>
      )}
    </s-section>
  );
}
