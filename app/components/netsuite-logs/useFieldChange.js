import { useEffect, useRef } from "react";

// React 18's synthetic onChange only covers native form elements, so it can't be
// relied on to fire for a Polaris web component — the listener is attached to the
// element itself instead. (onClick is fine: React's click delegation reaches any
// element, which is how the rest of this app's s-buttons work.) `change` also
// fires on commit rather than per keystroke, so a search field doesn't navigate on
// every character.
//
// The handler's identity is what keys the listener, so pass a stable one
// (useCallback) — a fresh closure each render detaches and re-attaches on every
// one of them.
export function useFieldChange(handler) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const onChange = (event) => handler(String(event.target?.value ?? ""));
    el.addEventListener("change", onChange);
    return () => el.removeEventListener("change", onChange);
  }, [handler]);
  return ref;
}
