import { useEffect, useRef } from "react";

/**
 * Keys for a region while focus is inside it (WCAG 2.1.4: a single-key shortcut never fires from a text field and
 * never page-wide). The listener sits on the region's element; `onKey` returns true when it handled the key.
 */
export function useKeys<T extends HTMLElement>(onKey: (e: KeyboardEvent) => boolean) {
  const ref = useRef<T>(null);
  const handler = useRef(onKey);
  useEffect(() => {
    handler.current = onKey;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const listen = (e: KeyboardEvent) => {
      if (handler.current(e)) e.preventDefault();
    };
    el.addEventListener("keydown", listen);
    return () => el.removeEventListener("keydown", listen);
  }, []);
  return ref;
}

/** True when the key was typed into a text field (a shortcut letter must not fire there). */
export const inField = (e: KeyboardEvent) => e.target instanceof HTMLElement && !!e.target.closest("input, textarea, select");
