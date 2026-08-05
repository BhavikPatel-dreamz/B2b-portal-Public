/* eslint-disable react/prop-types -- prop-types is not a dependency in this
   app; these components are typed by their one call site. */
import { detailPairs, statusTone } from "../../lib/netsuite/logs.shared.js";
import { LabelledRow } from "./LabelledRow.jsx";

// Everything one log row recorded. The known fields as label/value lines, then the
// raw JSON underneath for the ones detailPairs doesn't name — a row written by a
// newer sync than this page still shows all of its result, just less prettily.
export function LogDetailModal({ row, timeZone }) {
  return (
    <s-modal id="log-detail" heading="Log entry">
      {row && (
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-badge tone={statusTone(row.status)}>{row.status}</s-badge>
            <s-text type="strong">
              {row.action} · {row.reference || row.externalId || "—"}
            </s-text>
          </s-stack>
          {detailPairs(row, timeZone).map(([label, value]) => (
            <LabelledRow key={label} label={label}>
              {String(value)}
            </LabelledRow>
          ))}
          <s-divider direction="inline"></s-divider>
          <s-text tone="neutral">Raw result</s-text>
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-text>{row.detail}</s-text>
          </s-box>
        </s-stack>
      )}
      <s-button slot="secondary-actions" commandFor="log-detail" command="--hide">
        Close
      </s-button>
    </s-modal>
  );
}
