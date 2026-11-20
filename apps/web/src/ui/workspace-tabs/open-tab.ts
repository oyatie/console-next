// SPDX-License-Identifier: LicenseRef-Proprietary
export type OpenTabPayload = {
  href: string;
  label: string;
};

export const OPEN_TAB_EVENT = "console:open-workspace-tab";

/** Resolve an app-relative href (`/...`, `?query`, `#hash`), rejecting external or protocol-relative URLs. */
export function resolveAppHref(href: string, basePathname = "/"): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/")) {
    return trimmed.startsWith("//") || trimmed.startsWith("/\\") ? null : trimmed;
  }
  if (trimmed.startsWith("?") || trimmed.startsWith("#")) {
    const cut = basePathname.search(/[?#]/);
    const path = (cut === -1 ? basePathname : basePathname.slice(0, cut)) || "/";
    const base = path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\") ? path : "/";
    return `${base}${trimmed}`;
  }
  return null;
}

/** Explicitly open a route in a separate workspace tab (capped at `MAX_WORKSPACE_TABS`). */
export function openWorkspaceTab(payload: OpenTabPayload) {
  if (typeof window === "undefined") return;
  const trimmed = payload.href.trim();
  if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/\\")) return;
  if (!trimmed.startsWith("/") && !trimmed.startsWith("?") && !trimmed.startsWith("#")) return;
  window.dispatchEvent(new CustomEvent<OpenTabPayload>(OPEN_TAB_EVENT, { detail: { ...payload, href: trimmed } }));
}
