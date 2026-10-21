import { History } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { EMPLOYEE_STATUS, EMPLOYMENT_TYPE, PROBATION_STATE, label, labeled } from "../../../lib/labels";
import { Button } from "../../../ui/button/button";
import { FieldMark, FieldRow } from "../../../ui/record/field-row";
import { RecordSection, Tag } from "../../../ui/record/record-section";
import { todayKst } from "../../../lib/pure/today";
import type { LifecycleEvent } from "../api";
import { daysBetween } from "../domain/roster";
import { EmploymentPlacement } from "./employment-placement";
import { EmploymentRecord } from "./employment-record";
import { HomeBranchCard } from "./home-branch-card";
import type { Card } from "./use-card";
import { MissingEmployment } from "./missing-employment";
import s from "./card.module.css";
import { Muted } from "../../../ui/muted/muted";

/** The latest applied event of `type`: a fact's "since" line. */
const since = (items: readonly LifecycleEvent[], type: LifecycleEvent["event_type"]) =>
  items.filter((x) => x.event_type === type && x.state === "APPLIED").sort((a, b) => b.effective_date.localeCompare(a.effective_date))[0];

/**
 * 2 employment and placement (E2): employment status (a result of acts, locked), company, workplace, department (changed only by a personnel action), grade, position, duty title ·
 * job, job family, employment type (edit: change or correction), hire date and group start date (correction only, two people; first value free), probation, concurrent post.
 */
