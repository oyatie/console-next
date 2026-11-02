// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRouter } from "@tanstack/react-router";
import { expect, test } from "vitest";
import { routeTree } from "./tree";
import { operationAccess } from "../reference/authz/domain/operation-access";

for (const path of ["/payroll", "/payroll/reference"]) test(`${path} declares pay read access`, () => {
  const router = createRouter({ routeTree });
  const route = Object.values(router.routesById).find(candidate => candidate.fullPath === path);
  const pending = { domain: "pay", level: "view" };
  const groups = operationAccess["GET /api/v1/payroll/pay-groups"];
  expect(route?.options.staticData?.access).toEqual(path === "/payroll"
    ? { allOf: [groups, operationAccess["GET /api/v1/payroll/runs"]] }
    : { allOf: [groups, pending] });
});

test("/payroll/setup declares its generated read and create requirements", () => {
  const router = createRouter({ routeTree });
  const route = Object.values(router.routesById).find(candidate => candidate.fullPath === "/payroll/setup");
  expect(route?.options.staticData?.access).toEqual({ allOf: [
    operationAccess["GET /api/v1/payroll/pay-groups"],
    operationAccess["POST /api/v1/payroll/pay-groups"],
  ] });
});

test("run creation declares pay-group read and tenant Cedar command access", () => {
  const router = createRouter({ routeTree });
  const route = Object.values(router.routesById).find(candidate => candidate.fullPath === "/payroll/runs/new");
  expect(route?.options.staticData?.access).toEqual({ allOf: [
    operationAccess["GET /api/v1/payroll/pay-groups"],
    { domain: "pay", level: "edit", tenant: true, scopes: ["TENANT"] },
  ] });
});
test("the run page declares its generated detail and group requirements", () => {
  const router = createRouter({ routeTree });
  const route = Object.values(router.routesById).find(candidate => candidate.fullPath === "/payroll/runs/$id");
  expect(route?.options.staticData?.access).toEqual({ allOf: [
    operationAccess["GET /api/v1/payroll/runs/{id}"],
    operationAccess["GET /api/v1/payroll/pay-groups"],
  ] });
});
