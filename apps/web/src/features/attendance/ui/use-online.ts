import { useSyncExternalStore } from "react";

const subscribe = (on: () => void) => {
  window.addEventListener("online", on);
  window.addEventListener("offline", on);
  return () => {
    window.removeEventListener("online", on);
    window.removeEventListener("offline", on);
  };
};

/** False while the browser is offline: saves wait (drafts stay in this tab), nothing is queued (spec §12.1). */
export const useOnline = () => useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
