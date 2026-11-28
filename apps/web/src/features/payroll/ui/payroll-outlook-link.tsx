// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { useServedCapability } from "../../../reference/authz/ui/use-documents-served";
import { buttonClass } from "../../../ui/button/button-class";

export function PayrollOutlookLink() {
  return useServedCapability("analytics_projection")
    ? <Link to="/payroll/outlook" className={buttonClass("secondary", { size: "sm" })}>{t("payroll.outlook.title")}</Link>
    : null;
}
