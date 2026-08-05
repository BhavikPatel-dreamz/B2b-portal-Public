/* eslint-disable react/prop-types -- prop-types is not a dependency in this
   app; these components are typed by their one call site. */
// One "Label  value" line. Used by the schedule card and by the detail modal —
// both are the same two-column shape, and having one component for it is what
// keeps the label column the same width in both.
export function LabelledRow({ label, children }) {
  return (
    <s-stack direction="inline" gap="base">
      <s-box inlineSize="180px">
        <s-text tone="neutral">{label}</s-text>
      </s-box>
      <s-text>{children}</s-text>
    </s-stack>
  );
}
