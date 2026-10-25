// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { SETUP_READS } from "../api";
import { underPath } from "../../../lib/query";

test.each([
  "/api/v1/lifecycle-case-templates/{key}",
  "/api/v1/lifecycle-cases/{id}",
  "/api/v1/employees/{id}/lifecycle-cases",
  "/api/v1/statutory/insurance-filings",
  "/api/v1/me/action-inbox",
])("go-live invalidates fresh %s reads", (path) => {
  expect(SETUP_READS.some((prefix) => underPath(prefix)([path]))).toBe(true);
});
