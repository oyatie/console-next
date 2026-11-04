import type { Structure } from "../domain/model";
import type { ChartState } from "./use-chart-state";
import { NameBox } from "./name-box";
import { SiteSlot } from "./site-slot";
import { RootActions } from "./root-actions";
import type { Rect } from "../../../ui/org-canvas/use-view";

/**
 * The fields and next steps drawn over the chart in its layer (outside the tree role, so the tree holds only its
 * boxes): the add box under a parent, the rename box over a box, and a legal entity's 「first workplace」 slot.
 */
export function ChartEditors({ s, c, zoom, visible, pending, onAdd, onRename }: {
  s: Structure;
  zoom: number;
  visible: Rect;
  /** The last applied batch: a new one opens a fresh, empty add box for the next name. */
  batch?: string;
  c: ChartState;
  pending: boolean;
  onAdd: (parentId: string, name: string, effectiveDate: string, done: () => void) => void;
  onRename: (id: string, name: string, effectiveDate: string) => void;
}) {
  if (s.readOnly) return null;
  const setup = s.phase === "SETUP";
  const renamed = c.renaming ? c.shown.get(c.renaming) : undefined;
  const parent = renamed?.node.parentId ? s.byId.get(renamed.node.parentId) : undefined;
  return (
    <>
      {c.L.boxes.map((b) =>
        b.slot ? <SiteSlot key={`slot:${b.node.id}`} box={b} />
        : b.ghost ? <NameBox key={`add:${b.node.id}`} box={b} parent={b.node} setup={setup} asOf={s.asOf} pending={pending} onSubmit={(name, date, done) => onAdd(b.node.id, name, date, done)} onCancel={() => c.setAdding(null)} />
        : null,
      )}
      {!s.readOnly && c.focus.kind === "tenant" && c.shown.get(s.root.id) && <RootActions box={c.shown.get(s.root.id)!} zoom={zoom} visible={visible} setup={s.phase === "SETUP"} />}
      {renamed && parent && (
        <NameBox key={`ren:${renamed.node.id}`} box={renamed} parent={parent} renaming={renamed.node} setup={setup} asOf={s.asOf} pending={pending} onSubmit={(name, date) => onRename(renamed.node.id, name, date)} onCancel={() => c.setRenaming(null)} />
      )}
    </>
  );
}
