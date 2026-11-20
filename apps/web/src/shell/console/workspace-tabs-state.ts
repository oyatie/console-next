// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useState } from "react";
import { OPEN_TAB_EVENT, type OpenTabPayload } from "../../ui/workspace-tabs/open-tab";
import type { WorkspaceTab } from "../../ui/workspace-tabs/workspace-tabs";

export const MAX_WORKSPACE_TABS = 8;

type StoredTab = {
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
        (item as StoredTab).href.startsWith("/") &&
        typeof (item as StoredTab).label === "string",
    );
    return valid.length > 0 ? valid.slice(0, MAX_WORKSPACE_TABS) : null;
  } catch {
    return null;
  }
}

function writeStoredWorkspaceTabs(storageKey: string | null, tabs: readonly StoredTab[]): boolean {
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

function uniqueTabId(existing: readonly StoredTab[], pathname: string): string {
  const baseId = `tab-${pathname}`;
  if (!existing.some(tab => tab.id === baseId)) return baseId;
  let suffix = 2;
  while (existing.some(tab => tab.id === `${baseId}-${suffix}`)) suffix += 1;
  return `${baseId}-${suffix}`;
}

/**
 * Reconcile open workspace tabs when the router `pathname` changes during normal navigation:
 * - Index `0` is always pinned to `defaultHref`.
 * - If `pathname` matches an already-open tab, that tab stays in place and becomes active.
 * - Otherwise, the active non-pinned tab updates in place (or a single working tab opens beside index `0`),
 *   preventing unbounded tab accumulation during ordinary navigation.
 */
export function reconcileWorkspaceTabs(
  previous: readonly StoredTab[],
  activeId: string | undefined,
  {
    defaultHref,
    defaultLabel,
    pathname,
    pathLabel,
  }: {
    defaultHref: string;
    defaultLabel: string;
    pathname: string;
    pathLabel: string;
  },
): { tabs: StoredTab[]; activeId: string } {
  const pinnedHome: StoredTab = {
    id: "pinned-home",
    href: defaultHref,
    label: defaultLabel,
    pinned: true,
  };
  const rest = previous.filter((tab, idx) => idx > 0 && tab.href !== defaultHref).slice(0, MAX_WORKSPACE_TABS - 1);
  const base = [pinnedHome, ...rest];

  if (pathname === defaultHref) {
    return { tabs: base, activeId: pinnedHome.id };
  }

  const existing = base.find(tab => tab.href === pathname);
  if (existing) {
    return {
      tabs: base.map(tab => (tab.id === existing.id ? { ...tab, label: pathLabel } : tab)),
      activeId: existing.id,
    };
  }

  const activeNonPinnedIdx = base.findIndex((tab, idx) => idx > 0 && tab.id === activeId && !tab.pinned);
  if (activeNonPinnedIdx > 0) {
    const target = base[activeNonPinnedIdx]!;
    const updated = base.map((tab, idx) =>
      idx === activeNonPinnedIdx ? { ...tab, href: pathname, label: pathLabel } : tab,
    );
    return { tabs: updated, activeId: target.id };
  }

  if (base.length < MAX_WORKSPACE_TABS) {
    const workingId = base[1] && !base[1].pinned ? base[1].id : uniqueTabId(base, pathname);
    if (base.length === 1) {
      const created: StoredTab = { id: workingId, href: pathname, label: pathLabel };
      return { tabs: [pinnedHome, created], activeId: created.id };
    }
    const nextTab: StoredTab = { id: uniqueTabId(base, pathname), href: pathname, label: pathLabel };
    return { tabs: [...base, nextTab], activeId: nextTab.id };
  }

  // At the 8-tab cap, reuse the last non-pinned tab.
  const replaceIdx = base.length - 1;
  const replaced = base[replaceIdx]!;
  return {
    tabs: base.map((tab, idx) => (idx === replaceIdx ? { ...tab, href: pathname, label: pathLabel } : tab)),
    activeId: replaced.id,
  };
}

/** Explicitly append or focus a tab (via `+` or "open in tab"), respecting `MAX_WORKSPACE_TABS`. */
export function appendExplicitWorkspaceTab(
  current: readonly StoredTab[],
  { href, label }: OpenTabPayload,
): { tabs: StoredTab[]; activeId: string } {
  const existing = current.find(tab => tab.href === href);
  if (existing) {
    return {
      tabs: current.map(tab => (tab.id === existing.id ? { ...tab, label } : tab)),
      activeId: existing.id,
    };
  }
  const id = uniqueTabId(current, href);
  const created: StoredTab = { id, href, label };
  if (current.length < MAX_WORKSPACE_TABS) {
    return { tabs: [...current, created], activeId: id };
  }
  // Evict the oldest closable tab (index 1) when at cap.
  const next = [current[0]!, ...current.slice(2), created];
  return { tabs: next, activeId: id };
}

export function closeWorkspaceTab(
  current: readonly StoredTab[],
  closingId: string,
  activeId: string,
): { tabs: StoredTab[]; activeId: string; navigateTo?: string } {
  const idx = current.findIndex(tab => tab.id === closingId);
  if (idx <= 0 || current[idx]?.pinned) return { tabs: [...current], activeId };
  const next = current.filter(tab => tab.id !== closingId);
  if (closingId !== activeId) {
    return { tabs: next, activeId };
  }
  const fallback = next[Math.min(idx, next.length - 1)] ?? next[0]!;
  return { tabs: next, activeId: fallback.id, navigateTo: fallback.href };
}

export function useWorkspaceTabs({
  principal,
  defaultHref,
  defaultLabel,
  pathname,
  pathLabel,
  countsByHref,
  onNavigate,
}: {
  principal: string | null;
  defaultHref: string;
  defaultLabel: string;
  pathname: string;
  pathLabel: string;
  countsByHref: Readonly<Record<string, number | undefined>>;
  onNavigate: (href: string) => void;
}) {
  const storageKey = principal ? `console.tabs.${principal}` : null;
  const [state, setState] = useState<{ key: string | null; tabs: StoredTab[]; activeId: string }>(() => {
    const stored = readStoredWorkspaceTabs(storageKey) ?? [];
    const reconciled = reconcileWorkspaceTabs(stored, undefined, {
      defaultHref,
      defaultLabel,
      pathname,
      pathLabel,
    });
    return { key: storageKey, ...reconciled };
  });

  if (state.key !== storageKey) {
    const stored = readStoredWorkspaceTabs(storageKey) ?? [];
    const reconciled = reconcileWorkspaceTabs(stored, undefined, {
      defaultHref,
      defaultLabel,
      pathname,
      pathLabel,
    });
    setState({ key: storageKey, ...reconciled });
  } else {
    const activeTab = state.tabs.find(tab => tab.id === state.activeId);
    if (!activeTab || activeTab.href !== pathname || activeTab.label !== pathLabel || state.tabs[0]?.label !== defaultLabel) {
      const reconciled = reconcileWorkspaceTabs(state.tabs, state.activeId, {
        defaultHref,
        defaultLabel,
        pathname,
        pathLabel,
      });
      if (
        reconciled.activeId !== state.activeId ||
        JSON.stringify(reconciled.tabs) !== JSON.stringify(state.tabs)
      ) {
        setState({ key: storageKey, ...reconciled });
      }
    }
  }

  useEffect(() => {
    writeStoredWorkspaceTabs(storageKey, state.tabs);
  }, [storageKey, state.tabs]);

  useEffect(() => {
    const onExplicitOpen = (event: Event) => {
      const detail = (event as CustomEvent<OpenTabPayload>).detail;
      if (!detail?.href) return;
      setState(prev => ({
        key: prev.key,
        ...appendExplicitWorkspaceTab(prev.tabs, detail),
      }));
      onNavigate(detail.href);
    };
    window.addEventListener(OPEN_TAB_EVENT, onExplicitOpen);
    return () => window.removeEventListener(OPEN_TAB_EVENT, onExplicitOpen);
  }, [onNavigate]);

  const tabs: WorkspaceTab[] = state.tabs.map((tab, idx) => ({
    id: tab.id,
    href: tab.href,
    label: tab.label,
    pinned: idx === 0 || tab.pinned,
    count: countsByHref[tab.href],
  }));

  const selectTab = (tab: WorkspaceTab) => {
    setState(prev => ({ ...prev, activeId: tab.id }));
    if (tab.href !== pathname) onNavigate(tab.href);
  };

  const closeTab = (tabId: string) => {
    const outcome = closeWorkspaceTab(state.tabs, tabId, state.activeId);
    setState({ key: storageKey, tabs: outcome.tabs, activeId: outcome.activeId });
    if (outcome.navigateTo && outcome.navigateTo !== pathname) {
      onNavigate(outcome.navigateTo);
    }
  };

  return {
    tabs,
    activeId: state.activeId,
    selectTab,
    closeTab,
  };
}
