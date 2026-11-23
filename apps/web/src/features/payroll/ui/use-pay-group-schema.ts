// SPDX-License-Identifier: LicenseRef-Proprietary
import { payGroupSchemas } from "../api";

export const rules = payGroupSchemas.PayGroupRules.properties;
export const payDate = rules.pay_date_rule.properties;
export const periodRuleSchema = payGroupSchemas.PayGroupPeriodRule.properties;
export const [payDay, lastDay] = payDate.day.oneOf;
export const [startDay, firstDay] = periodRuleSchema.start_day.oneOf;
export const payBases = payGroupSchemas.PayGroupPayBases.items.enum;
