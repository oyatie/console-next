// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRouter } from "@tanstack/react-router";
import { expect, test } from "vitest";
import { routeTree } from "./tree";
import { operationAccess } from "../reference/authz/domain/operation-access";

for (const path of ["/payroll", "/payroll/reference"]) test(`${path} declares pay read access`, () => {
  const router = createRouter({ routeTree });
  const route = Object.values(router.routesById).find(candidate => candidate.fullPath === path);
  const pending = { domain: "pay", level: "view" };
  expect(route?.options.staticData?.access).toEqual(path === "/payroll"
    ? { allOf: [pending, operationAccess["GET /api/v1/payroll/runs"]] }
    : pending);
});
