// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { tabClass } from "../../../ui/tabs/tab-class";
import { useAuditDestinations } from "../../authz/ui/use-documents-served";
import { TabNav } from "../../../ui/tabs/tabs";

export function AuditTabs() {
  const { evidenceVault, findings, consents } = useAuditDestinations();
  return <TabNav label={t("audit.nav")} overflow="scroll">
    <Link to="/audit" className={tabClass}>{t("audit.nav.log")}</Link>
    <Link to="/audit/access-log" search={{}} className={tabClass}>{t("audit.nav.accessLog")}</Link>
    <Link to="/audit/support-access" search={{}} className={tabClass}>{t("audit.nav.supportAccess")}</Link>
    {evidenceVault && <Link to="/audit/evidence" className={tabClass}>{t("audit.vault.title")}</Link>}
    {findings && <Link to="/audit/findings" className={tabClass}>{t("audit.findings.title")}</Link>}
    {consents && <Link to="/audit/location-consents" className={tabClass}>{t("audit.consents.title")}</Link>}
  </TabNav>;
}
