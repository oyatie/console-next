// SPDX-License-Identifier: LicenseRef-Proprietary
import { useSyncExternalStore } from "react";

export type OpsLocale = "en" | "ko";

export const OPS_LOCALE_KEY = "ops.locale";
const listeners = new Set<() => void>();

export function getOpsLocale(): OpsLocale {
  if (typeof window === "undefined") return "en";
  try {
    const stored = localStorage.getItem(OPS_LOCALE_KEY);
    if (stored === "ko" || stored === "en") return stored;
  } catch {
    // Storage may be blocked in restricted contexts.
  }
  const nav = typeof navigator !== "undefined" ? navigator.language.toLowerCase() : "en";
  return nav.startsWith("ko") ? "ko" : "en";
}

export function syncOpsDocumentLang(locale: OpsLocale = getOpsLocale()): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
}

export function setOpsLocale(next: OpsLocale): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(OPS_LOCALE_KEY, next);
  } catch {
    // Storage may be blocked in restricted contexts.
  }
  syncOpsDocumentLang(next);
  listeners.forEach((fn) => fn());
}

export function toggleOpsLocale(): void {
  setOpsLocale(getOpsLocale() === "ko" ? "en" : "ko");
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useOpsLocale(): OpsLocale {
  return useSyncExternalStore(subscribe, getOpsLocale, () => "en");
}
