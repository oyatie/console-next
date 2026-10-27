// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRouter } from "@tanstack/react-router";
import { expect, test } from "vitest";
import { routeTree } from "./tree";

test("settings is a served app route with its own access requirement", () => {
  const router = createRouter({ routeTree });
  const route = router.routesByPath["/settings" as keyof typeof router.routesByPath];
  expect(route, "/settings must replace the signed-in 404").toBeDefined();
  expect(route?.options.staticData?.access).toBeTypeOf("object");
});
