// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { LEAVE_TYPE, label } from "../../../lib/labels";
import type { ProtectedPeriod } from "../domain/exits";
import s from "./exit.module.css";

/** The server supplies each protected period and its statutory citation. */
export function ProtectedPeriods({ periods }: { periods: readonly ProtectedPeriod[] }) {
  if (periods.length === 0) return null;
  return (
    <div className={s.blocking} role="note" aria-label={t("exit.protection.title")}>
      <h3 className={s.groupTitle}>{t("exit.protection.title")}</h3>
      <ul className={s.lines}>
        {periods.map((p) => (
          <li key={p.lifecycle_event_id}>
            {label(LEAVE_TYPE, p.leave_type)} · {fmtDate(p.leave_from)}–{p.leave_until ? fmtDate(p.leave_until) : t("exit.protection.open")} · {p.protected_until ? t("exit.protection.until", { date: fmtDate(p.protected_until) }) : t("exit.protection.open")} · {[p.instrument, p.article].filter(Boolean).join(" ")}
          </li>
        ))}
      </ul>
    </div>
  );
}
