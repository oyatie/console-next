// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitFixtureEnvironment } from "../../../../scripts/lib/git-fixture-environment.mjs";
import { qualityRef } from "../../../../scripts/quality/base.mjs";
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

function assertExceptions(exceptions: typeof allow, root = process.cwd()) {
  const base = qualityRef(root);
  const file = "apps/web/src/routes/route-floorplan-allow.json";
  const existed = execFileSync("git", ["ls-tree", "--name-only", base, "--", file], { cwd: root, encoding: "utf8" }).trim();
  const previous: string[] = existed ? JSON.parse(execFileSync("git", ["show", `${base}:${file}`], { cwd: root, encoding: "utf8" })) : allow;
  for (const path of exceptions) expect(previous, path).toContain(path);
}

test("route floorplan exceptions can only shrink", () => assertExceptions(allow));


test("exception growth is refused against dev's upstream when local dev has no registry", () => {
  const root = mkdtempSync(join(tmpdir(), "route-exceptions-"));
  const env = gitFixtureEnvironment();
  delete env.QUALITY_BASE;
  const file = "apps/web/src/routes/route-floorplan-allow.json";
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: root, env, stdio: "pipe" });
  const override = process.env.QUALITY_BASE;
  delete process.env.QUALITY_BASE;
  try {
    git("init", "-b", "dev");
    git("commit", "--allow-empty", "-m", "test: seed local dev");
    git("switch", "-c", "topic");
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), JSON.stringify(allow));
    git("add", ".");
    git("commit", "-m", "test: seed upstream exceptions");
    git("remote", "add", "team", "https://example.invalid/console.git");
    git("update-ref", "refs/remotes/team/dev", "HEAD");
    git("branch", "--set-upstream-to=team/dev", "dev");
    expect(() => assertExceptions(allow, root)).not.toThrow();
    writeFileSync(join(root, file), "[]");
    git("add", ".");
    git("commit", "-m", "test: remove upstream exceptions");
    git("update-ref", "refs/remotes/team/dev", "HEAD");
    expect(() => assertExceptions(allow, root)).toThrow();
  } finally {
    if (override === undefined) delete process.env.QUALITY_BASE;
    else process.env.QUALITY_BASE = override;
    rmSync(root, { recursive: true, force: true });
  }
});
