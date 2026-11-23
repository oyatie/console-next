// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useState } from "react";
import { OPEN_TAB_EVENT, resolveAppHref, type OpenTabPayload } from "../../ui/workspace-tabs/open-tab";
import type { WorkspaceTab } from "../../ui/workspace-tabs/workspace-tabs";
import {
  canonicalHref,
  hasHash,
  hasQueryOrHash,
  hrefPath,
  isViewQueryRoute,
  sameCanonicalHref,
  sameTabTarget,
} from "./tab-href";
import {
  MAX_WORKSPACE_TABS,
  readStoredActiveWorkspaceTab,
  readStoredWorkspaceTabs,
  type StoredTab,
  uniqueTabId,
  writeStoredWorkspaceTabs,
} from "./tab-storage";

export function reconcileWorkspaceTabs(
  previous: readonly StoredTab[],
  activeId: string | undefined,
  {
    defaultHref,
    defaultLabel,
    pathname,
    pathLabel,
    isFallbackLabel = false,
  }: {
    defaultHref: string;
    defaultLabel: string;
    pathname: string;
    pathLabel: string;
    isFallbackLabel?: boolean;
  },
): { tabs: StoredTab[]; activeId: string } {
  const pinnedHome: StoredTab = {
    id: "pinned-home",
    href: defaultHref,
    label: defaultLabel,
    pinned: true,
  };
  const preferredByHref = new Map<string, StoredTab>();
  for (let idx = 1; idx < previous.length; idx++) {
    const tab = previous[idx]!;
    if (hrefPath(tab.href) === hrefPath(defaultHref) && !hasQueryOrHash(tab.href)) continue;
    const key = canonicalHref(tab.href);
    const existing = preferredByHref.get(key);
    if (!existing || tab.id === activeId) {
      preferredByHref.set(key, tab);
    }
  }
  const rest: StoredTab[] = [];
  const emitted = new Set<string>();
  const usedIds = new Set<string>([pinnedHome.id]);
  let normalizedActiveId = activeId;
  for (let idx = 1; idx < previous.length; idx++) {
    const key = canonicalHref(previous[idx]!.href);
    if (emitted.has(key)) continue;
    const chosen = preferredByHref.get(key);
    if (!chosen) continue;
    emitted.add(key);
    const rawId = chosen.id.trim();
    const id = rawId && !usedIds.has(rawId) ? rawId : uniqueTabId([pinnedHome, ...rest], key);
    usedIds.add(id);
    if (
      activeId &&
      chosen.id === activeId &&
      id !== activeId &&
      activeId !== pinnedHome.id &&
      !rest.some(tab => tab.id === activeId)
    ) {
      normalizedActiveId = id;
    }
    rest.push({ id, href: key, label: chosen.label });
    if (rest.length >= MAX_WORKSPACE_TABS - 1) break;
  }
  const base = [pinnedHome, ...rest];
  const resolveLabel = (currentLabel: string) =>
    isFallbackLabel && currentLabel.trim() && currentLabel !== defaultLabel ? currentLabel : pathLabel;

  if (sameTabTarget(defaultHref, pathname)) {
    return { tabs: base, activeId: pinnedHome.id };
  }

  const exact = base.find(tab => sameCanonicalHref(tab.href, pathname));
  if (exact) {
    return {
      tabs: base.map(tab => (tab.id === exact.id ? { ...tab, label: resolveLabel(tab.label) } : tab)),
      activeId: exact.id,
    };
  }

  const activeNonPinnedIdx = base.findIndex((tab, idx) => idx > 0 && tab.id === normalizedActiveId && !tab.pinned);
  const activeTab = activeNonPinnedIdx > 0 ? base[activeNonPinnedIdx] : undefined;
  if (activeTab && sameTabTarget(activeTab.href, pathname)) {
    return {
      tabs: base.map((tab, idx) => (idx === activeNonPinnedIdx ? { ...tab, label: resolveLabel(tab.label) } : tab)),
      activeId: activeTab.id,
    };
  }

  const existingByPath = !hasHash(pathname)
    ? base.find((tab, idx) => idx > 0 && sameTabTarget(tab.href, pathname))
    : undefined;
  if (existingByPath) {
    return {
      tabs: base.map(tab => (tab.id === existingByPath.id ? { ...tab, label: resolveLabel(tab.label) } : tab)),
      activeId: existingByPath.id,
    };
  }

  const targetHref = canonicalHref(pathname);
  if (activeNonPinnedIdx > 0) {
    const target = base[activeNonPinnedIdx]!;
    const updated = base.map((tab, idx) =>
      idx === activeNonPinnedIdx ? { ...tab, href: targetHref, label: pathLabel } : tab,
    );
    return { tabs: updated, activeId: target.id };
  }

  if (base.length < MAX_WORKSPACE_TABS) {
    const workingId = base[1] && !base[1].pinned ? base[1].id : uniqueTabId(base, targetHref);
    if (base.length === 1) {
      const created: StoredTab = { id: workingId, href: targetHref, label: pathLabel };
      return { tabs: [pinnedHome, created], activeId: created.id };
    }
    const nextTab: StoredTab = { id: uniqueTabId(base, targetHref), href: targetHref, label: pathLabel };
    return { tabs: [...base, nextTab], activeId: nextTab.id };
  }

  const replaceIdx = base.length - 1;
  const replaced = base[replaceIdx]!;
  return {
    tabs: base.map((tab, idx) => (idx === replaceIdx ? { ...tab, href: targetHref, label: pathLabel } : tab)),
    activeId: replaced.id,
  };
}

