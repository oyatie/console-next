// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import s from "./top-bar.module.css";

export function TenantHead({ tenant }: { tenant: components["schemas"]["UserTenant"] }) {
  return (
    <div className={s.tenant}>
      <span className={s.name} title={tenant.name}>{tenant.name}</span>
      {tenant.phase === "SETUP" && <Link to="/" className={s.phase}>{t("shell.phase.setup")}</Link>}
    </div>
  );
}
