import { useEffect, useRef } from "react";

/** A field opened by a button the user just pressed takes focus once (Esc or the button's neighbour gets it back). */
export function useFocusInside<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => ref.current?.querySelector<HTMLElement>("input, textarea, select")?.focus(), []);
  return ref;
}
