/* eslint-disable react/prop-types -- prop-types is not a dependency in this
   app; these components are typed by their one call site. */
import { useCallback } from "react";

import { useFieldChange } from "./useFieldChange.js";

const STATUS_OPTIONS = [
  ["", "All statuses"],
  ["failed", "Failed"],
  ["success", "Success"],
  ["skipped", "Skipped"],
];

// The filter row above the table. Every change is a navigation (see `apply` in the
// route), so the URL is the state: a filtered view can be linked and the browser's
// back button does what it looks like it does.
export function LogFilters({ filters, timeZone, onApply, onClear }) {
  // Memoised because useFieldChange keys its listener on the handler's identity.
  const searchRef = useFieldChange(useCallback((v) => onApply({ q: v }), [onApply]));
  const statusRef = useFieldChange(useCallback((v) => onApply({ status: v }), [onApply]));
  const fromRef = useFieldChange(useCallback((v) => onApply({ from: v }), [onApply]));
  const toRef = useFieldChange(useCallback((v) => onApply({ to: v }), [onApply]));
  const hasAny = Boolean(
    filters.q || filters.status || filters.from || filters.to || filters.retryable,
  );

  return (
    <s-grid slot="filters" gap="small-200" gridTemplateColumns="1fr auto auto auto auto">
      <s-search-field
        ref={searchRef}
        label="Search logs"
        labelAccessibilityVisibility="exclusive"
        placeholder="SO number, order name, company, error…"
        value={filters.q}
      ></s-search-field>
      <s-select
        ref={statusRef}
        label="Status"
        labelAccessibilityVisibility="exclusive"
        name="status"
        value={filters.status}
      >
        {STATUS_OPTIONS.map(([value, label]) => (
          <s-option key={value} value={value}>
            {label}
          </s-option>
        ))}
      </s-select>
      {/* Whole days in the sync's own zone, named on the field: a date-only
          input cannot carry a zone, so which midnight it means has to be said
          out loud or the column and its filter disagree by the offset. */}
      <s-date-field
        ref={fromRef}
        label={`From (${timeZone})`}
        labelAccessibilityVisibility="exclusive"
        placeholder={`From (${timeZone})`}
        value={filters.from}
      ></s-date-field>
      <s-date-field
        ref={toRef}
        label={`To (${timeZone})`}
        labelAccessibilityVisibility="exclusive"
        placeholder={`To (${timeZone})`}
        value={filters.to}
      ></s-date-field>
      <s-button variant="secondary" onClick={onClear} {...(hasAny ? {} : { disabled: true })}>
        Clear
      </s-button>
    </s-grid>
  );
}
