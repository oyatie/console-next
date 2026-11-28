// SPDX-License-Identifier: LicenseRef-Proprietary
import { ApiError } from "@console/api";
import { t } from "@console/i18n";
import { Link } from "@tanstack/react-router";

export function membershipRemedy(error: unknown) {
  if (!(error instanceof ApiError) || error.code !== "pay_group_roster_ambiguous") return undefined;
  return <Link to="/payroll/setup/members">{t("payroll.members.title")}</Link>;
}
