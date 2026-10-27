// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRouter, type StaticDataRouteOption } from "@tanstack/react-router";
import { expect, test } from "vitest";
import { routeTree } from "./tree";
import { accessRefusal } from "../reference/authz/domain/access";
import { screenAccess } from "../../../../e2e/mock/fixtures";
import { SETTINGS_VIEWS, settingsRequirement, settingsViews } from "../shell/settings-views";

const router = createRouter({ routeTree });
const routes = Object.values(router.routesByPath);
const paths = (access: ReturnType<typeof screenAccess>) => settingsViews(routes, access).map(row => row.to);

test("tenant operator sees all four existing settings pages; unknown access shows none", () => {
  expect(paths({ ...screenAccess("/"), is_ops: true })).toEqual(SETTINGS_VIEWS.map(row => row.to));
  expect(settingsViews(routes, undefined)).toEqual([]);
});

test.each(SETTINGS_VIEWS)("$to derives visibility from its own served route requirement", view => {
  const access = screenAccess(view.to);
  expect(paths(access).includes(view.to)).toBe(view.to !== "/settings/company-domain");
    const without = routes.filter(route => route.fullPath !== view.to);
  expect(settingsViews(without, { ...access, is_ops: true }).some(row => row.to === view.to)).toBe(false);
});

test("branch HR sees job titles; tenant HR may also open numbering; no grant sees no rows", () => {
  const branch = screenAccess("/people/job-titles");
  for (const entry of branch.entries) entry.scope.kind = "WORKPLACE";
  expect(paths(branch)).toEqual(["/people/job-titles"]);
  for (const entry of branch.entries) entry.level = "edit";
  expect(paths(branch)).toEqual(["/people/job-titles"]);
  expect(paths(screenAccess("/people/numbering"))).toEqual(["/people/numbering", "/people/job-titles"]);
  expect(paths(screenAccess("/"))).toEqual([]);
});

test("the route guard opens the hub exactly when at least one served destination opens", () => {
  const need = router.routesByPath["/settings"].options.staticData!.access;
  expect(need).toEqual(settingsRequirement(routes));
  for (const access of [screenAccess("/"), ...SETTINGS_VIEWS.map(view => screenAccess(view.to)), { ...screenAccess("/"), is_ops: true }]) {
    expect(need !== "signed-in" && accessRefusal(access, need!) === null).toBe(paths(access).length > 0);
  }
  for (const is_ops of [false, true]) expect(accessRefusal({ ...screenAccess("/"), is_ops }, settingsRequirement([]))).toBe("access_denied");
});

test("changing a destination's requirement changes both visibility and the hub guard", () => {
  const original = routes.find(route => route.fullPath === "/people/job-titles")!;
  const changed = routes.map(route => route === original ? { options: { path: original.fullPath, staticData: { access: { domain: "org", level: "view" } } as StaticDataRouteOption } } : route);
  const branch = screenAccess("/people/job-titles");
  expect(settingsViews(changed, branch)).toEqual([]);
  expect(accessRefusal(branch, settingsRequirement(changed))).toBe("access_denied");
});

test("prepared, revoked and explicitly refused view rows cannot open the hub", () => {
  const access = screenAccess("/people/job-titles");
  for (const enforcement of ["PREPARED", "REVOKED", "SCOPE_UNAVAILABLE"] as const) {
    const refused = { ...access, entries: access.entries.map(entry => ({ ...entry, enforcement })) };
    expect(paths(refused)).toEqual([]);
    expect(accessRefusal(refused, settingsRequirement(routes))).toBe("access_denied");
  }
});
