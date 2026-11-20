// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import {
  appendExplicitWorkspaceTab,
  closeWorkspaceTab,
  MAX_WORKSPACE_TABS,
  readStoredWorkspaceTabs,
  reconcileWorkspaceTabs,
} from "./workspace-tabs-state";

test("readStoredWorkspaceTabs rejects malformed payloads and returns null when empty", () => {
  expect(readStoredWorkspaceTabs(null)).toBeNull();
});

test("reconcileWorkspaceTabs pins index 0 and reuses the active working tab on normal navigation", () => {
  const step1 = reconcileWorkspaceTabs([], undefined, {
    defaultHref: "/",
    defaultLabel: "Home",
    pathname: "/",
    pathLabel: "Home",
  });
  expect(step1.tabs).toEqual([{ id: "pinned-home", href: "/", label: "Home", pinned: true }]);
  expect(step1.activeId).toBe("pinned-home");

  const step2 = reconcileWorkspaceTabs(step1.tabs, step1.activeId, {
    defaultHref: "/",
    defaultLabel: "Home",
    pathname: "/people",
    pathLabel: "Employees",
  });
  expect(step2.tabs).toHaveLength(2);
  expect(step2.tabs[1]?.href).toBe("/people");

  // Navigating from /people to /org reuses the working tab in place instead of piling up tabs.
  const step3 = reconcileWorkspaceTabs(step2.tabs, step2.activeId, {
    defaultHref: "/",
    defaultLabel: "Home",
    pathname: "/org",
    pathLabel: "Org structure",
  });
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

test("reconcileWorkspaceTabs assigns distinct tab ids after working-tab reuse and returning home", () => {
  const step1 = reconcileWorkspaceTabs([], undefined, {
    defaultHref: "/",
    defaultLabel: "Home",
    pathname: "/",
    pathLabel: "Home",
  });
  const step2 = reconcileWorkspaceTabs(step1.tabs, step1.activeId, {
    defaultHref: "/",
    defaultLabel: "Home",
    pathname: "/people",
    pathLabel: "People",
  });
  const step3 = reconcileWorkspaceTabs(step2.tabs, step2.activeId, {
    defaultHref: "/",
    defaultLabel: "Home",
    pathname: "/org",
    pathLabel: "Org",
  });
  const step4 = reconcileWorkspaceTabs(step3.tabs, step3.activeId, {
    defaultHref: "/",
    defaultLabel: "Home",
    pathname: "/",
    pathLabel: "Home",
  });
  const step5 = reconcileWorkspaceTabs(step4.tabs, step4.activeId, {
    defaultHref: "/",
    defaultLabel: "Home",
    pathname: "/people",
    pathLabel: "People",
  });

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
