// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRouter } from "@tanstack/react-router";
import { expect, test } from "vitest";
import { routeTree } from "./tree";

for (const path of ["/payroll", "/payroll/reference"]) test(`${path} declares pay read access`, () => {
  const router = createRouter({ routeTree });
  const route = Object.values(router.routesById).find(candidate => candidate.fullPath === path);
  expect(route?.options.staticData?.access).toEqual({ domain: "pay", level: "view" });
});
