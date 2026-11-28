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
    "wizard",
    "settings",
    "canvas",
    "phone-hub",
    "phone-statement",
  ]) {
    expect(Object.keys(router.routesById), `the ${id} review route is registered`).toContain(`/app/_review/patterns/${id}`);
  }
  expect(Object.keys(router.routesById), "the sign-in review route is registered outside the app shell").toContain(
    "/_review/patterns/sign-in",
  );
  const declared = Object.fromEntries(routes.flatMap(route => route.options.staticData?.pattern ? [[route.fullPath, route.options.staticData.pattern]] : []));
  expect(declared).toEqual({
    "/login": "sign-in",
    "/setup-passkey": "sign-in",
    "/": "worklist",
    "/access/check": "form",
    "/access/policies": "list-record",
    "/access/policies/$draftId": "document-decision",
    "/inbox": "worklist",
    "/leave": "form",
    "/payslips": "phone-statement",
    "/people": "list-record",
    "/people/$id": "record",
    "/people/$id/identifiers": "record",
    "/people/bulk": "wizard",
    "/people/certificates": "list-record",
    "/people/certificates/$certificateId": "record",
    "/people/data-health": "list-record",
    "/people/exits": "list-record",
    "/people/exits/$id": "document-decision",
    "/people/grid": "wizard",
    "/people/import": "wizard",
    "/people/records/import": "wizard",
    "/people/job-titles": "settings",
    "/people/notices": "list-record",
    "/people/notices/$noticeId": "record",
    "/people/notices/new": "wizard",
    "/people/numbering": "settings",
    "/people/period-locks": "settings",
    "/people/renew": "wizard",
    "/people/requests": "list-record",
    "/people/roster-fields": "settings",
    "/people/run": "wizard",
    "/approvals": "worklist",
    "/approvals/new": "form",
    "/approvals/$approvalId": "document-decision",
    "/attendance": "month-grid",
    "/audit": "list-record",
    "/payroll": "list-record",
    "/payroll/setup": "wizard",
    "/payroll/runs/new": "wizard",
    "/payroll/runs/$id": "register-totals",
    "/payroll/reference": "list-record",
    "/payroll/employees/$employeeId": "record",
    "/statutory": "list-record",
    "/account": "phone-hub",
    "/account/location": "form",
    "/account/privacy": "settings",
    "/account/privacy/intake/$id": "record",
    "/me/attendance": "record",
    "/me/desk": "settings",
    "/me/dispatch-offers": "worklist",
    "/settings": "settings",
    "/settings/company-domain": "settings",
    "/settings/overtime": "settings",
    "/team": "list-record",
    "/org": "canvas",
    "/org/changes/$id": "document-decision",
    "/org/move": "wizard",
    "/org/paste": "wizard",
    "/org/import": "wizard",
    "/org/workplaces/edit": "form",
    "/org/entities/new": "wizard",
    "/org/entities/$id": "record",
    "/setup/go-live": "wizard",
    "/requests": "form",
    "/requests/$id": "record",
    "/_review/patterns/list-record": "list-record",
    "/_review/patterns/worklist": "worklist",
    "/_review/patterns/record": "record",
    "/_review/patterns/document-decision": "document-decision",
    "/_review/patterns/month-grid": "month-grid",
    "/_review/patterns/register-totals": "register-totals",
    "/_review/patterns/form": "form",
    "/_review/patterns/wizard": "wizard",
    "/_review/patterns/settings": "settings",
    "/_review/patterns/canvas": "canvas",
    "/_review/patterns/sign-in": "sign-in",
    "/_review/patterns/phone-hub": "phone-hub",
    "/_review/patterns/phone-statement": "phone-statement",
  });
});
