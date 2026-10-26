// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRouter } from "@tanstack/react-router";
import { expect, test } from "vitest";
import type { AccessEffective } from "../reference/authz/api";
import { accessRefusal } from "../reference/authz/domain/access";
import { routeTree } from "./tree";
import { activeLink, tenantNav } from "../shell/nav";

const routes = createRouter({ routeTree }).routesByPath;
const access = (domain: string, level: string, kind = "TENANT", enforcement = "ENFORCED") => ({
  is_ops: false, entries: [{ grant_id: "held", domain, level, scope: { kind }, enforcement }],
}) as AccessEffective;
const links = (held?: AccessEffective, support = false) => tenantNav(held, routes, support).flatMap(g => g.links.map(l => l.to));

test("loading links stay a fixed prefix when access and support finish in either order", () => {
  const pending = links();
  expect(pending).toEqual(["/", "/requests"]);
  for (const held of [{ is_ops: true, entries: [] }, { is_ops: false, entries: [] },
    ...["org", "hr_basic", "access", "exceptions", "attendance", "exit"].flatMap(domain =>
      ["view", "edit", "approve", "export"].flatMap(level => ["TENANT", "LEGAL_ENTITY", "WORKPLACE", "DEPARTMENT"].map(kind => access(domain, level, kind)))),
  ] as AccessEffective[]) for (const support of [false, true]) {
    const ready = links(held, support);
    expect(ready.slice(0, pending.length)).toEqual(pending);
    expect(ready).toContain("/people/requests");
  }
});

test.each(["TENANT", "LEGAL_ENTITY", "WORKPLACE", "DEPARTMENT"])("HR readers at %s see only directory destinations their reads admit", kind => {
  expect(links(access("hr_basic", "view", kind))).toEqual(["/", "/requests", "/people", ...(kind !== "DEPARTMENT" ? ["/attendance"] : []), "/people/requests", ...(kind !== "DEPARTMENT" ? ["/people/exits"] : [])]);
});

test("an account manager without a directory grant cannot reach people", () => {
  expect(links(access("access", "edit"))).toEqual(["/", "/requests", "/people/requests", "/access"]);
});

test.each(["attendance", "exit"])("a %s writer does not get a directory read link the server refuses", domain => {
  expect(links(access(domain, "edit"))).toEqual(links({ is_ops: false, entries: [] } as unknown as AccessEffective));
});

test.each(["org", "hr_basic", "access", "exceptions", "attendance", "exit"])("navigation agrees with every destination's requirement for %s", domain => {
  const all = links({ is_ops: true, entries: [] } as unknown as AccessEffective);
  for (const level of ["view", "edit", "approve", "export"]) for (const kind of ["TENANT", "DEPARTMENT"]) {
    const held = access(domain, level, kind);
    for (const path of all) {
      const need = routes[path]!.options.staticData!.access!;
      expect(links(held).includes(path), `${path}: ${level} ${kind}`).toBe(need === "signed-in" || accessRefusal(held, need) === null);
    }
  }
});

test("tenant-only links and unenforced entries do not appear", () => {
  expect(links(access("exceptions", "edit", "DEPARTMENT"))).not.toContain("/people/period-locks");
  expect(links(access("exceptions", "edit"))).toContain("/people/period-locks");
  expect(links(access("org", "view", "TENANT", "REVOKED"))).not.toContain("/org");
  expect(links(access("org", "view", "DEPARTMENT"))).not.toContain("/org");
  for (const kind of ["TENANT", "LEGAL_ENTITY", "WORKPLACE"]) expect(links(access("org", "view", kind))).toContain("/org");
});

test("support approval still uses its server realm decision", () => {
  expect(links({ is_ops: false, entries: [] } as unknown as AccessEffective, true)).toContain("/audit/support-access");
  expect(links(undefined, true)).toEqual(links());
  expect(links()).not.toContain("/audit/support-access");
});

test("only the deepest navigation destination is active", () => {
  const all = links({ is_ops: true, entries: [] } as unknown as AccessEffective).map(to => ({ to }));
  expect(activeLink("/people/period-locks", all)).toBe("/people/period-locks");
  expect(activeLink("/people/exits/record", all)).toBe("/people/exits");
  expect(activeLink("/people/person", all)).toBe("/people");
  expect(activeLink("/org/changes/record", all)).toBe("/org");
  expect(activeLink("/", all)).toBeUndefined();
});
