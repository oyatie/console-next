import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { CornerDownRight, GitMerge, PencilLine, Plus, Trash2, UserPlus } from "lucide-react";
import { t } from "@console/i18n";
import { useCan } from "../../../reference/authz/ui/use-can";
import { Button } from "../../../ui/button/button";
import type { Place } from "../../../reference/org/domain/structure";
import { DeptNameInline } from "../../../reference/org/ui/dept-name-inline";
import { Actions } from "../../../reference/org/ui/panel-shell";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { changesByStatusQuery, OPEN_CHANGE_STATUSES, unitEndQuery } from "../api";
import css from "../../../reference/org/ui/structure.module.css";

const route = getRouteApi("/app/org");

/**
 * A department's actions, each with what it does: add a department under it, register someone here, move it (S8), merge it into
 * another department, or end it: delete when it was never used, dissolution when it was (CRUD: the server decides by use, in either phase).
 * Setup applies at once; after go-live adding and renaming open a proposal.
 */
export function DeptActions({ place, setup }: { place: Place; setup: boolean }) {
  const can = useCan();
  const navigate = route.useNavigate();
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const n = place.node;
  const go = (act: "dept-add" | "dept-rename" | "dept-delete" | "dept-dissolve" | "dept-merge") => navigate({ search: (s) => ({ ...s, act }) });
  const ending = useQuery(unitEndQuery(n.id));
  const end = ending.data;
  const endLabel = !end ? "crud.unit.end" : end.delete.allowed ? "orgUnit.act.delete" : "orgUnit.act.dissolve";
  // org-06: after go-live a used department closes through the one dissolution sheet (members, sub-department, grants, head), not two.
  // org-02: a unit held by an open change links to it, where it can be finished, moved or cancelled. The change is looked up
  // after go-live whatever the end read says first (its members' refusal outranks the open change there).
  const open = useQuery({ ...changesByStatusQuery(OPEN_CHANGE_STATUSES, { limit: 200 }), enabled: !setup });
  const blocking = end?.held_by ?? open.data?.items.find((c) => c.target.kind === "ORG_UNIT" && c.target.ref === n.id);
  const locked = Boolean(blocking) || end?.dissolve.refusal === "org_unit_change_open" || end?.delete.refusal === "org_unit_change_open";
  const governedEnd = !setup && !!end && !end.delete.allowed && !locked;
  return (
    <Actions>
      {adding ? (
        <div><DeptNameInline parent={n} onDone={() => setAdding(false)} /></div>
      ) : (
        <div><Button variant="primary" id="act-dept-add" className={css.actBtn} onClick={() => (setup ? setAdding(true) : go("dept-add"))}><Plus size={16} aria-hidden />{t("orgUnit.add.child")}</Button></div>
      )}
      {renaming ? (
        <div><DeptNameInline parent={place.parent!} unit={n} onDone={() => setRenaming(false)} /></div>
      ) : (
        <div><Button variant="ghost" id="act-dept-rename" className={css.actBtn} onClick={() => (setup ? setRenaming(true) : go("dept-rename"))}><PencilLine size={16} aria-hidden />{t("orgUnit.rename.action")}</Button></div>
      )}
      {can("employee_directory_manage", "all") && (
        <div><Link className={`btn btn--ghost ${css.actBtn}`} to="/people/new" search={{ unit: n.id }}><UserPlus size={16} aria-hidden />{t("orgTree.act.register", { name: n.name })}</Link></div>
      )}
      <div><Button variant="ghost" id="act-dept-move-row" className={css.actBtn} onClick={() => navigate({ to: "/org/move", search: { ids: n.id } })}><CornerDownRight size={16} aria-hidden />{t("orgUnit.act.move")}</Button></div>
      <div><Button variant="ghost" id="act-dept-merge" className={css.actBtn} onClick={() => go("dept-merge")}><GitMerge size={16} aria-hidden />{t("orgUnit.act.merge")}</Button></div>
      {!locked && <div>{end || ending.isError ? (
        <Button variant="ghost" id="act-dept-delete" className={`${css.actBtn} ${css.danger}`} onClick={() => go(governedEnd ? "dept-dissolve" : "dept-delete")}>
          <Trash2 size={16} aria-hidden />{t(endLabel)}
        </Button>
      ) : (
        <DisabledReason layout="disclosure" reason={t("crud.loading")} control={(p) => <Button variant="ghost" id="act-dept-delete" {...p}><Trash2 size={16} aria-hidden />{t(endLabel)}</Button>} />
      )}</div>}
      {locked && blocking && (
        <div><span>{t("orgUnit.act.blocking", { code: blocking.code })}</span><Link to="/org/changes/$id" params={{ id: blocking.id }} id="act-dept-blocking">{t("crud.unit.openHeld", { code: blocking.code })}</Link></div>
      )}
    </Actions>
  );
}
