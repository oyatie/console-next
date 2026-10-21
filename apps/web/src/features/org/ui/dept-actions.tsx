import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { CornerDownRight, GitMerge, PencilLine, Plus, Trash2, UserPlus } from "lucide-react";
import { t } from "@console/i18n";
import { useCan } from "../../../reference/authz/ui/use-can";
import { Button } from "../../../ui/button/button";
import { depts, direct, type Place } from "../../../reference/org/domain/structure";
import { DeptNameInline } from "../../../reference/org/ui/dept-name-inline";
import { ActionRow, Actions } from "../../../reference/org/ui/panel-shell";
import { refusalText } from "../../../reference/crud/present";
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
  const sub = depts(n).length;
  const end = useQuery(unitEndQuery(n.id)).data;
  const endLabel = !end ? "crud.unit.end" : end.delete.allowed ? "orgUnit.act.delete" : "orgUnit.act.dissolve";
  // org-06: after go-live a used department closes through the one dissolution sheet (members, sub-department, grants, head), not two.
  // org-02: a unit held by an open change links to it, where it can be finished, moved or cancelled. The change is looked up
  // after go-live whatever the end read says first (its members' refusal outranks the open change there).
  const open = useQuery({ ...changesByStatusQuery(OPEN_CHANGE_STATUSES, { limit: 200 }), enabled: !setup });
  const blocking = open.data?.items.find((c) => c.target.kind === "ORG_UNIT" && c.target.ref === n.id);
  const locked = Boolean(blocking) || end?.dissolve.refusal === "org_unit_change_open" || end?.delete.refusal === "org_unit_change_open";
  const governedEnd = !setup && !!end && !end.delete.allowed && !locked;
  return (
    <Actions>
      {adding ? (
        <div><DeptNameInline parent={n} onDone={() => setAdding(false)} /></div>
      ) : (
        <ActionRow
          control={(d) => <Button variant="primary" id="act-dept-add" className={css.actBtn} aria-describedby={d} onClick={() => (setup ? setAdding(true) : go("dept-add"))}><Plus size={16} aria-hidden />{t("orgUnit.add.child")}</Button>}
          why={setup ? t("orgUnit.add.whyDept", { name: n.name }) : t("orgUnit.add.whyGoverned")}
        />
      )}
      {renaming ? (
        <div><DeptNameInline parent={place.parent!} unit={n} onDone={() => setRenaming(false)} /></div>
      ) : (
        <ActionRow
          control={(d) => <Button variant="ghost" id="act-dept-rename" className={css.actBtn} aria-describedby={d} onClick={() => (setup ? setRenaming(true) : go("dept-rename"))}><PencilLine size={16} aria-hidden />{t("orgUnit.rename.action")}</Button>}
          why={setup ? t("orgUnit.rename.why", { count: n.headcount }) : t("orgUnit.rename.whyGoverned")}
        />
      )}
      {can("employee_directory_manage", "all") && (
        <ActionRow
          control={(d) => <Link className={`btn btn--ghost ${css.actBtn}`} aria-describedby={d} to="/people/new" search={{ unit: n.id }}><UserPlus size={16} aria-hidden />{t("orgTree.act.register", { name: n.name })}</Link>}
          why={t("orgStructure.wp.registerWhy")}
        />
      )}
      <ActionRow
        control={(d) => <Button variant="ghost" id="act-dept-move-row" className={css.actBtn} aria-describedby={d} onClick={() => navigate({ to: "/org/move", search: { ids: n.id } })}><CornerDownRight size={16} aria-hidden />{t("orgUnit.act.move")}</Button>}
        why={t("orgUnit.act.moveWhy", { count: n.headcount })}
      />
      <ActionRow
        control={(d) => <Button variant="ghost" id="act-dept-merge" className={css.actBtn} aria-describedby={d} onClick={() => go("dept-merge")}><GitMerge size={16} aria-hidden />{t("orgUnit.act.merge")}</Button>}
        why={t("orgUnit.act.mergeWhy")}
      />
      <ActionRow
        control={(d) => (
          <Button variant="ghost" id="act-dept-delete" className={`${css.actBtn} ${css.danger}`} aria-describedby={d} onClick={() => go(governedEnd ? "dept-dissolve" : "dept-delete")}>
            <Trash2 size={16} aria-hidden />
            {t(endLabel)}
          </Button>
        )}
        why={!end ? t("crud.loading") : end.delete.allowed ? (sub > 0 ? t("orgUnit.act.deleteWhy", { sub, direct: direct(n) }) : t("orgUnit.act.deleteEmpty")) : governedEnd ? t("orgUnit.act.dissolveGoverned", { count: n.headcount }) : (refusalText(end.dissolve.refusal, { count: end.members }) ?? t("orgUnit.act.dissolveWhy"))}
      />
      {locked && blocking && (
        <div><Link to="/org/changes/$id" params={{ id: blocking.id }} id="act-dept-blocking">{t("orgUnit.act.blocking", { code: blocking.code })}</Link></div>
      )}
    </Actions>
  );
}
