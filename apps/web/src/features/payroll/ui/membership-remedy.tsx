// SPDX-License-Identifier: LicenseRef-Proprietary
import { codeOf } from "../../../reference/crud/present";
import { t } from "@console/i18n";
import { Link } from "@tanstack/react-router";

export function membershipRemedy(error: unknown) {
  if (codeOf(error) !== "pay_group_roster_ambiguous") return undefined;
  return <Link to="/payroll/setup/members">{t("payroll.members.title")}</Link>;
}
