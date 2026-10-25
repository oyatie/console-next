import { EntityName } from "../../../reference/entity/ui/entity-name";
import { useEffect, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, GripVertical } from "lucide-react";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { Button } from "../../../ui/button/button";
import { AddUnit } from "./add-unit";
import { TextInput } from "../../../ui/field/field";
import { place } from "../../../ui/org-canvas/place";
import type { ChartNode, Structure } from "../domain/model";
import { nameClash } from "../domain/rules";
import { useStructureGesturesBare } from "./use-outline-edit";
import type { Commands } from "./use-structure-commands";
import { Chip } from "../../../ui/chip";
import { temporalLabel } from "../present";
import css from "./outline.module.css";

/** A row being typed: a new department at the end of `parent`'s children, or a rename. */
export type OutlineEdit = { kind: "new"; parent: string } | { kind: "rename"; id: string };

/**
 * The outline's rows (a tree of treeitems, roving focus): ↑↓ move, ←→ fold, Enter adds below, F2 renames. While a
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
    if (!edit) document.getElementById(`outline-${cursor}`)?.focus({ preventScroll: false });
  }, [cursor, edit]);

  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input, button, a")) return;
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
    else if (key === "Enter" && g.setup) {
      if (n.kind === "site") p.setEdit({ kind: "new", parent: n.id });
      else if (n.kind === "dept" && n.parentId) p.setEdit({ kind: "new", parent: n.parentId });
    } else if (key === "F2" && g.setup && n.kind === "dept") p.setEdit({ kind: "rename", id: n.id });
    else if (key === " ") p.onSelect(new Set([n.id]));
    else return;
    e.preventDefault();
  };

  const input = (parent: ChartNode, renaming?: ChartNode) => (
    <NewName
      parent={parent}
      pending={p.cmd.pending}
      renaming={renaming}
      onSave={(name, done) => {
        if (!renaming) return g.create(parent, name, done);
        g.rename(renaming, name);
        p.setEdit(null);
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
    <div className={css.rows} role="tree" aria-label={t("structure.outline.label")} tabIndex={-1}>
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
              onFocus={() => p.setCursor(n.id)}
              onClick={() => p.setCursor(n.id)}
              onKeyDown={onKey}
            >
              <span className={css.name} ref={place({ "padding-left": (n.depth - 1) * 24 })}>
                <GripVertical size={14} aria-hidden className={css.grip} />
                {n.children.length ? (!p.closed.has(n.id) ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />) : <span className={css.sp} />}
                {renaming ? input(s.byId.get(n.parentId!)!, n) : <span className={n.kind === "dept" ? undefined : css.strong}>{n.kind === "entity" ? <EntityName name={n.name} alias={n.alias} /> : n.name}</span>}
                {temporalLabel(n) && <Chip>{temporalLabel(n)}</Chip>}
              </span>
              <span className={css.level}>{t(`structure.level.${n.kind}`)}</span>
              <span className="num">{t("common.headcount", { count: n.headcount })}</span>
              {!s.readOnly && <AddUnit n={n} onAdd={g.setup ? () => { p.setCursor(n.id); p.setClosed(new Set([...p.closed].filter((id) => id !== n.id))); p.setEdit({ kind: "new", parent: n.id }); } : undefined} />}
            </div>
            {newHere && (
              <div className={css.row} data-new role="none">
                <span className={css.name} ref={place({ "padding-left": newParent.depth * 24 })}>{input(newParent)}</span>
                <span className={css.level}>{t("structure.outline.newUnder", { parent: newParent.name })}</span>
                <span className="num">{fmtNumber(0)}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const pathHas = (s: Structure, n: ChartNode, id: string): boolean => {
  for (let x = n.parentId ? s.byId.get(n.parentId) : undefined; x; x = x.parentId ? s.byId.get(x.parentId) : undefined) if (x.id === id) return true;
  return false;
};

function NewName({ parent, renaming, pending, onSave, onIndent, onDone }: { parent: ChartNode; renaming?: ChartNode; pending: boolean; onSave: (name: string, done: () => void) => void; onIndent: (dir: 1 | -1) => void; onDone: () => void }) {
  const [name, setName] = useState(renaming?.name ?? "");
  const trimmed = name.trim();
  const clash = trimmed && nameClash(parent, trimmed, renaming?.id);
  const save = () => { if (trimmed && !clash && !pending) onSave(trimmed, () => setName("")); };
  return (
    <span className={css.edit}>
      <TextInput
        ref={(el: HTMLInputElement | null) => {
          if (!el || el.dataset.focused) return;
          el.dataset.focused = "1";
          el.focus();
        }}
        className={css.input}
        aria-label={renaming ? t("structure.edit.renameLabel", { name: renaming.name }) : t("structure.edit.addLabel", { parent: parent.name })}
        aria-invalid={clash ? true : undefined}
        value={name}
        readOnly={pending}
        onChange={(e) => setName(e.target.value)}
        maxLength={120}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") return onDone();
          if (e.key === "Tab") return (e.preventDefault(), onIndent(e.shiftKey ? -1 : 1));
          if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) save();
        }}
      />
      {clash && <span role="alert">{t("structure.edit.clash", { name: trimmed })}</span>}
      <Button size="sm" variant="primary" onClick={save} disabled={pending}>{t(renaming ? "orgUnit.rename.save" : "orgUnit.add.save")}</Button>
      <Button size="sm" variant="ghost" onClick={onDone}>{t("structure.cancel")}</Button>
    </span>
  );
}
