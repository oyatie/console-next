import { useInlineUnitValues } from "../../../reference/org/ui/use-inline-unit-values";
import type { InlineUnitValues } from "../../../reference/org/api";
import { EntityName } from "../../../reference/entity/ui/entity-name";
import { useEffect, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, GripVertical } from "lucide-react";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { InlineUnitFields } from "../../../reference/org/ui/inline-unit-fields";
import { Button } from "../../../ui/button/button";
import { AddUnit } from "./add-unit";
import { TextInput } from "../../../ui/field/field";
import { place } from "../../../ui/org-canvas/place";
import { descendants, type ChartNode, type Structure } from "../domain/model";
import { movable, nameClash, reorderedByDrag } from "../domain/rules";
import { MovePicker } from "./move-picker";
import { useDragMove } from "./use-drag-move";
import { useStructureGesturesBare } from "./use-outline-edit";
import type { Commands } from "./use-structure-commands";
import { Chip } from "../../../ui/chip";
import { temporalLabel } from "../present";
import css from "./outline.module.css";

/** A row being typed: a new department at the end of `parent`'s children, or a rename. */
export type OutlineEdit = { kind: "new"; parent: string } | { kind: "rename"; id: string };

/**
 * The outline's rows (a tree of treeitems, roving focus): ↑↓ move, ←→ fold, Enter adds below, F2 renames, a click or
 * Space selects (the unit's panel opens beside the tree) and Esc clears the selection. A department is dragged onto its
 * new parent, a workplace or legal entity among its siblings; a line shows where it will land and M opens the same move
 * as a picker (the keyboard twin, SC 2.5.7). While a
 * new row is typed, Tab nests it under the row above and Shift+Tab takes it out one level; a workplace row takes no
 * Tab (a workplace sits only right under its legal entity). Every save applies at once in setup.
 */
