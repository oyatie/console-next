import { getRouteApi } from "@tanstack/react-router";
import { focusSoon } from "../../../lib/react/announce";
import { STRUCTURE_ACTS, type StructureAct } from "../../../reference/org/domain/structure";
import { useStructure } from "../../../reference/org/ui/use-structure";
import { useStructureSlots } from "../../../reference/org/ui/use-structure-slots";
import { DeptNameComposer } from "./dept-name-composer";
import { DeptDissolveSheet } from "./dept-dissolve-sheet";
import { DeptEndSheet } from "./dept-end-sheet";
import { DeptMergeSheet } from "./dept-merge-sheet";
import { DeptDetails } from "./dept-details";

const route = getRouteApi("/app/org");

/**
 * The sheet `?act=` opens over the company structure page, for the selection `sel` (a legal entity for adding a
 * workplace, a workplace or a department otherwise). Workplace sheets come from the page's slots; closing goes
 * back to the panel and to the control that opened the sheet.
 */
export function StructureSheets() {
  const { sel, act, view, act_unit } = route.useSearch();
  const navigate = route.useNavigate();
  const slots = useStructureSlots();
  const actionUnit = act === "dept-head" ? act_unit ?? sel : sel;
  const s = useStructure(actionUnit);
  if (!act || !(STRUCTURE_ACTS as readonly string[]).includes(act) || !s.at) return null;
  const close = () => {
    void navigate({ search: (x) => ({ ...x, act: undefined, act_unit: undefined }) });
    focusSoon(act === "dept-head" && view === "list" ? `act-dept-head-${actionUnit}` : `act-${act}`, view === "list" ? "registry-vacant" : "org-tree");
  };
  const select = (id?: string) => navigate({ search: (x) => ({ ...x, sel: id, act: undefined }) });
  const onAct = (next: StructureAct) => navigate({ search: (x) => ({ ...x, act: next }) });
  const at = s.at;
  const a = act as StructureAct;
  if (a.startsWith("wp-")) return slots?.workplaceSheet({ act: a, at, setup: s.setup, onClose: close, onSelect: (id) => void select(id), onAct: (n) => void onAct(n) }) ?? null;
  switch (a) {
    case "dept-head":
      return at.kind === "dept" && !s.q.data?.read_only ? <DeptDetails key={at.node.id} node={at.node} appoint onDone={close} /> : null;
    case "dept-add":
      return at.kind !== "entity" && !s.setup ? <DeptNameComposer key={`create:${at.node.id}`} mode="create" place={at} onClose={close} /> : null;
    case "dept-rename":
      return at.kind === "dept" && !s.setup ? <DeptNameComposer key={`rename:${at.node.id}`} mode="rename" place={at} onClose={close} /> : null;
    // CRUD: one sheet in both phases; the server says whether it is deleted (never used) or dissolution (used).
    case "dept-delete":
      return at.kind === "dept" ? <DeptEndSheet place={at} setup={s.setup} onClose={close} onDone={() => void select(at.parent?.id)} onPropose={() => void onAct("dept-dissolve")} /> : null;
    // The dissolution proposal: members moved in the same change, or a tenant that routes org changes.
    case "dept-dissolve":
      return at.kind === "dept" && !s.setup ? <DeptDissolveSheet place={at} places={s.places} company={s.tenant} onClose={close} /> : null;
    case "dept-merge":
      return at.kind === "dept" ? <DeptMergeSheet place={at} places={s.places} setup={s.setup} company={s.tenant} onClose={close} onDone={(target) => void select(target)} /> : null;
    default:
      return null;
  }
}
