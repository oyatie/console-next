// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { tabClass } from "../../../ui/tabs/tab-class";
import { TabNav } from "../../../ui/tabs/tabs";

export function AuditTabs() {
  return <TabNav label={t("audit.nav")} overflow="scroll">
    <Link to="/audit/support-access" search={{}} className={tabClass}>{t("audit.nav.supportAccess")}</Link>
  </TabNav>;
}
