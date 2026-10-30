import { LEAVE_TYPE } from "../../../lib/labels";
import { EnumCode } from "../../../ui/enum-value";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import type { ImportRow } from "../domain/contract";
import { employmentTypeLabel, fieldLabel, leaveTypeLabel, outcomeLabel, refusalLabel, routeLabel, shown } from "../present";
import s from "./import.module.css";

/**
 * One row's plan in full: why it is refused, what an update changes field by field, what an import never changes for
 * a person on file and which flow does it instead, the leave a new person comes in on, and names that placed nobody.
 */
export function RowDetail({ r }: { r: ImportRow }) {
  const value = (field: string, v?: string | null) => (field === "employment_type" && v ? employmentTypeLabel(v) : shown(v));
  const leave = r.new_person?.leave;
  return (
    <section className={s.detail} aria-label={t("import.rows.detail", { sheet: r.sheet, row: r.row, name: r.name })}>
      <h3 className="toolbar__title">{t("import.rows.detail", { sheet: r.sheet, row: r.row, name: r.name })} · {outcomeLabel(r.outcome)}</h3>
      {r.outcome === "refused" && r.refusal_code && (
        <p className={s.issue}>{r.refusal_field ? t("import.rows.refused", { field: fieldLabel(r.refusal_field), why: refusalLabel(r.refusal_code) }) : refusalLabel(r.refusal_code)}</p>
      )}
      {(r.diff?.length ?? 0) > 0 && (
        <ul className={s.lines}>
          {r.diff!.map((c) => <li key={c.field}>{t("import.rows.change", { field: fieldLabel(c.field), before: value(c.field, c.from), after: value(c.field, c.to) })}</li>)}
        </ul>
      )}
      {(r.deferred?.length ?? 0) > 0 && (
        <ul className={s.lines}>
          {r.deferred!.map((h) => (
            <li key={h.field} className={s.held}>{t("import.rows.held", { field: fieldLabel(h.field), before: value(h.field, h.from), after: value(h.field, h.to), route: routeLabel(h.route) })}</li>
          ))}
        </ul>
      )}
      {leave && (
        <p>{t(leave.expected_return_date ? "import.rows.leave" : "import.rows.leaveOpen", { type: leaveTypeLabel(leave.leave_type), start: fmtDate(leave.start_date), end: fmtDate(leave.expected_return_date) })} <EnumCode e={LEAVE_TYPE} value={leave.leave_type} /></p>
      )}
      {r.new_person && r.new_person.employee_number == null && <p className={s.held}>{t("import.rows.unnumbered")}</p>}
      {r.unit_name && <p className={s.held}>{t("import.rows.unitName", { name: r.unit_name })}</p>}
      {r.workplace_name && <p className={s.held}>{t("import.rows.workplaceName", { name: r.workplace_name })}</p>}
      {r.outcome === "excluded" && r.exclusion_code && <p>{t("import.rows.excluded")}</p>}
    </section>
  );
}
