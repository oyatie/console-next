// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { Chip } from "../../../ui/chip";
import { ExternalLink } from "../../../ui/external-link";
import s from "./exit.module.css";

/** The server's notice-pay disposition and the register rules behind it. */
export function NoticePayFact({ pay, disposition }: { pay: components["schemas"]["NoticePay"]; disposition?: components["schemas"]["EmployeeExitCase"]["notice_disposition"] }) {
  const exempt = disposition?.kind === "REGISTER_EXCEPTION";
  if (pay.owed === false) return null;
  return (
    <section className={s.figures} aria-label={t(exempt ? "exit.noticePay.exceptionApplied" : pay.owed ? "exit.noticePay.owed" : "exit.noticePay.unavailable")}>
      <h3 className={s.groupTitle}>{t(exempt ? "exit.noticePay.exceptionApplied" : pay.owed ? "exit.noticePay.owed" : "exit.noticePay.unavailable")}</h3>
      <p>{t("exit.noticePay.gap", { days: pay.notice_days ?? "—", required: pay.required_days ?? "—" })}</p>
      {exempt && <p>{disposition.ground_code} · {disposition.evidence_ref}</p>}
      {!exempt && (pay.amount_won != null ? (
        <p className="num">{t("exit.noticePay.amount", { amount: fmtNumber(pay.amount_won) })}</p>
      ) : (
        <p>{t("exit.noticePay.unavailable")} · {t(pay.unavailable_reason === "figures_withheld" ? "exit.noticePay.reason.figures_withheld" : pay.unavailable_reason === "ordinary_wage_missing" ? "exit.noticePay.reason.ordinary_wage_missing" : "exit.noticePay.reason.statutory_basis_unavailable")}</p>
      ))}
      <p>{[pay.rule.instrument, pay.rule.article].filter(Boolean).join(" ")}</p>
      {[pay.rule, pay.minimum_service_rule].some((rule) => rule.release_disposition === "HOLD" || rule.release_disposition === "UNKNOWN") && <Chip tone="warn">{t("exit.legal.review")}</Chip>}
      <details className={s.basis}>
        <summary>{t("exit.legal.reason")}</summary>
        {[pay.rule, pay.minimum_service_rule].map((rule) => (
          <div key={rule.code}>
            <p>{rule.source_url ? <ExternalLink href={rule.source_url}>{[rule.instrument, rule.article].filter(Boolean).join(" ") || t("exit.legal.review")}</ExternalLink> : [rule.instrument, rule.article].filter(Boolean).join(" ") || t("exit.legal.review")}</p>
          </div>
        ))}
      </details>
    </section>
  );
}
