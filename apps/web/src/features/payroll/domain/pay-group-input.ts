// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/schema";
type CreatePayGroup = components["schemas"]["CreatePayGroup"];
type CutoffRule = NonNullable<CreatePayGroup["attendance_cutoff_rule"]>;
export type PayGroupDraft = Partial<Omit<CreatePayGroup, "pay_date_rule" | "base_period" | "variable_period" | "attendance_cutoff_rule">> & {
  pay_date_rule: Partial<CreatePayGroup["pay_date_rule"]>;
  base_period: Partial<CreatePayGroup["base_period"]>;
  variable_period: Partial<CreatePayGroup["variable_period"]>;
  attendance_cutoff_rule?: Partial<CutoffRule>;
};

/** Unchosen facts stay absent, including booleans, month offsets, and optional attendance cutoff rules. */
export function payGroupInput(draft: PayGroupDraft): CreatePayGroup | null {
  const { legal_entity_id, name, pay_date_rule: pay, base_period: base, variable_period: variable, attendance_cutoff_rule: cutoff, member_employee_ids, proration, channel, sensitive, pay_basis_allowed } = draft;
  if (!legal_entity_id || !name?.trim() || !proration || !channel || sensitive === undefined || !pay_basis_allowed?.length
    || pay.day === undefined || pay.month_offset === undefined || pay.non_business_day === undefined
    || base.start_day === undefined || base.month_offset === undefined
    || variable.start_day === undefined || variable.month_offset === undefined) return null;
  const hasCutoff = cutoff && cutoff.day !== undefined && cutoff.month_offset !== undefined;
  return {
    legal_entity_id,
    name: name.trim(),
    proration,
    channel,
    sensitive,
    pay_basis_allowed,
    pay_date_rule: { day: pay.day, month_offset: pay.month_offset, non_business_day: pay.non_business_day },
    base_period: { start_day: base.start_day, month_offset: base.month_offset },
    variable_period: { start_day: variable.start_day, month_offset: variable.month_offset },
    ...(hasCutoff ? { attendance_cutoff_rule: { day: cutoff.day!, month_offset: cutoff.month_offset! } } : {}),
    ...(member_employee_ids && member_employee_ids.length > 0 ? { member_employee_ids } : {}),
  };
}

export function isPayGroupDirty(draft: PayGroupDraft): boolean {
  return Boolean(
    draft.legal_entity_id ||
      draft.name?.trim() ||
      draft.proration ||
      draft.channel ||
      draft.sensitive !== undefined ||
      draft.pay_basis_allowed?.length ||
      draft.pay_date_rule.day !== undefined ||
      draft.pay_date_rule.month_offset !== undefined ||
      draft.pay_date_rule.non_business_day !== undefined ||
      draft.base_period.start_day !== undefined ||
      draft.base_period.month_offset !== undefined ||
      draft.variable_period.start_day !== undefined ||
      draft.variable_period.month_offset !== undefined ||
      draft.attendance_cutoff_rule?.day !== undefined ||
      draft.attendance_cutoff_rule?.month_offset !== undefined,
  );
}