export function OutlineRows(p: {
  s: Structure;
  cmd: Commands;
  cursor: string;
  setCursor: (id: string) => void;
  closed: ReadonlySet<string>;
  setClosed: (o: ReadonlySet<string>) => void;
  edit: OutlineEdit | null;
  setEdit: (e: OutlineEdit | null) => void;
  sel: ReadonlySet<string>;
  onSelect: (ids: ReadonlySet<string>) => void;
}) {
  const { s, cursor, edit } = p;
  const g = useStructureGesturesBare(s, p.cmd);
  const [moving, setMoving] = useState<ChartNode[] | null>(null);
  const open = (id: string) => p.setClosed(new Set([...p.closed].filter((x) => x !== id)));
  // A department lands inside the row it is dropped on, so that row opens to show it.
  const drag = useDragMove(s, p.sel, (nodes, target) => {
    if (!reorderedByDrag(nodes[0]!)) open(target.id);
    g.moveTo(nodes, target);
  });
  const rows: ChartNode[] = [];
  const walk = (n: ChartNode) => {
    rows.push(n);
    if (!p.closed.has(n.id)) n.children.forEach(walk);
  };
  s.root.children.forEach(walk);
  // A new row goes after the last row of its parent's subtree.
  const newParent = edit?.kind === "new" ? s.byId.get(edit.parent) : undefined;
  const after = newParent && [...rows].reverse().find((r) => r.id === newParent.id || pathHas(s, r, newParent.id))?.id;
  useEffect(() => {
    // A find step moves the cursor while the typing stays in the find field.
    if (!edit && document.activeElement?.id !== "structure-find") document.getElementById(`outline-${cursor}`)?.focus({ preventScroll: false });
  }, [cursor, edit]);

  // Where a drop would land: after the last shown row under the target, one level in for a department (it becomes the
  // last child), at the target's own level for a workplace or legal entity (it takes the next place).
  const over = drag.view?.over ? s.byId.get(drag.view.over) : undefined;
  const verdict = over && drag.view!.verdicts.get(over.id);
  const reorder = drag.view ? reorderedByDrag(drag.view.nodes[0]!) : false;
  const below = over && verdict?.ok ? new Set(descendants(over).map((d) => d.id)) : undefined;
  const lineAfter = below && over ? ([...rows].reverse().find((r) => below.has(r.id)) ?? over).id : undefined;

  const onKey = (e: KeyboardEvent) => {
    if (drag.view || (e.target as HTMLElement).closest("input, button, a")) return;
    const at = rows.findIndex((r) => r.id === cursor);
    const n = rows[at];
    if (!n) return;
    const fold = (o: boolean) => p.setClosed(new Set(o ? [...p.closed].filter((x) => x !== n.id) : [...p.closed, n.id]));
    const key = e.key;
    const opened = !p.closed.has(n.id) && n.children.length > 0;
    if (key === "ArrowDown" || key === "ArrowUp") p.setCursor((rows[at + (key === "ArrowDown" ? 1 : -1)] ?? n).id);
    else if (key === "ArrowRight" && n.children.length && !opened) fold(true);
    else if (key === "ArrowRight") p.setCursor((n.children[0] ?? n).id);
    else if (key === "ArrowLeft" && opened) fold(false);
    else if (key === "ArrowLeft") p.setCursor(n.parentId && n.parentId !== s.root.id ? n.parentId : n.id);
    else if (key === "Enter" && g.canEdit) {
      if (n.kind === "site") p.setEdit({ kind: "new", parent: n.id });
      else if (n.kind === "dept" && n.parentId) p.setEdit({ kind: "new", parent: n.parentId });
    } else if (key === "F2" && g.canEdit && n.kind === "dept") p.setEdit({ kind: "rename", id: n.id });
    else if (key === " ") p.onSelect(new Set([n.id]));
    else if (key === "Escape" && p.sel.size > 0) p.onSelect(new Set());
    // By position, so a Korean layout moves too; in setup the picker asks where, after go-live the move page does.
    else if (e.code === "KeyM" && !e.altKey && !e.ctrlKey && !e.metaKey && g.canEdit && movable(n)) {
      if (g.setup) setMoving([n]);
      else g.moveTo([n], n);
    }
    else return;
    e.preventDefault();
  };

  const input = (parent: ChartNode, renaming?: ChartNode) => (
    <InlineUnitInput
      parent={parent}
      setup={g.setup}
      asOf={s.asOf}
      pending={p.cmd.pending}
      renaming={renaming}
      onSave={(name, date, done) => {
        if (!renaming) return g.create(parent, name, date, done);
        g.rename(renaming, name, date, () => { done(); p.setEdit(null); });
      }}
      onIndent={(dir) => {
        if (renaming || edit?.kind !== "new") return;
        const target = dir === 1 ? [...parent.children].reverse().find((c) => c.kind === "dept") : parent.kind === "dept" ? s.byId.get(parent.parentId ?? "") : undefined;
        if (!target || (target.kind !== "dept" && target.kind !== "site")) return;
        p.setClosed(new Set([...p.closed].filter((x) => x !== target.id)));
        p.setEdit({ kind: "new", parent: target.id });
      }}
      onDone={() => p.setEdit(null)}
    />
  );

  return (
    <>
    {/* While a drag is live its Esc cancels the drag; the column beside the tree must not take the key first. */}
    <div className={css.rows} role="tree" aria-label={t("structure.outline.label")} tabIndex={-1} data-dragging={drag.view ? "" : undefined} data-escape-scope={drag.view ? "" : undefined}>
      <div className={css.colhead} aria-hidden><span>{t("structure.list.name")}</span><span title={t("structure.outline.levelHint")}>{t("structure.outline.levelCol")}</span><span>{t("orgUnit.stat.total")}</span></div>
      {rows.map((n) => {
        const renaming = edit?.kind === "rename" && edit.id === n.id;
        const newHere = newParent && after === n.id;
        return (
          <div key={n.id} role="none">
            <div
              id={`outline-${n.id}`}
              role="treeitem"
              aria-level={n.depth}
              aria-expanded={n.children.length ? !p.closed.has(n.id) : undefined}
              aria-selected={p.sel.has(n.id)}
              tabIndex={cursor === n.id ? 0 : -1}
              className={css.row}
              data-scheduled={n.scheduledBy ? "true" : undefined}
              data-diff={n.diffMarks?.join(" ")}
              data-current={cursor === n.id || undefined}
              data-box
              data-id={n.id}
              data-drop={drag.view?.over === n.id ? (verdict?.ok ? "ok" : "no") : undefined}
              data-moving={drag.view?.moving.has(n.id) || undefined}
              // A finger on this list scrolls it, so a drag starts from a mouse or a pen only; touch moves a unit from its panel.
              onPointerDown={(e) => { if (e.pointerType !== "touch" && g.canEdit && !edit && !(e.target as HTMLElement).closest("input, button, a")) drag.onPointerDown(e, n.id); }}
              onFocus={() => p.setCursor(n.id)}
              onClick={(e) => {
                p.setCursor(n.id);
                if (!(e.target as HTMLElement).closest("input, button, a")) p.onSelect(new Set([n.id]));
              }}
              onKeyDown={onKey}
            >
              <span className={css.name} ref={place({ "padding-left": (n.depth - 1) * 24 })}>
                <GripVertical size={14} aria-hidden className={css.grip} />
                {n.children.length ? (!p.closed.has(n.id) ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />) : <span className={css.sp} />}
                {renaming ? input(s.byId.get(n.parentId!)!, n) : <span className={n.kind === "dept" ? undefined : css.strong} onDoubleClick={() => g.canEdit && n.kind === "dept" && p.setEdit({ kind: "rename", id: n.id })}>{n.kind === "entity" ? <EntityName name={n.name} alias={n.alias} /> : n.name}</span>}
                {temporalLabel(n) && <Chip>{temporalLabel(n)}</Chip>}
              </span>
              <span className={css.level}>{t(`structure.level.${n.kind}`)}</span>
              <span className="num">{t("common.headcount", { count: n.headcount })}</span>
              {g.canEdit && <AddUnit n={n} onAdd={g.canEdit ? () => { p.setCursor(n.id); p.setClosed(new Set([...p.closed].filter((id) => id !== n.id))); p.setEdit({ kind: "new", parent: n.id }); } : undefined} />}
            </div>
            {lineAfter === n.id && over && <div className={css.insert} role="presentation" data-insert ref={place({ "margin-left": (reorder ? over.depth - 1 : over.depth) * 24 })} />}
            {newHere && (
              <div className={css.row} data-new role="treeitem" aria-level={newParent.depth + 1} aria-label={t("structure.outline.newUnder", { parent: newParent.name })}>
                <span className={css.name} ref={place({ "padding-left": newParent.depth * 24 })}>{input(newParent)}</span>
                <span className={css.level}>{t("structure.outline.newUnder", { parent: newParent.name })}</span>
                <span className="num">{fmtNumber(0)}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
    {drag.view && <div className={`${css.row} muted`} role="status"><span className={css.dropHint}>{over ? (verdict?.ok ? g.effect(drag.view.nodes, over.id) : t(`structure.drop.${verdict?.reason ?? "here"}`)) : t("structure.outline.dropIdle")}</span></div>}
    {moving && <MovePicker s={s} moving={moving} onClose={() => setMoving(null)} onMove={(target) => { open(target.id); g.moveTo(moving, target); setMoving(null); }} />}
    </>
  );
}

const pathHas = (s: Structure, n: ChartNode, id: string): boolean => {
  for (let x = n.parentId ? s.byId.get(n.parentId) : undefined; x; x = x.parentId ? s.byId.get(x.parentId) : undefined) if (x.id === id) return true;
  return false;
};

export function InlineUnitInput({ parent, renaming, setup = true, asOf, pending, onSave, onIndent, onDone }: { parent: ChartNode; renaming?: ChartNode; setup?: boolean; asOf?: string; pending: boolean; onSave: (name: string, values: InlineUnitValues, done: () => void) => void; onIndent?: (dir: 1 | -1) => void; onDone: () => void }) {
  const state = useInlineUnitValues(setup, asOf, renaming ? "rename" : "create");
  const [baseParent, setBaseParent] = useState(parent);
  const [baseRenaming] = useState(renaming);
  if (!pending && baseParent !== parent) setBaseParent(parent);
  const [name, setName] = useState(baseRenaming?.name ?? "");
  const trimmed = name.trim();
  const clash = trimmed && nameClash(baseParent, trimmed, baseRenaming?.id);
  const save = (send = true) => {
    if (baseRenaming && trimmed === baseRenaming.name) return onDone();
    if (trimmed && !clash && !pending && state.attempt()) onSave(trimmed, { ...state.values, submit: send }, () => setName(""));
  };
  return (
    <span className={css.edit}>
      <TextInput
        ref={(el: HTMLInputElement | null) => {
          if (!el || el.dataset.focused) return;
          el.dataset.focused = "1";
          el.focus();
        }}
        className={css.input}
        aria-label={baseRenaming ? t("structure.edit.renameLabel", { name: baseRenaming.name }) : t("structure.edit.addLabel", { parent: baseParent.name })}
        aria-invalid={clash ? true : undefined}
        value={name}
        readOnly={pending}
        onChange={(e) => setName(e.target.value)}
        maxLength={120}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") return onDone();
          if (e.key === "Tab" && onIndent) return (e.preventDefault(), onIndent(e.shiftKey ? -1 : 1));
          if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) save();
        }}
      />
      <InlineUnitFields setup={setup} state={state} pending={pending} onDraft={() => save(false)} />
      {clash && <span role="alert">{t("structure.edit.clash", { name: trimmed })}</span>}
      <Button aria-description={state.missingReason ? t("orgUnit.gov.reasonForApproval") : undefined} size="sm" variant="primary" onClick={() => save()} disabled={pending || !state.valid}>{t(baseRenaming ? "orgUnit.rename.save" : "orgUnit.add.save")}</Button>
      <Button size="sm" variant="ghost" onClick={onDone}>{t("structure.cancel")}</Button>
    </span>
  );
}
