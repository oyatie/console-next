// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { checkEvidence } from "../scripts/check-evidence.mjs";

test("execution evidence refuses an aggregate green hiding an incomplete attempt", () => {
  const now = new Date();
  const policy = { version: 1, maxAgeHours: 1, entries: [] };
  const incomplete = { suites: [], errors: [], stats: { startTime: now.toISOString(), duration: 1, expected: 1, unexpected: 0, flaky: 0, skipped: 0 } };
  expect(checkEvidence(incomplete, policy, now)).not.toEqual([]);
});
