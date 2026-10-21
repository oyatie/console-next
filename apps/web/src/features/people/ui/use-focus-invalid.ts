import { useRef } from "react";

// A control, never the invalid group around it (a radiogroup carries aria-invalid too and takes no focus).
const CONTROL = '[data-invalid] input, :is(input, select, textarea)[aria-invalid="true"]';

/** A container ref and a call that moves focus to its first invalid control after a refused submit. */
export function useFocusInvalid<E extends HTMLElement>() {
  const ref = useRef<E>(null);
  const focus = () =>
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(CONTROL)?.focus());
  return [ref, focus] as const;
}
