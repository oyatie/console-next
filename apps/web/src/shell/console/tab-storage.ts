// SPDX-License-Identifier: LicenseRef-Proprietary
import { resolveAppHref } from "../../ui/workspace-tabs/open-tab";
import { hrefPath } from "./tab-href";

export const MAX_WORKSPACE_TABS = 8;

export type StoredTab = {
  id: string;
  href: string;
  label: string;
  pinned?: boolean;
};

export function readStoredWorkspaceTabs(storageKey: string | null): StoredTab[] | null {
  if (!storageKey || typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const valid = parsed.filter(
      (item): item is StoredTab =>
        Boolean(item) &&
        typeof item === "object" &&
        typeof (item as StoredTab).id === "string" &&
        typeof (item as StoredTab).href === "string" &&
        resolveAppHref((item as StoredTab).href) !== null &&
        typeof (item as StoredTab).label === "string",
    );
    return valid.length > 0 ? valid.slice(0, MAX_WORKSPACE_TABS) : null;
  } catch {
    return null;
  }
}

export function writeStoredWorkspaceTabs(storageKey: string | null, tabs: readonly StoredTab[]): boolean {
  if (!storageKey || typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify(tabs.map(({ id, href, label, pinned }) => ({ id, href, label, ...(pinned ? { pinned: true } : {}) }))),
    );
    return true;
  } catch {
    return false;
  }
}

export function uniqueTabId(existing: readonly StoredTab[], pathname: string): string {
  const baseId = `tab-${hrefPath(pathname)}`;
  if (!existing.some(tab => tab.id === baseId)) return baseId;
  let suffix = 2;
  while (existing.some(tab => tab.id === `${baseId}-${suffix}`)) suffix += 1;
  return `${baseId}-${suffix}`;
}
