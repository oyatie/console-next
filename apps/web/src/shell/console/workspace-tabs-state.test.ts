// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { resolveAppHref } from "../../ui/workspace-tabs/open-tab";
import {
  canonicalHref,
  isViewQueryRoute,
  normalizeAppPath,
  sameCanonicalHref,
} from "./tab-href";
import { MAX_WORKSPACE_TABS, readStoredWorkspaceTabs } from "./tab-storage";
import {
  appendExplicitWorkspaceTab,
  closeWorkspaceTab,
  reconcileWorkspaceTabs,
} from "./workspace-tabs-state";

const nav = (pathname: string, pathLabel = "Home", isFallbackLabel = false) => ({
  defaultHref: "/",
  defaultLabel: "Home",
  pathname,
  pathLabel,
  isFallbackLabel,
});

test("readStoredWorkspaceTabs rejects malformed payloads and returns null when empty", () => {
  expect(readStoredWorkspaceTabs(null)).toBeNull();
});

test("reconcileWorkspaceTabs pins index 0 and reuses the active working tab on normal navigation", () => {
  const step1 = reconcileWorkspaceTabs([], undefined, nav("/"));
  expect(step1.tabs).toEqual([{ id: "pinned-home", href: "/", label: "Home", pinned: true }]);
  expect(step1.activeId).toBe("pinned-home");

  const step2 = reconcileWorkspaceTabs(step1.tabs, step1.activeId, nav("/people", "Employees"));
  expect(step2.tabs).toHaveLength(2);
  expect(step2.tabs[1]?.href).toBe("/people");

  // Navigating from /people to /org reuses the working tab in place instead of piling up tabs.
  const step3 = reconcileWorkspaceTabs(step2.tabs, step2.activeId, nav("/org", "Org structure"));
  expect(step3.tabs).toHaveLength(2);
  expect(step3.tabs[1]?.href).toBe("/org");
});

test("appendExplicitWorkspaceTab caps open tabs at MAX_WORKSPACE_TABS and closeWorkspaceTab returns fallback", () => {
  let tabs: ReturnType<typeof reconcileWorkspaceTabs>["tabs"] = [
    { id: "pinned-home", href: "/", label: "Home", pinned: true },
  ];
  let activeId = "pinned-home";
  for (let i = 1; i <= MAX_WORKSPACE_TABS + 2; i++) {
    const res = appendExplicitWorkspaceTab(tabs, { href: `/people/${i}`, label: `Person ${i}` });
    tabs = res.tabs;
    activeId = res.activeId;
  }
  expect(tabs).toHaveLength(MAX_WORKSPACE_TABS);
  expect(tabs[0]?.href).toBe("/");
  expect(tabs.at(-1)?.href).toBe(`/people/${MAX_WORKSPACE_TABS + 2}`);

  // Pinned first tab refuses closing.
  expect(closeWorkspaceTab(tabs, "pinned-home", activeId).tabs).toHaveLength(MAX_WORKSPACE_TABS);

  // Closing the active last tab falls back to the preceding surviving tab.
  const closed = closeWorkspaceTab(tabs, activeId, activeId);
  expect(closed.tabs).toHaveLength(MAX_WORKSPACE_TABS - 1);
  expect(closed.navigateTo).toBe(`/people/${MAX_WORKSPACE_TABS + 1}`);
});

test("reconcileWorkspaceTabs preserves query and hash on explicit tabs when reconciled against bare pathname", () => {
  const initial = reconcileWorkspaceTabs([], undefined, nav("/"));
  const opened = appendExplicitWorkspaceTab(initial.tabs, {
    href: "/org/entities?correction=corr-1#identifier-corrections",
    label: "Entities",
  });
  const afterNav = reconcileWorkspaceTabs(opened.tabs, opened.activeId, nav("/org/entities", "Entities"));
  expect(afterNav.activeId).toBe(opened.activeId);
  expect(afterNav.tabs.find(tab => tab.id === opened.activeId)?.href).toBe(
    "/org/entities?correction=corr-1#identifier-corrections",
  );
});

