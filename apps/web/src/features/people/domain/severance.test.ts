// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import type { components } from "@console/api/schema";
import { ineligibleSeverance, settlementOutcome } from "./severance";

type Package = components["schemas"]["EmployeeExitSettlementPackage"];
const pkg = (decision: unknown): Package => ({
  id: "package", status: "READY_FOR_APPROVAL", missing_source_fields: [],
  insurance_loss_payload: {}, approval_payload: {}, certification_status: "UNCERTIFIED_DRAFT",
  generated_at: "2026-10-21T00:00:00Z", statutory_basis: { severance_eligibility: decision },
});
const valid = { outcome: "NOT_ELIGIBLE", reason: "UNDER_SERVICE_YEARS", threshold: { num: 1, den: 1 } };

test.each([
  undefined, null, {}, [], "NOT_ELIGIBLE", { ...valid, outcome: "OPEN" },
  { ...valid, reason: "FUTURE_REASON" }, { ...valid, threshold: null },
  ...[0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1, NaN, Infinity].flatMap(value => [
    { ...valid, threshold: { num: value, den: 1 } }, { ...valid, threshold: { num: 1, den: value } },
  ]),
])("malformed or undecided eligibility cannot remove wage requirements: %j", decision => {
  expect(ineligibleSeverance(pkg(decision))).toBeNull();
});

test.each(["UNDER_SERVICE_YEARS", "UNDER_WEEKLY_HOURS"])("%s retains the exact server threshold", reason => {
  expect(ineligibleSeverance(pkg({ ...valid, reason, threshold: { num: 29, den: 2 } })))
    .toEqual({ reason, threshold: { num: 29, den: 2 } });
});

test("only an absent decision uses legacy figure behavior", () => {
  expect(settlementOutcome(undefined)).toBeUndefined();
  expect(settlementOutcome({ statutory_basis: {} } as Package)).toBeUndefined();
  expect(settlementOutcome(pkg(null))).toBeNull();
  expect(settlementOutcome(pkg({}))).toBeNull();
  expect(settlementOutcome(pkg({ outcome: "OPEN" }))).toBe("OPEN");
});
