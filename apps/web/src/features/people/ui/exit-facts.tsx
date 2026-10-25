import { Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { reasonLabel } from "../../../lib/reason-codes";
import { fmtDate, fmtDateTime, fmtNumber } from "@console/i18n/format";
import { Chip } from "../../../ui/chip";
import { DerivedValue } from "../../../ui/field/derived-value";
import { actor } from "../../../lib/labels";
import { todayKst } from "../../../lib/pure/today";
import { daysBetween } from "../../../ui/date/days";
import { useCan } from "../../../reference/authz/ui/use-can";
import { employeeQuery, eventsQuery } from "../api";
import { byEffective, tenure } from "../domain/lifecycle";
import { describeEvent } from "../present";
import { KeyValue } from "../../../ui/key-value/key-value";
import { ExitDeadlines } from "./exit-deadlines";
import { useCaseActions } from "./use-case-actions";
import s from "./exit.module.css";
import { Muted } from "../../../ui/muted/muted";

type Case = components["schemas"]["EmployeeExitCase"];
type Package = components["schemas"]["EmployeeExitSettlementPackage"];

/** How far the exit date is from today, in the date field's words (D-30, today, 3 days ago). */
export function RelDay({ date }: { date: string }) {
  const days = daysBetween(todayKst(), date);
  return <Muted>{days === 0 ? t("uiDate.today") : days > 0 ? t("uiDate.ahead", { days }) : t("uiDate.ago", { days: -days })}</Muted>;
}

/**
 * What a decision on the case rests on: who reported it, why, and who confirmed it as HR (Home's exit queue
 * shows it in each row). `full` adds when it was reported and the exit date, for the HR confirmation.
 */
export function CaseFacts({ c, full = false }: { c: Case; full?: boolean }) {
  return (
    <dl className="kv">
      <dt>{t("exit.field.reporter")}</dt><dd>{actor(c.reported_by_name)}</dd>
      {full && <><dt>{t("exit.field.reportedAt")}</dt><dd className="num">{fmtDateTime(c.reported_at)}</dd></>}
      {full && <><dt>{t("exit.field.date")}</dt><dd className="num">{fmtDate(c.effective_exit_date)} <RelDay date={c.effective_exit_date} /></dd></>}
      {/* A report with its exit reason code (BE-EMP-UI) names it; the note is then the circumstances. */}
      {c.exit_reason_code && <><dt>{t("exit.field.reason")}</dt><dd>{reasonLabel("exit_reason", c.exit_reason_code)}</dd></>}
      <dt>{t(c.exit_reason_code ? "exit.field.circumstances" : "exit.field.note")}</dt><dd><p className={s.quote}>{c.site_manager_note}</p></dd>
      {c.hr_confirmed_at && <><dt>{t("exit.field.hrConfirmer")}</dt><dd>{actor(c.hr_confirmed_by_name)}</dd></>}
    </dl>
  );
}

/**
 * The case page's facts column: where the person sits, the exit date, the report, then (for a directory
 * reader) the person's hire date, service to the exit date and last three records, and the settlement's
 * computed figures once a package exists.
 */
export function CasePanel({ c }: { c: Case }) {
  const can = useCan();
  const reader = can("employee_directory_read", "all");
  const person = useQuery({ ...employeeQuery(c.employee_id), enabled: reader });
  const events = useQuery({ ...eventsQuery(c.employee_id), enabled: reader });
  const hired = person.data?.employee.hire_date;
  const recent = byEffective((events.data?.items ?? []).filter((x) => x.state === "APPLIED")).slice(0, 3);
  const served = hired ? tenure(hired, c.effective_exit_date) : null;
  const { forward } = useCaseActions(c);
  return (
    <div className={s.column}>
      <h2 className="panel__title">{t("exit.facts")}</h2>
      <dl className="kv">
        <dt>{t("people.field.unit")}</dt><dd>{c.org_unit ?? "—"}</dd>
        <dt>{t("people.field.homeBranch")}</dt><dd>{c.branch_name ?? "—"}</dd>
        <dt>{t("exit.field.date")}</dt><dd className="num">{fmtDate(c.effective_exit_date)} <RelDay date={c.effective_exit_date} /></dd>
        {/* Held (blank) while the employee record loads: the facts below must not drop two lines when it lands. */}
        {(hired || (reader && person.isPending)) && <><dt>{t("exit.facts.hired")}</dt><dd className="num">{hired ? fmtDate(hired) : "\u00a0"}</dd></>}
        {(served || (reader && person.isPending)) && <><dt>{t("exit.facts.tenure")}</dt><dd>{served ? t("exit.facts.tenure.value", served) : "\u00a0"}</dd></>}
      </dl>
      <CaseFacts c={c} />
      {c.dismissal_notice && <NoticeRecord notice={c.dismissal_notice} />}
      <ExitDeadlines deadlines={c.settlement_deadlines} employeeId={c.employee_id} exitCaseId={c.id} />
      {/* While this user prepares the settlement, the step's form shows the figures beside its inputs: once is enough. */}
      {c.settlement_package && forward !== "prepare_settlement" && <SettlementFigures pkg={c.settlement_package} />}
      {/* Last: the history loads after the case, and above the figures it pushed them down. */}
      {recent.length > 0 && (
        <>
          <h3 className={s.groupTitle}>{t("exit.facts.recent")}</h3>
          <ul className="list-plain">
            {recent.map((x) => <li key={x.id}><span className="num">{fmtDate(x.effective_date)}</span> · {describeEvent(x, c.employee_name).title}</li>)}
          </ul>
        </>
      )}
    </div>
  );
}

const won = (n?: number) => (n == null ? t("format.notComputable") : t("format.krw", { amount: n }));
const show = (v: unknown) => (v !== null && typeof v === "object" ? JSON.stringify(v) : String(v));

/**
 * The server's figures for the stored settlement package, each marked computed with its basis, and the
 * statutory basis it reported as plain key/value rows (keys as sent: no invented labels).
 */
export function SettlementFigures({ pkg }: { pkg: Package }) {
  const basis = t("exit.settlement.computed", { at: fmtDateTime(pkg.generated_at) });
  const rows = Object.entries(pkg.statutory_basis ?? {});
  return (
    <section className={s.figures} aria-label={t("exit.settlement.figures")}>
      <div className="row">
        <h3 className={`${s.groupTitle} grow`}>{t("exit.settlement.figures")}</h3>
        {pkg.certification_status === "UNCERTIFIED_DRAFT" && <Chip tone="warn">{t("exit.settlement.uncertified")}</Chip>}
      </div>
      <DerivedValue label={t("exit.settlement.serviceDays")} value={pkg.service_days == null ? t("format.notComputable") : t("exit.settlement.days", { days: pkg.service_days })} basis={basis} />
      <DerivedValue label={t("exit.settlement.averageDaily")} value={won(pkg.average_daily_wage_milliwon == null ? undefined : Math.round(pkg.average_daily_wage_milliwon / 1000))} basis={basis} />
      <DerivedValue label={t("exit.settlement.ordinaryDaily")} value={won(pkg.ordinary_daily_wage_won)} basis={basis} />
      <DerivedValue label={t("exit.settlement.severance")} value={won(pkg.severance_pay_won)} basis={basis} />
      {rows.length > 0 && (
        <details className={s.basis}>
          <summary>{t("exit.settlement.basis")}</summary>
          <dl className="kv">
            {rows.map(([k, v]) => <Fragment key={k}><dt className="code">{k}</dt><dd className="num">{typeof v === "number" ? fmtNumber(v) : show(v)}</dd></Fragment>)}
          </dl>
        </details>
      )}
    </section>
  );
}

function NoticeRecord({ notice }: { notice: NonNullable<Case["dismissal_notice"]> }) {
  return <section aria-label={t("exit.notice.title")}>
    <h3 className={s.groupTitle}>{t("exit.notice.title")}</h3>
    <KeyValue items={[
      { key: "reason_text", label: t("exit.notice.reason_text"), value: notice.reason_text },
      { key: "served_on", label: t("exit.notice.served_on"), value: fmtDate(notice.served_on) },
      { key: "method", label: t("exit.notice.method"), value: t(`exit.notice.method.${notice.method}`) },
      { key: "evidence_ref", label: t("exit.notice.evidence_ref"), value: notice.evidence_ref },
    ]} />
  </section>;
}