test("reconcileWorkspaceTabs assigns distinct tab ids after working-tab reuse and returning home", () => {
  const step1 = reconcileWorkspaceTabs([], undefined, nav("/"));
  const step2 = reconcileWorkspaceTabs(step1.tabs, step1.activeId, nav("/people", "People"));
  const step3 = reconcileWorkspaceTabs(step2.tabs, step2.activeId, nav("/org", "Org"));
  const step4 = reconcileWorkspaceTabs(step3.tabs, step3.activeId, nav("/"));
  const step5 = reconcileWorkspaceTabs(step4.tabs, step4.activeId, nav("/people", "People"));

  expect(step5.tabs.map(t => t.href)).toEqual(["/", "/org", "/people"]);
  const ids = step5.tabs.map(t => t.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(step5.tabs[1]?.id).toBe("tab-/people");
  expect(step5.tabs[2]?.id).toBe("tab-/people-2");

  const closed = closeWorkspaceTab(step5.tabs, step5.tabs[2]!.id, step5.activeId);
  expect(closed.tabs.map(t => t.href)).toEqual(["/", "/org"]);
  expect(closed.navigateTo).toBe("/org");
});

test("appendExplicitWorkspaceTab assigns distinct tab ids after tab reuse and closing", () => {
  const t1 = appendExplicitWorkspaceTab(
    [{ id: "pinned-home", href: "/", label: "Home", pinned: true }],
    { href: "/people", label: "People" },
  );
  const t2 = appendExplicitWorkspaceTab(t1.tabs, { href: "/org", label: "Org" });
  // Simulate the first working tab having been reused for /approvals while keeping id "tab-/people".
  const renamed = t2.tabs.map((tab, idx) => (idx === 1 ? { ...tab, href: "/approvals", label: "Approvals" } : tab));
  const afterClose = closeWorkspaceTab(renamed, renamed[2]!.id, renamed[2]!.id);
  const reopened = appendExplicitWorkspaceTab(afterClose.tabs, { href: "/people", label: "People" });

  const ids = reopened.tabs.map(t => t.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(reopened.tabs.map(t => t.href)).toEqual(["/", "/approvals", "/people"]);
});

test("appendExplicitWorkspaceTab preserves pinned tab label when href matches a pinned tab", () => {
  const res = appendExplicitWorkspaceTab(
    [
      { id: "pinned-home", href: "/inbox", label: "Inbox", pinned: true },
      { id: "tab-/people", href: "/people", label: "People" },
    ],
    { href: "/inbox", label: "W-3" },
  );
  expect(res.activeId).toBe("pinned-home");
  expect(res.tabs[0]).toEqual({ id: "pinned-home", href: "/inbox", label: "Inbox", pinned: true });

  const nonPinned = appendExplicitWorkspaceTab(res.tabs, { href: "/people", label: "People (2)" });
  expect(nonPinned.activeId).toBe("tab-/people");
  expect(nonPinned.tabs[1]?.label).toBe("People (2)");
});

test("resolveAppHref resolves query/hash against current pathname and rejects external or protocol-relative URLs", () => {
  expect(resolveAppHref("?sel=from-inbox", "/inbox")).toBe("/inbox?sel=from-inbox");
  expect(resolveAppHref("#details", "/people/123?tab=history")).toBe("/people/123#details");
  expect(resolveAppHref("/people/123?tab=history", "/inbox")).toBe("/people/123?tab=history");
  expect(resolveAppHref("https://evil.example/phish", "/inbox")).toBeNull();
  expect(resolveAppHref("//evil.example/phish", "/inbox")).toBeNull();
  expect(resolveAppHref("/\\evil.example/phish", "/inbox")).toBeNull();
  expect(resolveAppHref("javascript:alert(1)", "/inbox")).toBeNull();
  expect(resolveAppHref("   ", "/inbox")).toBeNull();
});

test("readStoredWorkspaceTabs filters out protocol-relative hrefs", () => {
  const store = new Map<string, string>();
  const origLocalStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    },
  });
  try {
    store.set(
      "console.tabs.user1",
      JSON.stringify([
        { id: "pinned-home", href: "/", label: "Home", pinned: true },
        { id: "bad", href: "//evil.example/phish", label: "Evil" },
      ]),
    );
    expect(readStoredWorkspaceTabs("console.tabs.user1")).toEqual([
      { id: "pinned-home", href: "/", label: "Home", pinned: true },
    ]);
  } finally {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: origLocalStorage });
  }
});

test("canonicalHref and normalizeAppPath deduplicate trailing slashes and query order while distinguishing view-query routes", () => {
  expect(normalizeAppPath("/people/exits///")).toBe("/people/exits");
  expect(normalizeAppPath("/")).toBe("/");
  expect(sameCanonicalHref("/people/exits/", "/people/exits")).toBe(true);
  expect(sameCanonicalHref("/org?filter=history&tab=changes", "/org?tab=changes&filter=history")).toBe(true);
  expect(canonicalHref("/people/10587/?b=2&a=1")).toBe("/people/10587?a=1&b=2");
  expect(isViewQueryRoute("/org?tab=entities")).toBe(true);
  expect(isViewQueryRoute("/org?sel=u1")).toBe(false);
  expect(isViewQueryRoute("/people?tab=2")).toBe(true);
  expect(isViewQueryRoute("/people/10587?tab=events")).toBe(false);
});

