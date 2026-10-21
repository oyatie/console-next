import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus, Trash2, UserPlus } from "lucide-react";
import { t } from "@console/i18n";
import { useCan } from "../../../reference/authz/ui/use-can";
import { Button } from "../../../ui/button/button";
import { descendants, direct, type Place, type StructureAct } from "../../../reference/org/domain/structure";
import { DeptNameInline } from "../../../reference/org/ui/dept-name-inline";
import { ActionRow, Actions } from "../../../reference/org/ui/panel-shell";
import { refusalText } from "../../../reference/crud/present";
import { workplaceEndQuery } from "../api";
import css from "../../../reference/org/ui/structure.module.css";

/**
 * What can be done to a workplace, each with its consequence: add a department (at once in setup, a proposal after go-live),
 * register someone straight here, and end it: delete when nothing ever used it, close when something did (CRUD: decided by use,
 * in either phase; the server's end-options read says which and why not the other).
 */
export function WorkplaceActions({ place, setup, onAct }: { place: Place; setup: boolean; onAct: (act: StructureAct) => void }) {
  const can = useCan();
  const [adding, setAdding] = useState(false);
  const n = place.node;
  const go = onAct;
  const end = useQuery(workplaceEndQuery(n.id)).data;
  const erase = end ? end.delete.allowed : setup;
  return (
    <Actions>
      {adding ? (
        <div><DeptNameInline parent={n} onDone={() => setAdding(false)} /></div>
      ) : (
        <ActionRow
          control={(d) => <Button variant="primary" id="act-dept-add" className={css.actBtn} aria-describedby={d} onClick={() => (setup ? setAdding(true) : go("dept-add"))}><Plus size={16} aria-hidden />{t("orgUnit.add.action")}</Button>}
          why={setup ? t("orgUnit.add.whyWorkplace", { name: n.name }) : t("orgUnit.add.whyGoverned")}
        />
      )}
      {can("employee_directory_manage", "all") && n.org_unit_id && (
        <ActionRow
          control={(d) => <Link className={`btn btn--ghost ${css.actBtn}`} aria-describedby={d} to="/people/new" search={{ unit: n.org_unit_id }}><UserPlus size={16} aria-hidden />{t("orgTree.act.register", { name: n.name })}</Link>}
          why={t("orgStructure.wp.registerWhy")}
        />
      )}
      <ActionRow
        control={(d) => (
          <Button variant="ghost" id={erase ? "act-wp-delete" : "act-wp-close"} className={`${css.actBtn} ${css.danger}`} aria-describedby={d} onClick={() => go(erase ? "wp-delete" : "wp-close")}>
            <Trash2 size={16} aria-hidden />
            {t(erase ? "orgStructure.wp.delete" : "orgStructure.wp.close")}
          </Button>
        )}
        why={
          !end
            ? t("crud.loading")
            : erase
              ? descendants(n).length + direct(n) > 0
                ? t("orgStructure.wp.deleteBlocked", { depts: descendants(n).length, people: direct(n) })
                : t("orgStructure.wp.deleteWhy")
              : (refusalText(end.delete.refusal) ?? t("orgStructure.wp.closeWhy", { count: n.headcount }))
        }
      />
    </Actions>
  );
}
