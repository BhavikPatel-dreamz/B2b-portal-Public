/* eslint-disable react/prop-types -- prop-types is not a dependency in this
   app; these components are typed by their one call site. */
import { useEffect, useRef } from "react";

// A selection checkbox, for the same reason useFieldChange exists: `change` has to
// be listened for on the element itself. It is a component rather than a hook
// because there is one per row and hooks can't be called in a loop.
//
// `checked`/`indeterminate` are spread in only when true — React 18 renders
// `checked={false}` on a custom element as the attribute checked="false", which a
// web component reads as present, i.e. checked.
export function SelectCheckbox({ checked, indeterminate, label, onToggle }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const onChange = () => onToggle();
    el.addEventListener("change", onChange);
    return () => el.removeEventListener("change", onChange);
  }, [onToggle]);
  return (
    <s-checkbox
      ref={ref}
      accessibilityLabel={label}
      {...(checked ? { checked: true } : {})}
      {...(indeterminate ? { indeterminate: true } : {})}
    ></s-checkbox>
  );
}
