// SPDX-License-Identifier: LicenseRef-Proprietary
import { useSyncExternalStore } from "react";

const PHONE_QUERY = "(max-width: 767px)";

function subscribePhoneQuery(listener: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mql = window.matchMedia(PHONE_QUERY);
  mql.addEventListener("change", listener);
  return () => mql.removeEventListener("change", listener);
}

function getPhoneSnapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(PHONE_QUERY).matches;
}

export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribePhoneQuery, getPhoneSnapshot, () => false);
}
