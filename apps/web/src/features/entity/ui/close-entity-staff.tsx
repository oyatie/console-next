import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate, fmtNumber } from "@console/i18n/format";
import { entityEndQuery } from "../../../reference/close/api";
import { buttonClass } from "../../../ui/button/button-class";
import css from "../../../reference/org/ui/structure.module.css";
import { Muted } from "../../../ui/muted/muted";

/** How many names the blocker lists before the "and n more" line (2,000 people never draw 2,000 rows here, #28). */
const SHOWN = 12;

/**
 * Who still keeps the entity open (UX-R3 company-01/14): each person still employed there, linked to their record, with what
 * remains for them — their open exit (linked) or none yet. The list is the employees read, which the employee and exit
 * events re-read (#27), so a person whose exit takes effect leaves it without a reload, and the blocker goes with the last one.
 */
export function CloseEntityStaff({ entityId, people }: { entityId: string; people: readonly { id: string; name: string }[] }) {
  const cases = useQuery(entityEndQuery(entityId)).data?.open_exit_cases ?? [];
  const caseOf = new Map(cases.map((c) => [c.employee_id, c]));
  const rest = people.length - SHOWN;
  return (
    <ul className={css.list} aria-label={t("entityRecordClose.staff")}>
      {people.slice(0, SHOWN).map((p) => {
        const c = caseOf.get(p.id);
        return (
          <li key={p.id} className="row">
            <Link to="/people/$id" params={{ id: p.id }} className={buttonClass("ghost", { size: "sm" })}>{p.name}</Link>
            {c ? (
              <Link to="/people/exits/$id" params={{ id: c.case_id }} className="muted">{t("entityRecordClose.staff.open", { date: fmtDate(c.effective_exit_date) })}</Link>
            ) : (
              <Muted>{t("entityRecordClose.staff.none")}</Muted>
            )}
          </li>
        );
      })}
      {rest > 0 && <li className="muted">{t("entityRecordClose.staff.more", { count: fmtNumber(rest) })}</li>}
    </ul>
  );
}
