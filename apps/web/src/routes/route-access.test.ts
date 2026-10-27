// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync } from "node:child_process";
import { createRouter, type AnyRoute, type StaticDataRouteOption } from "@tanstack/react-router";
import { expect, test } from "vitest";
import { routeTree } from "./tree";
import allow from "./route-access-allow.json";
import { routeList } from "../../../../e2e/helpers/route-list";

const router = createRouter({ routeTree });
const appRoutes = Object.values(router.routesById).filter((route: AnyRoute) => route.id.startsWith("/app/"));
const signedIn = (path: string) => ["/", "/inbox", "/account", "/requests", "/people/requests"].includes(path) || path.includes("$");

function assertAccess(route: { fullPath: string; options: { staticData?: StaticDataRouteOption } }, exceptions: Record<string, { lane: string; reason: string }>) {
  const access = route.options.staticData?.access;
  expect(access, route.fullPath).toBeDefined();
  if (access === "signed-in" && !signedIn(route.fullPath)) expect(exceptions, route.fullPath).toHaveProperty(route.fullPath);
  if (access && access !== "signed-in") {
    if ("destinations" in access) {
      expect(access.destinations.length, route.fullPath).toBeGreaterThan(0);
      for (const need of access.destinations) expect(appRoutes.some(child => child.options.staticData?.access === need && routeList.some(item => item.path === child.fullPath && item.reads.length)), route.fullPath).toBe(true);
    } else expect(routeList.find(item => item.path === route.fullPath)?.reads.length, route.fullPath).toBeGreaterThan(0);
  }
}

test("every app route declares access; realm exceptions have an owner and reason", () => {
  expect(router.routesById["/app"].options.staticData?.access).toBe("signed-in");
  for (const route of appRoutes) assertAccess(route, allow);
  for (const [path, exception] of Object.entries(allow)) {
    expect(appRoutes.find(route => route.fullPath === path)?.options.staticData?.access, path).toBe("signed-in");
    expect(exception.lane).toBe("LMG-PLAT");
    expect(exception.reason.length).toBeGreaterThan(0);
  }
});

test("a new undeclared route and removing a live realm exception both fail", () => {
  expect(() => assertAccess({ fullPath: "/new-screen", options: { staticData: {} } }, allow)).toThrow();
  expect(() => assertAccess({ fullPath: "/platform", options: { staticData: { access: "signed-in" } } }, {})).toThrow();
  expect(() => assertAccess({ fullPath: "/new-hub", options: { staticData: { access: { destinations: [{ domain: "org", level: "view" }] } } } }, {})).toThrow();
});

test("route access exceptions can only shrink", () => {
  const base = process.env.QUALITY_BASE ?? "dev";
  const file = "apps/web/src/routes/route-access-allow.json";
  const existed = execFileSync("git", ["ls-tree", "--name-only", base, "--", file], { encoding: "utf8" }).trim();
  const previous = existed ? JSON.parse(execFileSync("git", ["show", `${base}:${file}`], { encoding: "utf8" })) : {
    "/platform": allow["/platform"], "/audit/support-access": allow["/audit/support-access"],
  };
  for (const [path, exception] of Object.entries(allow)) expect(previous[path], path).toEqual(exception);
});

test("the E2E route walk equals the router's static paths", () => {
  expect(routeList.map(route => route.path).sort()).toEqual(appRoutes.map(route => route.fullPath).sort());
});