/** Explicitly append or focus a tab (via `+` or "open in tab"), respecting `MAX_WORKSPACE_TABS`. */
export function appendExplicitWorkspaceTab(
  current: readonly StoredTab[],
  { href, label }: OpenTabPayload,
): { tabs: StoredTab[]; activeId: string } {
  const normalized = canonicalHref(href);
  const existing =
    current.find(tab => sameCanonicalHref(tab.href, normalized)) ??
    current.find(tab => {
      if (tab.pinned) return hrefPath(tab.href) === hrefPath(normalized) && !hasQueryOrHash(normalized);
      if (hrefPath(tab.href) !== hrefPath(normalized)) return false;
      if (isViewQueryRoute(tab.href) || isViewQueryRoute(normalized)) return false;
      return true;
    });
  if (existing) {
    if (existing.pinned) {
      return { tabs: [...current], activeId: existing.id };
    }
    const nextHref = hasQueryOrHash(normalized) ? normalized : existing.href;
    const nextLabel = label.trim() ? label : existing.label;
    return {
      tabs: current.map(tab => (tab.id === existing.id ? { ...tab, href: nextHref, label: nextLabel } : tab)),
      activeId: existing.id,
    };
  }
  const id = uniqueTabId(current, normalized);
  const created: StoredTab = { id, href: normalized, label };
  if (current.length < MAX_WORKSPACE_TABS) {
    return { tabs: [...current, created], activeId: id };
  }
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
  currentHref,
  pathLabel,
  isFallbackLabel = false,
  onNavigate,
}: {
  principal: string | null;
  defaultHref: string;
  defaultLabel: string;
  pathname: string;
  currentHref?: string;
  pathLabel: string;
  isFallbackLabel?: boolean;
  onNavigate: (href: string) => void;
}) {
  const storageKey = principal ? `console.tabs.${principal}` : null;
  const activeUrl = currentHref ?? pathname;
  const [state, setState] = useState<{ key: string | null; tabs: StoredTab[]; activeId: string }>(() => {
    const stored = readStoredWorkspaceTabs(storageKey) ?? [];
    const storedActive = readStoredActiveWorkspaceTab(storageKey);
    const reconciled = reconcileWorkspaceTabs(stored, storedActive, {
      defaultHref,
      defaultLabel,
      pathname,
      pathLabel,
      isFallbackLabel,
    });
    return { key: storageKey, ...reconciled };
  });

  if (state.key !== storageKey) {
    const stored = readStoredWorkspaceTabs(storageKey) ?? [];
    const storedActive = readStoredActiveWorkspaceTab(storageKey);
    const reconciled = reconcileWorkspaceTabs(stored, storedActive, {
      defaultHref,
      defaultLabel,
      pathname,
      pathLabel,
      isFallbackLabel,
    });
    setState({ key: storageKey, ...reconciled });
  } else {
    const activeTab = state.tabs.find(tab => tab.id === state.activeId);
    const shouldKeepExplicitLabel =
      Boolean(activeTab) && isFallbackLabel && activeTab!.label.trim() !== "" && activeTab!.label !== defaultLabel;
    if (
      !activeTab ||
      !sameTabTarget(activeTab.href, pathname) ||
      (!shouldKeepExplicitLabel && activeTab.label !== pathLabel) ||
      state.tabs[0]?.label !== defaultLabel
    ) {
      const reconciled = reconcileWorkspaceTabs(state.tabs, state.activeId, {
        defaultHref,
        defaultLabel,
        pathname,
        pathLabel,
        isFallbackLabel,
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
    writeStoredWorkspaceTabs(storageKey, state.tabs, state.activeId);
  }, [storageKey, state.tabs, state.activeId]);

  useEffect(() => {
    const onExplicitOpen = (event: Event) => {
      const detail = (event as CustomEvent<OpenTabPayload>).detail;
      if (!detail?.href) return;
      const resolved = resolveAppHref(
        detail.href,
        hrefPath(activeUrl) || (typeof window !== "undefined" ? window.location.pathname : "/"),
      );
      if (!resolved) return;
      setState(prev => ({
        key: prev.key,
        ...appendExplicitWorkspaceTab(prev.tabs, { ...detail, href: resolved }),
      }));
      onNavigate(resolved);
    };
    window.addEventListener(OPEN_TAB_EVENT, onExplicitOpen);
    return () => window.removeEventListener(OPEN_TAB_EVENT, onExplicitOpen);
  }, [activeUrl, onNavigate]);

  const tabs: WorkspaceTab[] = state.tabs.map((tab, idx) => ({
    id: tab.id,
    href: tab.href,
    label: tab.label,
    pinned: idx === 0 || tab.pinned,
  }));

  const selectTab = (tab: WorkspaceTab) => {
    setState(prev => ({ ...prev, activeId: tab.id }));
    if (!sameCanonicalHref(tab.href, activeUrl)) onNavigate(tab.href);
  };

  const closeTab = (tabId: string) => {
    const outcome = closeWorkspaceTab(state.tabs, tabId, state.activeId);
    setState({ key: storageKey, tabs: outcome.tabs, activeId: outcome.activeId });
    if (outcome.navigateTo && !sameCanonicalHref(outcome.navigateTo, activeUrl)) {
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
