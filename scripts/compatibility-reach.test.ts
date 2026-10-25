// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { operationGaps } from "./check-reach.mjs";

test("deprecated compatibility operations need no new product control; live operations still do", () => {
  const spec = { paths: { "/api/v1/employees/{id}/home-branch": { put: { deprecated: true } }, "/api/v1/employees/{id}/placement": { put: {} } } };
  expect(operationGaps({ spec, files: [] })).toEqual(["PUT /api/v1/employees/{id}/placement"]);
});
