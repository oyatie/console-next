// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { t } from "@console/i18n";
import { myAccessQuery } from "../../../reference/authz/api";
import { settingsViews, type SettingsView } from "../../../shell/settings-views";
import { Page } from "../../../ui/page/page";
import { Card } from "../../../ui/card/card";
import s from "./settings-hub.module.css";

export function SettingsHub() {
  const access = useQuery(myAccessQuery);
  const router = useRouter();
  const rows = settingsViews(Object.values(router.routesByPath), access.data);
  return <SettingsHubView rows={rows} />;
}

export function SettingsHubView({ rows }: { rows: readonly SettingsView[] }) {
  return <Page floorplan="settings" head={{ title: t("shell.link.settings") }}>
    <Card title={t("shell.settings.basics")} flush>
      <nav aria-label={t("shell.settings.basics")}>
        <ul className={s.rows}>
          {rows.map(row => <li key={row.to}>
            <Link to={row.to} className={s.link}>
              {t(row.label)}<ChevronRight aria-hidden size={16} />
            </Link>
          </li>)}
        </ul>
      </nav>
    </Card>
  </Page>;
}
