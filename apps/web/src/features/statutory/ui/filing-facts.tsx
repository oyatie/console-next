import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { Chip } from "../../../ui/chip";
import { DateField } from "../../../ui/date/date-field";
import { Field, TextInput } from "../../../ui/field/field";
import { SelectField } from "../../../ui/select/select-field";
import { todayKst } from "../../../lib/pure/today";
import type { FilingFacts, FilingTask } from "../../../reference/statutory/api";
import { filingLabel } from "../present";

export function FilingFactsFields({ task, facts, onChange, editAll = false, error = false }: { task: FilingTask; facts: FilingFacts; onChange: (v: FilingFacts) => void; editAll?: boolean; error?: boolean }) {
  const types = new Set(task.basis?.exclusions.map((r) => r.type));
  const pension = Boolean(task.basis?.exclusions.some((r) => r.pension_exceptions));
  const daysException = Boolean(task.basis?.exclusions.some((r) => r.days_exception != null));
  const showMultipleJobs = types.has("INCOME") || pension;
  const showWorkDays = task.kind === "WORK_CONFIRMATION" || daysException;
  const missing = "missing" in task.applicability && Array.isArray(task.applicability.missing) ? task.applicability.missing : [];
  const mustOpen = task.applicability.status === "UNKNOWN" || missing.length > 0 || Boolean(error);
  const update = (key: keyof FilingFacts, value: FilingFacts[keyof FilingFacts]) => onChange({ ...facts, [key]: value });
  const number = (key: "monthly_hours" | "weekly_hours" | "continuous_months" | "work_days" | "worked_monthly_hours" | "monthly_income_won") => <Field key={key} label={filingLabel(key)} required={false}>{(p) => <TextInput {...p} type="number" min={0} step={1} value={facts[key] ?? ""} onChange={(e) => update(key, e.target.value === "" ? null : Number(e.target.value))} />}</Field>;
  const choice = (key: "daily" | "foreign" | "director_without_worker_status" | "pension_opt_in" | "pension_lecturer_covered" | "minor_opt_out" | "multiple_jobs_covered" | "income_exception_covered") => <SelectField key={key} label={filingLabel(key)} required={false} placeholder={t("statutory.pickFact")}
    value={facts[key] == null ? null : String(facts[key])} onChange={(v) => update(key, v === "true")} options={[{ id: "true", label: t("statutory.yes") }, { id: "false", label: t("statutory.no") }]} />;
  return <section className="form" aria-label={t("statutory.facts")}>
    {task.applicability.status === "UNKNOWN" && <div><Chip tone="warn">{t("statutory.factsMissing")}</Chip><ul>{task.applicability.missing.map((field)=><li key={field}>{field === "birth_date" && !task.can_record_sensitive_facts ? <>{t("statutory.birthDateRestricted")} <Link to="/people/$id" params={{id: task.employee_id}}>{t("statutory.openPeople")}</Link></> : filingLabel(field)}</li>)}</ul></div>}
    {(types.has("AGE_LIMIT") || types.has("MINOR_OPT_OUT")) && !task.birth_date_known && task.can_record_sensitive_facts && <DateField label={t("statutory.birth_date")} required value={facts.birth_date ?? ""} onChange={(d) => update("birth_date", d)} today={todayKst()} max={todayKst()} />}
    {types.has("SHORT_HOURS") && <>{number("monthly_hours")}{task.basis?.exclusions.some((r) => "weekly" in r && r.weekly != null) && number("weekly_hours")}</>}
    {(types.has("DAILY") || task.basis?.daily_required || types.has("INCOME") || editAll) && <>{(editAll || task.applicability_facts.daily == null) && choice("daily")}{number("continuous_months")}</>}
    {types.has("EXECUTIVE_NOT_WORKER") && (editAll || task.applicability_facts.director_without_worker_status == null) && choice("director_without_worker_status")}
    {(types.has("FOREIGN_TREATY") || types.has("FOREIGN_VISA")) && (editAll || task.applicability_facts.foreign == null) && choice("foreign")}
    {types.has("INCOME") && task.can_record_sensitive_facts && number("monthly_income_won")}
    {showWorkDays && task.kind === "WORK_CONFIRMATION" && number("work_days")}
    <details open={mustOpen}><summary>{t("statutory.additionalFacts")}</summary><div className="form">
      {showMultipleJobs && choice("multiple_jobs_covered")}
      {types.has("MINOR_OPT_OUT") && choice("minor_opt_out")}
      {pension && <>{choice("pension_opt_in")}{choice("pension_lecturer_covered")}{choice("income_exception_covered")}</>}
      {showWorkDays && task.kind !== "WORK_CONFIRMATION" && number("work_days")}
      {task.basis?.exclusions.some((r)=>r.hours_exception != null) && <>{number("worked_monthly_hours")}<SelectField label={t("statutory.pension_daily_sector")} required={false} placeholder={t("statutory.pickFact")} value={facts.pension_daily_sector ?? null} options={["GENERAL","CONSTRUCTION_NOTICE","UNVERIFIED"].map((id)=>({id,label:filingLabel(id)}))} onChange={(v)=>update("pension_daily_sector",v as FilingFacts["pension_daily_sector"])} /></>}
      {types.has("FOREIGN_TREATY") && <SelectField label={t("statutory.treaty")} required={false} placeholder={t("statutory.pickFact")} value={facts.treaty ?? null}
        options={["COVERED", "EXCLUDED", "UNVERIFIED"].map((id) => ({ id, label: filingLabel(id) }))} onChange={(v) => update("treaty", v as FilingFacts["treaty"])} />}
      {types.has("FOREIGN_VISA") && <SelectField label={t("statutory.visa")} required={false} placeholder={t("statutory.pickFact")} value={facts.visa ?? null}
        options={["MANDATORY", "OPTED_IN", "OPTIONAL_NOT_OPTED_IN", "EXCLUDED", "UNVERIFIED"].map((id) => ({ id, label: filingLabel(id) }))} onChange={(v) => update("visa", v as FilingFacts["visa"])} />}
    </div></details>
  </section>;
}
