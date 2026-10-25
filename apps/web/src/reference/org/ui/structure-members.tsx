import { queryView } from "../../../lib/react/query-view";
import { QueryState } from "../../../lib/react/query-state";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { t } from "@console/i18n";
import { get } from "../../../lib/query";
import { todayKst } from "../../../lib/pure/today";
import { useFreshOnArrival } from "../../../lib/react/arrival";
import { useCan } from "../../authz/ui/use-can";
import { Chip } from "../../../ui/chip";
import css from "./structure.module.css";
import { Muted } from "../../../ui/muted/muted";

const SHOWN = 8;

/**
 * The people placed directly at a unit (a department, or a workplace's own unit), first `SHOWN` (`expected`, from the
 * structure, holds their rows while they load); the full, paged list is the
 * People list filtered to the unit, linked with everyone below counted.
 */
export function Members({
  unitId,
  total,
  expected,
  joiners, as_of, known_at,
}: {
  unitId?: string;
  total: number;
  expected: number;
  joiners?: number;
  as_of?: string;
  known_at?: string;
}) {
  const can = useCan();
  const directory = can("employee_directory_read", "all");
  const historic = Boolean((as_of && as_of !== todayKst()) || known_at);
  const read = { ...get("/api/v1/org-structure/units/{orgUnitId}/members", { params: { path: { orgUnitId: unitId ?? "" }, query: { as_of, known_at } } }), enabled: Boolean(unitId) };
  // A list a command changed since it was cached (someone registered here) holds its rows until re-read, so a row
  // landing late never pushes the list under the pointer.
  const q = useFreshOnArrival(useQuery(read), read);
  const preHireRead = {
    ...get("/api/v1/employees", {
      // Matching the preview's (name, id) order covers every displayed joiner within SHOWN rows.
      params: { query: { org_unit_id: unitId ?? "", status: ["PRE_HIRE"], sort: "name", limit: SHOWN } },
    }),
    enabled: Boolean(unitId) && directory && !historic,
  };
  const preHireQ = useFreshOnArrival(useQuery(preHireRead), preHireRead);
  const items = q.data?.items ?? [];
  const preHire = !historic && directory && !preHireQ.isError ? preHireQ.data : undefined;
  const preHireIds = new Set((preHire?.items ?? []).map((m) => m.id));
  const preHireCount = historic ? undefined : joiners ?? preHire?.total;
  // The count is known from the structure before the names arrive: their rows are held, so nothing below moves.
  const held = queryView(q) === "loading" && unitId ? Math.min(expected, SHOWN) : 0;
  const empty = queryView(q) === "ready" && items.length === 0 && (!directory || queryView(preHireQ) === "ready");
  let joinerNote: string | undefined;
  if (unitId && !historic) {
    if (!directory && preHireCount === undefined) joinerNote = t("orgStructure.members.joinersRestricted");

  }
  if (!unitId) return null;
  if (["denied", "failed", "not-found"].includes(queryView(q)) || (queryView(q) === "offline" && q.data === undefined)) return <QueryState q={q}>{() => null}</QueryState>;
  return (
    <>
      <QueryState q={q} inline loading={null}>{() => null}</QueryState>
      {preHireCount !== undefined && preHireCount > 0 && (
        <div className={css.joinerRow}>
          <Chip tone="info">
            {t("enum.employeeStatus.PRE_HIRE")} {t("orgStructure.peopleCount", { count: preHireCount })}
          </Chip>
        </div>
      )}
      {(empty || joinerNote) && (
        <p className={css.note} role={joinerNote ? "status" : undefined}>
          {empty && t("orgStructure.members.none")}
          {empty && joinerNote && " · "}
          {joinerNote}
        </p>
      )}
      {directory && <QueryState q={{ ...preHireQ, data: preHire }} inline own={() => t("orgStructure.members.joinersFailed")} loading={<p className={css.note} role="status">{t("enum.employeeStatus.PRE_HIRE")} · {t("common.loading")}</p>}>{() => null}</QueryState>}
      {held > 0 ? (
        <ul className={css.list} aria-busy="true">
          {Array.from({ length: held }, (_, i) => <li key={i}><span className={css.av} aria-hidden /></li>)}
        </ul>
      ) : items.length > 0 && (
        <ul className={css.list}>
          {items.slice(0, SHOWN).map((m) => {
            const isPreHire = preHireIds.has(m.employeeId);
            return (
              <li key={m.employeeId}>
                <span className={css.av} aria-hidden>{m.name.slice(0, 1)}</span>
                {directory ? <Link to="/people/$id" params={{ id: m.employeeId }}>{m.name}</Link> : <b>{m.name}</b>}
                {isPreHire && <Chip tone="info">{t("enum.employeeStatus.PRE_HIRE")}</Chip>}
                <Muted>{m.position ?? ""}</Muted>
                <span className={css.right}>{m.employeeNumber ?? ""}</span>
              </li>
            );
          })}
        </ul>
      )}
      {!historic && directory && unitId && total > 0 && (
        <Link to="/people" search={{ unit: unitId }} className="row">
          {t("orgStructure.members.all", { count: total })}
          <ChevronRight size={14} aria-hidden />
        </Link>
      )}
    </>
  );
}
