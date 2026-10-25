// SPDX-License-Identifier: LicenseRef-Proprietary
import { EnumValue } from "../../../ui/enum-value";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { LEAVE_TYPE } from "../../../lib/labels";
import { ExternalLink } from "../../../ui/external-link";
import type { ProtectedPeriod } from "../domain/exits";
import s from "./exit.module.css";

/** The server supplies each protected period and its statutory citation. */
export function ProtectedPeriods({ periods, disclose = true }: { periods: readonly ProtectedPeriod[]; disclose?: boolean }) {
  if (periods.length === 0) return null;
  return (
    <div className={s.blocking} role="note" aria-label={t("exit.protection.title")}>
      <h3 className={s.groupTitle}>{t("exit.protection.title")}</h3>
      <ul className={s.lines}>
        {periods.map((p) => (
          <li key={p.lifecycle_event_id}>
            <EnumValue e={LEAVE_TYPE} value={p.leave_type} /> · {fmtDate(p.leave_from)}–{p.leave_until ? fmtDate(p.leave_until) : t("exit.protection.open")} · {p.protected_until ? t("exit.protection.until", { date: fmtDate(p.protected_until) }) : t("exit.protection.open")} · {[p.instrument, p.article].filter(Boolean).join(" ")}
            {p.rule?.release_disposition !== "RELEASED" && <> · {t("exit.legal.review")}</>}
            {p.rule && (disclose ? <details><summary>{t("exit.legal.reason")}</summary>
              {p.rule.source_url ? <ExternalLink href={p.rule.source_url}>{[p.rule.instrument, p.rule.article].filter(Boolean).join(" ")}</ExternalLink> : [p.rule.instrument, p.rule.article].filter(Boolean).join(" ")}
               · {p.rule.provenance}
            </details> : <div>{[p.rule.instrument, p.rule.article].filter(Boolean).join(" ")} · {p.rule.provenance}</div>)}
          </li>
        ))}
      </ul>
    </div>
  );
}
