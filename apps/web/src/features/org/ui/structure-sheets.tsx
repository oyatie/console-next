import { getRouteApi } from "@tanstack/react-router";
import { focusSoon } from "../../../lib/react/announce";
import { STRUCTURE_ACTS, type StructureAct } from "../../../reference/org/domain/structure";
import { useStructure } from "../../../reference/org/ui/use-structure";
import { useStructureSlots } from "../../../reference/org/ui/use-structure-slots";
import { DeptAddGovernedSheet } from "./dept-add-governed-sheet";
import { DeptDissolveSheet } from "./dept-dissolve-sheet";
import { DeptEndSheet } from "./dept-end-sheet";
import { DeptMergeSheet } from "./dept-merge-sheet";
import { DeptRenameGovernedSheet } from "./dept-rename-governed-sheet";

const route = getRouteApi("/app/org");

/**
 * The sheet `?act=` opens over the company structure page, for the selection `sel` (a legal entity for adding a
 * workplace, a workplace or a department otherwise). Workplace sheets come from the page's slots; closing goes
 * back to the panel and to the control that opened the sheet.
 */
export function StructureSheets() {
  const { sel, act } = route.useSearch();
  const navigate = route.useNavigate();
  const slots = useStructureSlots();
  const s = useStructure(sel);
  if (!act || !(STRUCTURE_ACTS as readonly string[]).includes(act) || !s.at) return null;
  const close = () => {
    void navigate({ search: (x) => ({ ...x, act: undefined }) });
    focusSoon(`act-${act}`, "org-tree");
  };
  const select = (id?: string) => navigate({ search: (x) => ({ ...x, sel: id, act: undefined }) });
  const onAct = (next: StructureAct) => navigate({ search: (x) => ({ ...x, act: next }) });
  const at = s.at;
  const a = act as StructureAct;
  if (a.startsWith("wp-")) return slots?.workplaceSheet({ act: a, at, setup: s.setup, onClose: close, onSelect: (id) => void select(id), onAct: (n) => void onAct(n) }) ?? null;
  switch (a) {
    case "dept-add":
      return at.kind !== "entity" && !s.setup ? <DeptAddGovernedSheet place={at} onClose={close} /> : null;
    case "dept-rename":
      return at.kind === "dept" && !s.setup ? <DeptRenameGovernedSheet place={at} onClose={close} /> : null;
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
