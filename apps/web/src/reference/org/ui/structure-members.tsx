import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { t } from "@console/i18n";
import { get } from "../../../lib/query";
import { useFreshOnArrival } from "../../../lib/react/arrival";
import { useCan } from "../../authz/ui/use-can";
import css from "./structure.module.css";
import { Muted } from "../../../ui/muted/muted";

const SHOWN = 8;

/**
 * The people placed directly at a unit (a department, or a workplace's own unit), first `SHOWN` (`expected`, from the
 * structure, holds their rows while they load); the full, paged list is the
 * People list filtered to the unit, linked with everyone below counted.
 */
export function Members({ unitId, total, expected }: { unitId?: string; total: number; expected: number }) {
  const can = useCan();
  const read = { ...get("/api/v1/org-units/{id}", { params: { path: { id: unitId ?? "" } } }), enabled: Boolean(unitId) };
  // A list a command changed since it was cached (someone registered here) holds its rows until re-read, so a row
  // landing late never pushes the list under the pointer.
  const q = useFreshOnArrival(useQuery(read), read);
  const directory = can("employee_directory_read", "all");
  const items = q.data?.members.items ?? [];
  // The count is known from the structure before the names arrive: their rows are held, so nothing below moves.
  const held = q.isPending && unitId ? Math.min(expected, SHOWN) : 0;
  return (
    <>
      {held > 0 ? (
        <ul className={css.list} aria-busy="true">
          {Array.from({ length: held }, (_, i) => <li key={i}><span className={css.av} aria-hidden /></li>)}
        </ul>
      ) : items.length === 0 ? (
        <p className={css.note}>{t("orgStructure.members.none")}</p>
      ) : (
        <ul className={css.list}>
          {items.slice(0, SHOWN).map((m) => (
            <li key={m.employeeId}>
              <span className={css.av} aria-hidden>{m.name.slice(0, 1)}</span>
              {directory ? <Link to="/people/$id" params={{ id: m.employeeId }}>{m.name}</Link> : <b>{m.name}</b>}
              <Muted>{m.position ?? ""}</Muted>
              <span className={css.right}>{m.employeeNumber ?? ""}</span>
            </li>
          ))}
        </ul>
      )}
      {directory && unitId && total > 0 && (
        <Link to="/people" search={{ unit: unitId }} className="row">
          {t("orgStructure.members.all", { count: total })}
          <ChevronRight size={14} aria-hidden />
        </Link>
      )}
    </>
  );
}
