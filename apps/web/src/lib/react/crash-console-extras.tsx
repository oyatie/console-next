// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { StatusPageLink } from "../../ui/live/status-page-link";
import s from "../../ui/live/degraded.module.css";

export function CrashConsoleExtras() {
  return (
    <div className={s.crashExtras}>
      <StatusPageLink size="sm" />
      <div className={s.crashNote}>{t("live.crashed.inputKept")}</div>
    </div>
  );
}
