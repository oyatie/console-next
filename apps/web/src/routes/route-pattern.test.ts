// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRouter, type AnyRoute, type StaticDataRouteOption } from "@tanstack/react-router";
import { expect, test, vi } from "vitest";
import { BUILT_PATTERNS, PATTERNS, type PatternId } from "../ui/patterns/patterns";
import { routeTree } from "./tree";

// The review routes exist only in builds with this flag; it is set before the route modules are read.
vi.hoisted(() => vi.stubEnv("VITE_REVIEW_STATE_ROUTES", "1"));

const router = createRouter({ routeTree });
const routes: AnyRoute[] = Object.values(router.routesById);

function assertPattern(route: { fullPath: string; options: { staticData?: StaticDataRouteOption } }, built: readonly PatternId[] = BUILT_PATTERNS) {
  const pattern = route.options.staticData?.pattern;
  if (pattern === undefined) return;
  expect(PATTERNS, `${route.fullPath}: unknown pattern`).toContain(pattern);
  expect(built, `${route.fullPath}: pattern not built yet`).toContain(pattern);
}

test("every declared pattern is one of the thirteen and is built", () => {
  expect(PATTERNS).toHaveLength(13);
  for (const route of routes) assertPattern(route);
});

test("an unknown or unbuilt pattern fails", () => {
  const route = (pattern?: PatternId) => ({ fullPath: "/synthetic", options: { staticData: { pattern } } });
  expect(() => assertPattern(route("dashboard" as never))).toThrow("unknown pattern");
  expect(() => assertPattern(route("wizard"), ["list-record"])).toThrow("not built yet");
  expect(() => assertPattern(route("list-record"), ["list-record"])).not.toThrow();
  expect(() => assertPattern(route())).not.toThrow();
});

test("the screens drawn through built patterns declare them, and no other route declares a pattern", () => {
  expect(Object.keys(router.routesById), "the review routes are registered").toContain("/app/_review/patterns/list-record");
  expect(Object.keys(router.routesById), "the worklist review route is registered").toContain("/app/_review/patterns/worklist");
  const declared = Object.fromEntries(routes.flatMap(route => route.options.staticData?.pattern ? [[route.fullPath, route.options.staticData.pattern]] : []));
  expect(declared).toEqual({
    "/people": "list-record",
    "/_review/patterns/list-record": "list-record",
    "/_review/patterns/worklist": "worklist",
  });
});
