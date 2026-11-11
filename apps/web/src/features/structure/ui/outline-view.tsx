import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { t } from "@console/i18n";
import { Receipt } from "../../../ui/receipt/receipt";
import { CommandError } from "../../../lib/react/command-error";
import { pathTo, type Structure } from "../domain/model";
import { findHits } from "../domain/search";
import { OutlineRows, type OutlineEdit } from "./outline-rows";
import type { ViewCommands } from "./page-head";
import type { Commands } from "./use-structure-commands";
import css from "./outline.module.css";

/** The panel follows the cursor once it rests, as the shared columns do for a list: a held ↓ opens nothing on the way. */
const SETTLE_MS = 150;

/**
 * The outline (spec S2b): the tree as rows for fast keyboard entry, with each unit's headcount; the selected unit's
 * panel opens beside it. Enter adds below, Tab / Shift+Tab nest while a new row is being typed, F2 renames, Esc ends
 * editing. list paste creates many department under the row's place in one batch (MR-30).
 */
export function OutlineView({ s, cmd, sel, onSelect, pick, find = "", follow = true, ref }: {
  s: Structure; cmd: Commands; sel: ReadonlySet<string>; onSelect: (ids: ReadonlySet<string>) => void;
  /** A unit picked from outside the tree (⌘K, a link, a panel's sub-department): it takes the cursor. */
  pick?: { id: string; n: number };
  /** The page toolbar's find text and its commands for this view. */
  find?: string;
  /** Off while a proposal card or sheet holds the selection: moving the cursor must not take it away. */
  follow?: boolean;
  ref?: Ref<ViewCommands>;
}) {
  const [cursor, setCursor] = useState<string>(() => [...sel].find((id) => s.byId.has(id)) ?? s.root.children[0]?.id ?? s.root.id);
  // Rows are open unless folded, so a new department shows with its children.
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [edit, setEdit] = useState<OutlineEdit | null>(null);
  const open = (ids: readonly string[]) => setClosed((c) => new Set([...c].filter((id) => !ids.includes(id))));
  /** Moves the cursor to a row, opening the way to it. */
  const show = (id: string) => {
    open(pathTo(s, id).slice(0, -1).map((n) => n.id));
    setCursor(id);
  };
  const [picked, setPicked] = useState(pick?.n);
  if (pick && pick.n !== picked) {
    setPicked(pick.n);
    if (s.byId.has(pick.id)) show(pick.id);
  }
  // Only a cursor move asks for the panel to follow, and only from one row of this tree to another: arriving with a
  // selection (a link, a reload) or one made elsewhere is never taken back.
  const live = useRef({ sel, onSelect, follow });
  useEffect(() => void (live.current = { sel, onSelect, follow }));
  const rested = useRef(cursor);
  useEffect(() => {
    if (rested.current === cursor) return;
    rested.current = cursor;
    const timer = setTimeout(() => {
      const now = live.current;
      const [one] = now.sel;
      if (now.follow && now.sel.size === 1 && one !== cursor && s.byId.has(one!)) now.onSelect(new Set([cursor]));
    }, SETTLE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor]);
  useImperativeHandle(ref, () => ({
    find: (step) => {
      const ids = findHits(s, find).ids;
      const at = ids.indexOf(cursor);
      const next = ids[at < 0 ? (step < 0 ? ids.length - 1 : 0) : (at + step + ids.length) % ids.length];
      if (next) show(next);
    },
    fold: () => {
      setClosed(new Set([...s.byId.values()].filter((n) => n.children.length > 0).map((n) => n.id)));
      // The cursor stays on a row that is still shown: its legal entity.
      setCursor(pathTo(s, cursor)[1]?.id ?? cursor);
    },
    add: (parent) => {
      open(pathTo(s, parent.id).map((n) => n.id));
      setCursor(parent.id);
      setEdit({ kind: "new", parent: parent.id });
    },
  }));
  const at = s.byId.get(cursor);
  const entity = at?.entityId ? s.byId.get(at.entityId) : s.root.children[0];
  return (
    <section className={css.pane} aria-labelledby="outline-title">
      <div className={css.head}>
        <h2 id="outline-title" className="panel__title">{t("structure.outline.title", { name: entity?.name ?? t("structure.root.word") })}</h2>
      </div>
      <OutlineRows s={s} cmd={cmd} cursor={cursor} setCursor={setCursor} closed={closed} setClosed={setClosed} edit={edit} setEdit={setEdit} sel={sel} onSelect={onSelect} />
      <div className={css.foot}>
        {cmd.error ? <CommandError error={cmd.error} /> : cmd.last && <Receipt state="applied" message={cmd.last.message} undoing={cmd.undoing} onUndo={cmd.undo} onDismiss={cmd.dismiss} />}
      </div>
    </section>
  );
}
