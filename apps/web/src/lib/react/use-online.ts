// SPDX-License-Identifier: LicenseRef-Proprietary
import { useSyncExternalStore } from "react";

const subscribe = (on: () => void) => {
  window.addEventListener("online", on);
  window.addEventListener("offline", on);
  return () => {
    window.removeEventListener("online", on);
    window.removeEventListener("offline", on);
  };
};

/** Browser connectivity: keep loaded data and drafts visible while disconnected. */
export const useOnline = () => useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