test("reconcileWorkspaceTabs deduplicates stored duplicates while keeping distinct /people?tab=1..7 tabs", () => {
  const stored = [
    { id: "pinned-home", href: "/", label: "Home", pinned: true },
    { id: "t1", href: "/people/exits", label: "Exit management" },
    { id: "t2", href: "/people/exits/", label: "Exit management dup" },
    { id: "t3", href: "/people?tab=1", label: "Tab 1" },
    { id: "t4", href: "/people?tab=2", label: "Tab 2" },
  ];
  expect(reconcileWorkspaceTabs(stored, "t2", nav("/")).tabs.map(t => t.href)).toEqual([
    "/",
    "/people/exits",
    "/people?tab=1",
    "/people?tab=2",
  ]);
  const inactiveTrailing = reconcileWorkspaceTabs(
    [
      { id: "pinned-home", href: "/", label: "Home", pinned: true },
      { id: "t1", href: "/people/exits/", label: "Exit management" },
      { id: "t2", href: "/people/exits", label: "Exit management dup" },
    ],
    "pinned-home",
    nav("/"),
  );
  expect(inactiveTrailing.tabs.map(t => t.href)).toEqual(["/", "/people/exits"]);
});

test("reconcileWorkspaceTabs deduplicates colliding tab ids from localStorage", () => {
  const res = reconcileWorkspaceTabs(
    [
      { id: "pinned-home", href: "/", label: "Home", pinned: true },
      { id: "pinned-home", href: "/people", label: "People", pinned: true },
      { id: "tab-/people", href: "/org", label: "Org" },
      { id: "tab-/people", href: "/people/exits/", label: "Exits" },
    ],
    "pinned-home",
    nav("/"),
  );
  const ids = res.tabs.map(t => t.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(res.tabs[0]?.id).toBe("pinned-home");
  expect(res.tabs[1]?.id).not.toBe("pinned-home");
  expect(res.tabs[1]?.pinned).toBeUndefined();
  expect(res.tabs[3]?.href).toBe("/people/exits");
});

test("reconcileWorkspaceTabs preserves hash fragments on view-query routes when reconciled with hashless tabTarget", () => {
  const initial = reconcileWorkspaceTabs([], undefined, nav("/"));
  for (const [hashedHref, tabTarget, label] of [
    ["/org?tab=entities#identifier-corrections", "/org?tab=entities", "Entities"],
    ["/org?sel=ent-1&tab=entities#identifier-corrections", "/org?tab=entities", "Entities"],
    ["/people?view=accounts#account-42", "/people?view=accounts", "Accounts"],
    ["/attendance?tab=close#step-2", "/attendance?tab=close", "Close"],
    ["/statutory?tab=register#row-9", "/statutory?tab=register", "Register"],
  ] as const) {
    const opened = appendExplicitWorkspaceTab(initial.tabs, { href: hashedHref, label });
    const active = reconcileWorkspaceTabs(opened.tabs, opened.activeId, nav(tabTarget, label));
    expect(active.activeId).toBe(opened.activeId);
    expect(active.tabs.find(tab => tab.id === opened.activeId)?.href).toBe(hashedHref);

    // Reload / cold hydration (`activeId = undefined`) must also focus and preserve the hash without duplicating.
    const reload = reconcileWorkspaceTabs(opened.tabs, undefined, nav(tabTarget, label));
    expect(reload.tabs).toHaveLength(2);
    expect(reload.activeId).toBe(opened.activeId);
    expect(reload.tabs[1]?.href).toBe(hashedHref);
  }
  const orgEntities = appendExplicitWorkspaceTab(initial.tabs, {
    href: "/org?tab=entities#identifier-corrections",
    label: "Entities",
  });
  expect(reconcileWorkspaceTabs(orgEntities.tabs, orgEntities.activeId, nav("/org", "Org chart")).tabs[1]?.href).toBe("/org");
});

test("appendExplicitWorkspaceTab reuses non-view query variants of the same record path and respects isFallbackLabel", () => {
  const initial = reconcileWorkspaceTabs([], undefined, nav("/"));
  const opened = appendExplicitWorkspaceTab(initial.tabs, {
    href: "/people/10587?tab=events",
    label: "Ha-jun Yoon",
  });
  const reopened = appendExplicitWorkspaceTab(opened.tabs, {
    href: "/people/10587",
    label: "Ha-jun Yoon",
  });
  expect(reopened.tabs).toHaveLength(2);
  expect(reopened.activeId).toBe(opened.activeId);

  const loading = reconcileWorkspaceTabs(reopened.tabs, reopened.activeId, nav("/people/10587", "Employee card", true));
  expect(loading.tabs[1]?.label).toBe("Ha-jun Yoon");

  const loaded = reconcileWorkspaceTabs(loading.tabs, loading.activeId, nav("/people/10587", "Ha-jun Yoon · 10587"));
  expect(loaded.tabs[1]?.label).toBe("Ha-jun Yoon · 10587");

  const onEntities = reconcileWorkspaceTabs(initial.tabs, initial.activeId, nav("/org?tab=entities", "Entities & workplaces"));
  const backToChart = reconcileWorkspaceTabs(onEntities.tabs, onEntities.activeId, nav("/org", "Departments & org chart"));
  expect(backToChart.tabs[1]?.href).toBe("/org");
  expect(backToChart.tabs[1]?.label).toBe("Departments & org chart");
});
