// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRouter, isRedirect, type AnyRoute } from "@tanstack/react-router";
import { expect, test } from "vitest";
import { routeTree } from "./tree";

const routes: Record<string, AnyRoute> = createRouter({ routeTree }).routesByPath;
const cases = [
  { path: "/org/entities", search: { add: true, correction: "correction-id", as_of: "2026-10-01", known_at: "2026-10-02T00:00:00Z", bulk: "paste" }, target: { tab: "entities", add: true, correction: "correction-id", as_of: "2026-10-01", known_at: "2026-10-02T00:00:00Z", bulk: "paste" } },
  { path: "/org/changes", search: { view: "approval", effective_from: "2026-10-01", effective_to: "2026-10-31" }, target: { tab: "changes", filter: "approval", effective_from: "2026-10-01", effective_to: "2026-10-31" } },
  { path: "/org/history", search: { as_of: "2026-10-01" }, target: { as_of: "2026-10-01", tab: "changes", filter: "history" } },
  { path: "/setup/company-names", search: {}, target: { tab: "entities" } },
] as const;

for (const row of cases) test(`${row.path} preserves validated parameters and hash with replace`, () => {
  const route = routes[row.path]!;
  const search = route.options.validateSearch?.(row.search) ?? row.search;
  expect(route.options.beforeLoad).toBeTypeOf("function");
  try {
    route.options.beforeLoad!({ search, location: { hash: "entities-title" } } as never);
    expect.fail("the legacy page must redirect");
  } catch (error) {
    expect(isRedirect(error)).toBe(true);
    expect(error).toMatchObject({ options: { to: "/org", search: row.target, hash: "entities-title", replace: true } });
  }
});

test.each(["/org/changes/$id", "/org/entities/$id", "/org/entities/new", "/org/entities/$id/workplaces/new"])("%s keeps its record or creation screen", path => {
  expect(routes[path]!.options.beforeLoad).toBeUndefined();
  expect(routes[path]!.options.component).toBeDefined();
});

test("the org validator separates chart view, change filter and entity controls", () => {
  const validate = routes["/org"]!.options.validateSearch!;
  expect(validate({ tab: "changes", filter: "approval", view: "list", effective_from: "2026-10-01", effective_to: "2026-10-31" })).toMatchObject({ tab: "changes", filter: "approval", view: "list", effective_from: "2026-10-01", effective_to: "2026-10-31" });
  expect(validate({ tab: "entities", add: "true", correction: "x", bulk: "import" })).toMatchObject({ tab: "entities", add: true, correction: "x", bulk: "import" });
  expect(validate({ tab: "unknown", filter: "unknown", view: "approval", bulk: "unknown" })).toMatchObject({ tab: undefined, filter: undefined, view: undefined, bulk: undefined });
});
