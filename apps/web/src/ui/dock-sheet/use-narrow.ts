import { useSyncExternalStore } from "react";

const NARROW = "(max-width: 959px)";
const subscribe = (on: () => void) => {
  const m = window.matchMedia(NARROW);
  m.addEventListener("change", on);
  return () => m.removeEventListener("change", on);
};
/** True below 960 px, where a docked sheet becomes the modal Sheet (spec §12.2). */
export const useNarrow = () => useSyncExternalStore(subscribe, () => window.matchMedia(NARROW).matches, () => false);
