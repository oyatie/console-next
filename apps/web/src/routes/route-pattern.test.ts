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
  for (const id of [
    "list-record",
    "worklist",
    "record",
    "document-decision",
    "month-grid",
    "register-totals",
    "form",
    "phone-hub",
    "phone-statement",
  ]) {
    expect(Object.keys(router.routesById), `the ${id} review route is registered`).toContain(`/app/_review/patterns/${id}`);
  }
  const declared = Object.fromEntries(routes.flatMap(route => route.options.staticData?.pattern ? [[route.fullPath, route.options.staticData.pattern]] : []));
  expect(declared).toEqual({
    "/": "worklist",
    "/inbox": "worklist",
    "/people": "list-record",
    "/approvals": "worklist",
    "/approvals/$approvalId": "document-decision",
    "/attendance": "month-grid",
    "/account": "phone-hub",
    "/_review/patterns/list-record": "list-record",
    "/_review/patterns/worklist": "worklist",
    "/_review/patterns/record": "record",
    "/_review/patterns/document-decision": "document-decision",
    "/_review/patterns/month-grid": "month-grid",
    "/_review/patterns/register-totals": "register-totals",
    "/_review/patterns/form": "form",
    "/_review/patterns/phone-hub": "phone-hub",
    "/_review/patterns/phone-statement": "phone-statement",
  });
});
