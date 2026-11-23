import { useRef } from "react";
import { useMountFocus } from "../../ui/page/use-mount-focus";

/** A field opened by a button the user just pressed takes focus once (Esc or the button's neighbour gets it back). */
export function useFocusInside<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useMountFocus(true, () => ref.current?.querySelector<HTMLElement>("input, textarea, select") ?? null, undefined, undefined, true);
  return ref;
}
