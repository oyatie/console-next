// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/schema";
type CreatePayGroup = components["schemas"]["CreatePayGroup"];
export type PayGroupDraft = Partial<Omit<CreatePayGroup, "pay_date_rule" | "base_period" | "variable_period">> & {
  pay_date_rule: Partial<CreatePayGroup["pay_date_rule"]>;
  base_period: Partial<CreatePayGroup["base_period"]>;
  variable_period: Partial<CreatePayGroup["variable_period"]>;
};

/** Unchosen facts stay absent, including booleans and month offsets. */
export function payGroupInput(draft: PayGroupDraft): CreatePayGroup | null {
  const { legal_entity_id, name, pay_date_rule: pay, base_period: base, variable_period: variable, proration, channel, sensitive, pay_basis_allowed } = draft;
  if (!legal_entity_id || !name?.trim() || !proration || !channel || sensitive === undefined || !pay_basis_allowed?.length
    || pay.day === undefined || pay.month_offset === undefined || pay.non_business_day === undefined
    || base.start_day === undefined || base.month_offset === undefined
    || variable.start_day === undefined || variable.month_offset === undefined) return null;
  return { legal_entity_id, name: name.trim(), proration, channel, sensitive, pay_basis_allowed,
    pay_date_rule: { day: pay.day, month_offset: pay.month_offset, non_business_day: pay.non_business_day },
    base_period: { start_day: base.start_day, month_offset: base.month_offset },
    variable_period: { start_day: variable.start_day, month_offset: variable.month_offset },
  };
}
