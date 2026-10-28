// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRouter } from "@tanstack/react-router";
import { expect, test } from "vitest";
import type { AccessEffective } from "../reference/authz/api";
import { accessRefusal } from "../reference/authz/domain/access";
import { routeTree } from "./tree";
import { activeLink, tenantNav } from "../shell/nav";
import { SETTINGS_VIEWS } from "../shell/settings-views";

const routes: Parameters<typeof tenantNav>[1] = createRouter({ routeTree }).routesByPath;
const access = (domain: string, level: string, kind = "TENANT", enforcement = "ENFORCED") => ({
  is_ops: false, entries: [{ grant_id: "held", domain, level, scope: { kind }, enforcement }],
}) as AccessEffective;
const links = (held?: AccessEffective, support = false, pathname = "/") => tenantNav(held, routes, support, { pathname }).flatMap(g => g.links.map(l => l.to));

const admin = { is_ops: true, entries: [] } as unknown as AccessEffective;
const roleFixtures = [admin, { is_ops: false, entries: [] } as unknown as AccessEffective,
  ...["org", "hr_basic", "access", "exceptions", "attendance", "exit"].flatMap(domain =>
    ["view", "edit", "approve", "export"].flatMap(level => ["TENANT", "LEGAL_ENTITY", "WORKPLACE", "DEPARTMENT"].map(kind => access(domain, level, kind)))),
];
const context = (pathname = "/", phase = "OPERATING", setupTargets?: readonly string[]) => ({ pathname, phase, setupTargets });
const menu = (pathname = "/", phase = "OPERATING", setupTargets?: readonly string[], held = admin, tree = routes) =>
  tenantNav(held, tree, false, context(pathname, phase, setupTargets));
const top = (groups: ReturnType<typeof tenantNav>) => groups.flatMap(g => g.links.map(l => l.to));

test("SETUP follows non-blocked checklist targets, with safe destinations on a refused read", () => {
  expect(top(menu("/", "SETUP", ["/org", "/people", "/access"]))).toEqual(["/", "/org", "/people", "/access"]);
  expect(top(menu("/", "SETUP", ["/org/entities/new", "/access/roles/new"]))).toEqual(["/", "/org", "/access"]);
  expect(top(menu("/", "SETUP", undefined, access("org", "view")))).toEqual(["/", "/org"]);
  expect(top(menu("/", "SETUP", undefined))).toEqual(["/", "/org", "/people", "/access"]);
  expect(top(menu("/", "SETUP", []))).toEqual(["/"]);
});

test("OPERATING has at most nine entries, distinct icons and no standalone subviews", () => {
  const groups = menu();
  expect(top(groups)).toEqual(["/", "/people/requests", "/org", "/people", "/attendance", "/statutory", "/access", "/settings"]);
  expect(groups.length).toBeLessThanOrEqual(3);
  const icons = groups.flatMap(g => g.links.map(l => l.icon));
  expect(new Set(icons).size).toBe(icons.length);
  expect(top(tenantNav(admin, routes, true, context()))).toHaveLength(9);
});

test.each([{ targets: undefined }, { targets: [] }, { targets: ["/org", "/people", "/access"] }])("a no-grant SETUP account sees only home with targets $targets", ({ targets }) => {
  const held = { is_ops: false, entries: [] } as unknown as AccessEffective;
  expect(top(menu("/", "SETUP", targets, held))).toEqual(["/"]);
});

test.each([
  ["/people/exits/x", "/people"],
  ["/org/entities/x", "/org"],
  ["/org/history", "/org"],
])("%s keeps its module current without expanding the rail", (pathname, current) => {
  const entries = menu(pathname).flatMap(g => g.links);
  expect(entries.every(l => !("children" in l))).toBe(true);
  expect(activeLink(pathname, entries)).toBe(current);
  expect(top(menu(pathname))).toEqual(top(menu()));
});

test("a no-grant requester keeps their own requests until the inbox has a requester tab", () => {
  const held = { is_ops: false, entries: [] } as unknown as AccessEffective;
  expect(top(menu("/", "OPERATING", undefined, held))).toEqual(["/", "/people/requests"]);
  const tree = { ...routes };
  tree["/inbox"] = { options: { staticData: { access: "signed-in" } } };
  expect(top(menu("/people/requests", "OPERATING", undefined, held, tree))).toEqual(["/", "/people/requests"]);
  delete tree["/inbox"];
  expect(top(menu("/", "OPERATING", undefined, held, tree))).toEqual(["/", "/people/requests"]);
});

test("only served modules appear, including the support approval exception", () => {
  const tree = { ...routes };
  delete tree["/org"];
  delete tree["/audit/support-access"];
  delete tree["/settings"];
  const entries = tenantNav(admin, tree, true, context()).flatMap(g => g.links);
  expect(entries.map(l => l.to)).not.toEqual(expect.arrayContaining(["/org", "/audit/support-access", "/settings"]));
  expect(entries.every(l => !("children" in l))).toBe(true);
  expect(entries.map(l => l.to)).not.toContain("/org/entities");
});

test("loading links stay a fixed prefix when access and support finish in either order", () => {
  const pending = links();
  expect(pending).toEqual(["/"]);
  for (const held of roleFixtures) for (const support of [false, true]) {
    const ready = links(held, support);
    expect(ready.slice(0, pending.length)).toEqual(pending);
    expect(ready).toContain("/people/requests");
  }
});

