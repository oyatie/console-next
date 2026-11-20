// SPDX-License-Identifier: LicenseRef-Proprietary
export type OpenTabPayload = {
  href: string;
  label: string;
};

export const OPEN_TAB_EVENT = "console:open-workspace-tab";

/** Explicitly open a route in a separate workspace tab (capped at `MAX_WORKSPACE_TABS`). */
export function openWorkspaceTab(payload: OpenTabPayload) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<OpenTabPayload>(OPEN_TAB_EVENT, { detail: payload }));
}