export function SecJob({ c, onFix, onAct, onTab, onContract }: { c: Card; onFix: (field: string) => void; onAct: (act: string) => void; onTab: () => void; onContract?: () => void }) {
  const { e, d } = c;
  const items = c.events.data?.items ?? [];
  const { title, planned: p } = c;
  // The field a reservation changes carries it: "foreman from 11-01" (MM-DD: the year is the head's).
  const plan = (to: string | undefined) => to && p && <> <Tag kind="plan">{t("empCard.planned.to", { date: p.effective_date.slice(5), to })}</Tag></>;
  const appointed = since(items, "APPOINT");
  const k = d.classification;
  const status = labeled(EMPLOYEE_STATUS, e.status ?? "UNKNOWN");
  const moved = since(items, "TRANSFER");
  const promoted = since(items, "PROMOTE");
  const probation = c.facts.data?.employment;
  const group = c.personal.data?.group_service_start_date;
  const end = d.employment?.contract_end_date;
  const left = end ? daysBetween(todayKst(), end) : 0;
  // A reader without the grant does not read the job facts: say so rather than show them as empty.
  const none = <Muted>{t(c.manage ? "empCard.none" : "people.field.restricted")}</Muted>;
  const rc = (field: string, key: string) => c.manage && <FieldMark kind="rc" field={field} onPress={() => onFix(key)} />;
  const verb = (field: string, text: string, act: string) => c.manage && <FieldMark kind="verb" field={field} text={text} onPress={() => onAct(act)} />;
  const count = items.filter((x) => x.state !== "CANCELLED").length;
  return (
    <RecordSection id="s2" no={2} title={t("empCard.sec.job")} two tools={<Button variant="ghost" onClick={onTab}><History size={14} aria-hidden /> {t("empCard.job.events", { count })}</Button>}>
      {c.manage && !d.employment && !d.pending_employment && <MissingEmployment number={e.employee_number} />}
      <FieldRow label={t("empCard.f.status")}  mark={<FieldMark kind="lock" field={t("empCard.f.status")} />}>
        {status.label}
        {/* Since when this status holds: the exit date once the person has left, else the hire date. */}
        {(e.status === "EXITED" ? e.exit_date : e.hire_date) && <Muted> · {t("empCard.status.since", { date: fmtDate((e.status === "EXITED" ? e.exit_date : e.hire_date)!) })}</Muted>}
      </FieldRow>
      <FieldRow label={t("empCard.f.entity")} mark={verb(t("empCard.f.entity"), t("empCard.verb.group"), "GROUP_TRANSFER")}>{c.place.entity}</FieldRow>
      <FieldRow label={t("empCard.f.workplace")}  mark={verb(t("empCard.f.workplace"), t("empCard.verb.site"), "TRANSFER")}>
        {c.place.workplace ?? none}
      </FieldRow>
      <FieldRow label={t("empCard.f.unit")} sub={moved && t("empCard.unit.since", { date: fmtDate(moved.effective_date), from: moved.from_org_unit ?? "—" })} mark={verb(t("empCard.f.unit"), t("empCard.verb.unit"), "TRANSFER")}>
        {c.place.path.join(" › ") || e.org_unit || t("empCard.unplaced")}
      </FieldRow>
      {/* The employer and workplace by date (the assignments split on each change's effective date, so a unit's move carries the person). */}
      <FieldRow wide label={t("empCard.f.placements")}>
        <dl className={s.placements}><EmploymentPlacement employeeId={e.id} /></dl>
      </FieldRow>
      <FieldRow id="f-grade" label={t("empCard.f.grade")} sub={!c.manage || promoted ? t(c.manage ? "empCard.grade.since" : "empFix.catalog.scope", { date: promoted ? fmtDate(promoted.effective_date) : "" }) : undefined} mark={rc(t("empCard.f.grade"), "grade")}>
        {title(k.grade_id) ?? none}
        {p?.event_type === "PROMOTE" && plan(title(p.to_grade_id))}
      </FieldRow>
      <FieldRow id="f-position" label={t("empCard.f.position")} mark={rc(t("empCard.f.position"), "position")}>{title(k.job_title_id) ?? e.position ?? none}</FieldRow>
      <FieldRow id="f-title" label={t("empCard.f.title")} sub={appointed && k.position_kind_id && t("empCard.since", { date: fmtDate(appointed.effective_date) })} mark={rc(t("empCard.f.title"), "title")}>
        {title(k.position_kind_id) ?? none}
        {p?.event_type === "APPOINT" && plan(title(p.to_position_kind_id))}
      </FieldRow>
      <FieldRow id="f-job" no="6" label={t("empCard.f.job")} mark={rc(t("empCard.f.job"), "job")}>{title(k.job_id) ?? e.job ?? <span className={s.warn}>{t("empCard.missing")}</span>}</FieldRow>
      <FieldRow id="f-family" label={t("empCard.f.family")} mark={rc(t("empCard.f.family"), "family")}>{title(k.job_family_id) ?? none}</FieldRow>
      <FieldRow id="f-employment_type" no="7" label={t("empCard.f.type")} mark={rc(t("empCard.f.type"), "employment_type")}>{d.employment?.employment_type ? label(EMPLOYMENT_TYPE, d.employment.employment_type) : <span className={s.warn}>{t("empCard.type.missing")}</span>}</FieldRow>
      {end && (
        <FieldRow id="f-contract_end" no="7" label={t("empCard.f.contractEnd")} mark={verb(t("empCard.f.contractEnd"), t("empCard.verb.renew"), "CONTRACT_RENEWAL")}>
          <span className={s.num}>{fmtDate(end)}</span> <span className={left < 0 ? s.warn : s.steel}>{left < 0 ? t("empCard.contractEnd.past") : t("empCard.contractEnd.left", { days: left })}</span>
        </FieldRow>
      )}
      <FieldRow id="f-hire_date" no="7" label={t("empCard.f.hire")}  mark={c.manage && <FieldMark kind="corTwo" field={t("empCard.f.hire")} onPress={() => onFix("hire_date")} />}>
        <span className={s.num}>{e.hire_date ? fmtDate(e.hire_date) : t("empCard.missing")}</span>
      </FieldRow>
      <FieldRow
        label={t("empCard.f.group")}

        mark={c.manage && <FieldMark kind={group ? "corTwo" : "first"} field={t("empCard.f.group")} onPress={() => onFix("group_service_start_date")} />}
      >
        {group ? <span className={s.num}>{fmtDate(group)}</span> : <Muted>{t("empCard.group.empty")}</Muted>}
      </FieldRow>
      <FieldRow id="f-probation_end_date" label={t("empCard.f.probation")} mark={c.manage && <FieldMark kind="cor" field={t("empCard.f.probation")} onPress={() => onFix("probation_end_date")} />}>
        {probation?.probation_end_date ? <>{t("empCard.probation.until", { date: fmtDate(probation.probation_end_date) })} · {label(PROBATION_STATE, probation.probation_state)}</> : none}
      </FieldRow>
      <FieldRow label={t("empCard.f.workForm")} ><Muted>{t("empCard.workForm.unserved")}</Muted></FieldRow>
      <FieldRow wide label={t("empCard.f.concurrent")}  mark={<FieldMark kind="lock" field={t("empCard.f.concurrent")} text={t("empCard.concurrent.lock")} />}>
        <Muted>{t("empCard.none")}</Muted>
      </FieldRow>
      <div className={s.rail}>
        <HomeBranchCard e={e} manage={c.manage} />
        {c.manage && <EmploymentRecord e={e} onContract={onContract} />}
      </div>
    </RecordSection>
  );
}
