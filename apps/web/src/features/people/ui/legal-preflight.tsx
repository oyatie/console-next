// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components, paths } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDayShort } from "../present";
import { ProtectedPeriods } from "./exit-protection";
import s from "./lifecycle.module.css";
import exit from "./exit.module.css";

type FixedTermData = paths["/api/v1/employees/{id}/fixed-term"]["get"]["responses"][200]["content"]["application/json"];

/** Statutory facts beside the field that caused the server's preflight result. */
export function ExitPreflight({ facts, involuntary }: { facts: components["schemas"]["ExitGuards"]; involuntary: boolean }) {
  return <>
    {involuntary && facts.protected_periods.length > 0 && <>
      <p className={exit.blocking} role="status">{t("exit.error.exit_protected_period")}</p>
      <ProtectedPeriods periods={facts.protected_periods} />
    </>}
    {facts.notice_required && <p className={exit.note} role="note">{t("exit.notice.title")}</p>}
  </>;
}

export function LeaveProtection({ rule, unavailable }: { rule?: components["schemas"]["LegalRule"]; unavailable: boolean }) {
  if (!rule && !unavailable) return null;
  return <div>
    {rule && <div className={s.fact} role="note">
      <p>{rule.value == null ? t("exit.legal.review") : t("exit.leave.protection", { days: rule.value })}{rule.value != null && rule.release_disposition !== "RELEASED" && <> · {t("exit.legal.review")}</>}</p>
      <details><summary>{t("exit.legal.reason")}</summary><p>{[rule.instrument, rule.article].filter(Boolean).join(" ")}</p></details>
    </div>}
    {unavailable && <p role="status">{t("exit.legal.review")}</p>}
  </div>;
}

export function FixedTermRule({ f, end = "", unavailable = false }: { f?: FixedTermData; end?: string; unavailable?: boolean }) {
  const over = Boolean(f?.two_year_date && end && end > f.two_year_date);
  return <>
    {(unavailable || (f?.applies && (!f.two_year_date || f.rule?.value == null))) && <p role="status">{t("exit.legal.review")}</p>}
    {f?.applies && f.cumulative_days != null && <div className={s.block} role="group" aria-label={t("lifecycle.fixedTerm.title")}>
      <p className={s.fact}>
        {t("lifecycle.fixedTerm.service", { days: f.cumulative_days })}
        {f.two_year_date && <> · {t("lifecycle.fixedTerm.limit", { date: fmtDayShort(f.two_year_date), years: f.rule?.value ?? "—" })}</>}
      </p>
      {f.rule && <details><summary>{t("exit.legal.reason")}</summary><p>{[f.rule.instrument, f.rule.article].filter(Boolean).join(" ")}</p><p>{f.rule.release_disposition !== "RELEASED" && t("exit.legal.review")}</p></details>}
      {f.basis === "HIRE_DATE_FALLBACK" && <p className={s.note}>{t("lifecycle.fixedTerm.fallback")}</p>}
      {over && <p className={s.warn} role="status">{t("lifecycle.fixedTerm.over", { date: fmtDayShort(f.two_year_date!), years: f.rule?.value ?? "—" })}</p>}
    </div>}
  </>;
}
