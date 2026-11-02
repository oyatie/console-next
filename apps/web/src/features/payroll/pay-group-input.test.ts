// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { payGroupInput, type PayGroupDraft } from "./domain/pay-group-input";
import { payGroups } from "../../../../../e2e/mock/payroll";

const { id: _id, ...group } = payGroups.items[0]!;
const complete: PayGroupDraft = { ...group, sensitive: false, pay_basis_allowed: ["MONTHLY"] };
test("no consequential rule is inferred from an incomplete draft", () => {
  expect(payGroupInput({ pay_date_rule: {}, base_period: {}, variable_period: {} })).toBeNull();
  for (const field of ["legal_entity_id", "name", "sensitive", "proration", "channel", "pay_basis_allowed"] as const)
    expect(payGroupInput({ ...complete, [field]: undefined })).toBeNull();
  for (const field of ["pay_date_rule", "base_period", "variable_period"] as const)
    for (const key of Object.keys(complete[field]))
      expect(payGroupInput({ ...complete, [field]: { ...complete[field], [key]: undefined } })).toBeNull();
  expect(payGroupInput({ ...complete, name: "   " })).toBeNull();
  expect(payGroupInput({ ...complete, pay_basis_allowed: [] })).toBeNull();
});
test("false, zero, FIRST and LAST_DAY remain explicit choices", () => {
  const input = { ...complete, name: "  모의 급여  ", pay_date_rule: { day: "LAST_DAY" as const, month_offset: 0 as const, non_business_day: "NEXT" as const }, base_period: { start_day: "FIRST" as const, month_offset: 0 as const } };
  expect(payGroupInput(input)).toEqual({ ...input, name: "모의 급여" });
});