test.each(["TENANT", "LEGAL_ENTITY", "WORKPLACE", "DEPARTMENT"])("HR readers at %s see only directory destinations their reads admit", kind => {
  expect(links(access("hr_basic", "view", kind), false, "/people")).toEqual(["/", "/people/requests", "/people", ...(kind !== "DEPARTMENT" ? ["/attendance"] : []), "/settings"]);
});

test("an account manager without a directory grant cannot reach people", () => {
  expect(links(access("access", "edit"))).toEqual(["/", "/people/requests", "/access"]);
});

test.each(["attendance", "exit"])("a %s writer does not get a directory read link the server refuses", domain => {
  expect(links(access(domain, "edit"))).toEqual(links({ is_ops: false, entries: [] } as unknown as AccessEffective));
});

test.each(["org", "hr_basic", "access", "exceptions", "attendance", "exit"])("navigation agrees with every destination's requirement for %s", domain => {
  const all = [...new Set(["/org", "/people"].flatMap(path => links(admin, false, path)))];
  for (const level of ["view", "edit", "approve", "export"]) for (const kind of ["TENANT", "DEPARTMENT"]) {
    const held = access(domain, level, kind);
    for (const path of all) {
      const need = routes[path]!.options.staticData!.access!;
      expect(links(held, false, path).includes(path), `${path}: ${level} ${kind}`).toBe(need === "signed-in" || accessRefusal(held, need) === null);
    }
  }
});

test("tenant-only links and unenforced entries do not appear", () => {
  expect(links(access("exceptions", "edit", "DEPARTMENT"), false, "/settings")).not.toContain("/people/period-locks");
  expect(links(access("exceptions", "edit"), false, "/settings")).toContain("/settings");
  expect(links(access("org", "view", "TENANT", "REVOKED"))).not.toContain("/org");
  expect(links(access("org", "view", "DEPARTMENT"))).not.toContain("/org");
  for (const kind of ["TENANT", "LEGAL_ENTITY", "WORKPLACE"]) expect(links(access("org", "view", kind))).toContain("/org");
});

test.each([false, true])("every permitted rail module is reachable for each role fixture (future routes: %s)", future => {
  const tree: typeof routes = future ? { ...routes,
    "/inbox": { options: { staticData: { access: { domain: "hr_basic", level: "view" } } } },
    "/settings": { options: { staticData: { access: { domain: "access", level: "edit", tenant: true } } } },
  } : routes;
  const destinations = [...new Set(Object.keys(tree).flatMap(pathname =>
    tenantNav(admin, tree, true, context(pathname)).flatMap(g => g.links.map(l => l.to))))];
  for (const held of roleFixtures) for (const support of [false, true]) {
    const reachable = new Set(destinations.flatMap(pathname => tenantNav(held, tree, support, context(pathname))
      .flatMap(g => g.links.map(l => l.to))));
    for (const path of destinations) {
      const need = tree[path]!.options.staticData!.access!;
      const permitted = path === "/audit/support-access" ? support : need === "signed-in" || accessRefusal(held, need) === null;
      expect(reachable.has(path), `${path}: ${JSON.stringify(held)} support=${support}`).toBe(permitted);
    }
  }
});

test("support approval still uses its server realm decision", () => {
  expect(links({ is_ops: false, entries: [] } as unknown as AccessEffective, true)).toContain("/audit/support-access");
  expect(links(undefined, true)).toEqual(links());
  expect(links()).not.toContain("/audit/support-access");
});

test("only the deepest navigation destination is active", () => {
  const all = menu().flatMap(g => g.links);
  expect(activeLink("/people/period-locks", all)).toBe("/settings");
  expect(activeLink("/people/exits/record", all)).toBe("/people");
  expect(activeLink("/people/person", all)).toBe("/people");
  expect(activeLink("/org/changes/record", all)).toBe("/org");
  expect(activeLink("/", all)).toBeUndefined();
});

test.each(SETTINGS_VIEWS)("settings owns the location cue for $to and its detail screens", ({ to }) => {
  const entries = menu().flatMap(g => g.links);
  expect(activeLink(to, entries)).toBe("/settings");
  expect(activeLink(`${to}/record`, entries)).toBe("/settings");
  expect(activeLink(`${to}-other`, entries)).toBe(to.startsWith("/people/") ? "/people" : "/settings");
});

test("an absent settings entry cannot be highlighted by a settings destination", () => {
  expect(activeLink("/people/period-locks", [{ to: "/people" }])).toBe("/people");
});

test.each(SETTINGS_VIEWS)("$to follows its entry's destination rather than a settings path literal", ({ to }) => {
  const entries = [{ to: "/people" }, { to: "/preferences", views: SETTINGS_VIEWS }];
  expect(activeLink(to, entries)).toBe("/preferences");
  expect(activeLink(`${to}/record`, entries)).toBe("/preferences");
  expect(activeLink("/people/exits/record", entries)).toBe("/people");
});


test.each(["/people", "/people/exits/x", "/org/entities/x", "/settings"])("%s keeps the rail flat and highlights its module", pathname => {
  const entries = menu(pathname).flatMap(g => g.links);
  expect(entries.every(l => !("children" in l))).toBe(true);
  expect(entries.map(l => l.to)).not.toEqual(expect.arrayContaining(["/people/exits", "/org/entities", "/people/period-locks"]));
});
