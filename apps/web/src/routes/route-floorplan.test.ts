// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync } from "node:child_process";
import { createRouter, type AnyRoute, type StaticDataRouteOption } from "@tanstack/react-router";
import { expect, test } from "vitest";
import allow from "./route-floorplan-allow.json";
import { ROUTE_FLOORPLANS } from "./app";
import { routeTree } from "./tree";

const router = createRouter({ routeTree });
const appRoutes = Object.values(router.routesById).filter((route: AnyRoute) => route.id.startsWith("/app/"));
const floorplans = new Set(ROUTE_FLOORPLANS);

function assertFloorplan(route: { fullPath: string; options: { staticData?: StaticDataRouteOption } }, exceptions: readonly string[]) {
  const floorplan = route.options.staticData?.floorplan;
  if (!floorplan) return expect(exceptions, route.fullPath).toContain(route.fullPath);
  expect(exceptions, route.fullPath).not.toContain(route.fullPath);
  expect(floorplans, route.fullPath).toContain(floorplan);
}

test("every app route declares a catalogue floorplan", () => {
  for (const route of appRoutes) assertFloorplan(route, allow);
  for (const path of allow) expect(appRoutes.find(route => route.fullPath === path)?.options.staticData?.floorplan, path).toBeUndefined();
});

test("a missing or unknown floorplan fails", () => {
  expect(() => assertFloorplan({ fullPath: "/missing", options: { staticData: {} } }, [])).toThrow();
  expect(() => assertFloorplan({ fullPath: "/unknown", options: { staticData: { floorplan: "P-06" as never } } }, [])).toThrow();
});

test("route floorplan exceptions can only shrink", () => {
  const base = process.env.QUALITY_BASE ?? "dev";
  const file = "apps/web/src/routes/route-floorplan-allow.json";
  const existed = execFileSync("git", ["ls-tree", "--name-only", base, "--", file], { encoding: "utf8" }).trim();
  const previous: string[] = existed ? JSON.parse(execFileSync("git", ["show", `${base}:${file}`], { encoding: "utf8" })) : allow;
  for (const path of allow) expect(previous, path).toContain(path);
});
