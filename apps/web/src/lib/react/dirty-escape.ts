import { useEffect, useRef, useState } from "react";

/**
 * Esc closes an inline form, but never drops typed text on the first press: with input, the first Esc
 * only arms (the caller shows `armed` as a notice) and a second one closes. Put `ref` on the form's
 * container. Esc that a picker, a dialog or an IME composition already handled is left alone.
 */
export function useDirtyEscape<E extends HTMLElement = HTMLElement>(dirty: boolean, close: () => void) {
  const ref = useRef<E>(null);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return void (armed && setArmed(false));
      const target = e.target as HTMLElement;
      if (e.defaultPrevented || e.isComposing || target.closest('[role="listbox"], [role="dialog"]') || target.getAttribute("aria-expanded") === "true") return;
      e.preventDefault();
      if (dirty && !armed) return setArmed(true);
      setArmed(false);
      close();
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [dirty, close, armed]);
  return { ref, armed: armed && dirty };
}
