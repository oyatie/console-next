// SPDX-License-Identifier: LicenseRef-Proprietary
import { useSyncExternalStore } from "react";

export type OpsTheme = "light" | "dark";

const THEME_KEY = "console.ops.theme";
const listeners = new Set<() => void>();

function readTheme(): OpsTheme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

export function setOpsTheme(next: OpsTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-experience", "console");
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // Storage may be blocked in private contexts.
  }
  listeners.forEach((l) => l());
}

export function toggleOpsTheme(): void {
  setOpsTheme(readTheme() === "dark" ? "light" : "dark");
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (typeof document === "undefined") return () => listeners.delete(listener);
  const observer = new MutationObserver(() => listener());
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => {
    listeners.delete(listener);
    observer.disconnect();
  };
}

export function useOpsTheme(): OpsTheme {
  return useSyncExternalStore(subscribe, readTheme, () => "light");
}
