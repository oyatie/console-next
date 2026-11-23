import { expect, test } from "vitest";
import type { Org } from "../api";
import { MOVES, TARGET, filterTenants, inView, matches, needsAttention, sortTenants, tenantKpiCounts } from "./tenants";

const org = { name: "한빛정밀", slug: "hanbit", group_name: "Acme Group", status: "SUSPENDED" as const };

test("views split by status; all holds everything", () => {
  expect(inView(org, "suspended")).toBe(true);
  expect(inView(org, "active")).toBe(false);
  expect(inView(org, "all")).toBe(true);
});

test("search matches the name, slug or group, ignoring case and surrounding spaces", () => {
  expect(matches(org, "한빛")).toBe(true);
  expect(matches(org, " HAN ")).toBe(true);
  expect(matches(org, "acme")).toBe(true);
  expect(matches(org, "")).toBe(true);
  expect(matches({ ...org, group_name: null }, "acme")).toBe(false);
});

test("every offered move leads away from the current status", () => {
  for (const [from, moves] of Object.entries(MOVES)) for (const m of moves) expect(TARGET[m]).not.toBe(from);
  expect(MOVES.ARCHIVED).toEqual(["resume"]);
});

test("needsAttention, tenantKpiCounts, filterTenants, and sortTenants handle Console facets", () => {
  const orgs: Org[] = [
    { id: "1", name: "Beta Corp", slug: "beta", status: "ACTIVE", lifecycle: "OPERATING", group_id: "g1", group_slug: "g1", group_name: "G1", created_at: "2026-10-02T00:00:00Z", updated_at: "2026-10-02T00:00:00Z" },
    { id: "2", name: "Alpha Corp", slug: "alpha", status: "ACTIVE", lifecycle: "CODE_ISSUED", group_id: null, group_slug: null, group_name: null, created_at: "2026-10-03T00:00:00Z", updated_at: "2026-10-03T00:00:00Z" },
    { id: "3", name: "Gamma Corp", slug: "gamma", status: "SUSPENDED", lifecycle: "SETUP", group_id: "g1", group_slug: "g1", group_name: "G1", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" },
  ];
  expect(needsAttention(orgs[0]!)).toBe(false);
  expect(needsAttention(orgs[1]!)).toBe(true);
  expect(needsAttention(orgs[2]!)).toBe(true);
  expect(tenantKpiCounts(orgs)).toEqual({ all: 3, active: 2, suspended: 1, archived: 0, attention: 2 });
  expect(filterTenants(orgs, { q: "", statuses: new Set(), lifecycles: new Set(), groupFilter: "__none__", attentionOnly: true }).map((o) => o.id)).toEqual(["2"]);
  expect(sortTenants(orgs, "name", "asc").map((o) => o.id)).toEqual(["2", "1", "3"]);
  expect(sortTenants(orgs, "created_at", "desc").map((o) => o.id)).toEqual(["2", "1", "3"]);
});
