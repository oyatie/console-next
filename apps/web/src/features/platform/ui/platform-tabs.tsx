// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { TabNav } from "../../../ui/tabs/tabs";
import { tabClass } from "../../../ui/tabs/tab-class";
import s from "./platform-console.module.css";

export type PlatformTab = "tenants" | "groups" | "operators" | "support";
const PLATFORM_TABS: readonly PlatformTab[] = ["tenants", "groups", "operators", "support"];

export function PlatformTabs({
  tab,
  onSelect,
}: {
  tab: PlatformTab;
  onSelect: (next: PlatformTab) => void;
}) {
  return (
    <div className={s.tabsBar}>
      <TabNav label={t("tenants.tabs")} overflow="scroll">
        {PLATFORM_TABS.map((id) => (
          <Link
            key={id}
            to="/platform"
            className={tabClass}
            aria-current={tab === id ? "page" : undefined}
            onClick={(e) => {
              e.preventDefault();
              onSelect(id);
            }}
          >
            {t(`tenants.tab.${id}`)}
          </Link>
        ))}
      </TabNav>
    </div>
  );
}
