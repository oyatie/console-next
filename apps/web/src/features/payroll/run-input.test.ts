// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { runInput } from "./present";
import { payGroups } from "../../../../../e2e/mock/payroll";

const draft = { pay_group_id: payGroups.items[0]!.id, source_label: " 모의 급여 ", period_start: "2026-10-01", period_end: "2026-10-31" };
test("explicit choices produce a run without inferred consequential facts", () => {
  expect(runInput(draft, payGroups.items)).toEqual({ ...draft, source_label: "모의 급여" });
  expect(runInput({ ...draft, period_end: draft.period_start }, payGroups.items)).not.toBeNull();
});
for (const field of ["pay_group_id", "source_label", "period_start", "period_end"] as const) test(`missing ${field} cannot create a run`, () => {
  expect(runInput({ ...draft, [field]: "" }, payGroups.items)).toBeNull();
});
test("a group outside the served choices is not accepted", () => {
  expect(runInput(draft, [])).toBeNull();
});
test("blank names and invalid or reversed periods are refused", () => {
  expect(runInput({ ...draft, source_label: "  " }, payGroups.items)).toBeNull();
  expect(runInput({ ...draft, period_start: "2026-02-30" }, payGroups.items)).toBeNull();
  expect(runInput({ ...draft, period_end: "2026-10-32" }, payGroups.items)).toBeNull();
  expect(runInput({ ...draft, period_end: "2026-09-30" }, payGroups.items)).toBeNull();
});
