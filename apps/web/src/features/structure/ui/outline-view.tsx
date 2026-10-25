import { useState } from "react";
import { getRouteApi, Link } from "@tanstack/react-router";
import { Upload, X } from "lucide-react";
import { t } from "@console/i18n";
import { buttonClass } from "../../../ui/button/button-class";
import { Button } from "../../../ui/button/button";
import { Receipt } from "../../../ui/receipt/receipt";
import { CommandError } from "../../../lib/react/command-error";
import type { Structure } from "../domain/model";
import { ChartView } from "./chart-view";
import { OutlineRows, type OutlineEdit } from "./outline-rows";
import type { Commands } from "./use-structure-commands";
import css from "./outline.module.css";

const route = getRouteApi("/app/org");

/**
 * The outline (spec S2b): the tree as rows for fast keyboard entry, docked beside the live chart, which follows the
 * row in focus. Enter adds below, Tab / Shift+Tab nest while a new row is being typed, F2 renames, Esc ends editing.
 * list paste creates many department under the row's place in one batch (MR-30).
 */
export function OutlineView({ s, cmd, sel, onSelect }: { s: Structure; cmd: Commands; sel: ReadonlySet<string>; onSelect: (ids: ReadonlySet<string>) => void }) {
  const navigate = route.useNavigate();
  const [cursor, setCursor] = useState<string>(s.root.children[0]?.id ?? s.root.id);
  // Rows are open unless folded, so a new department shows with its children.
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [edit, setEdit] = useState<OutlineEdit | null>(null);
  const at = s.byId.get(cursor);
  // The chart shows the place the cursor is in: its workplace, or the legal entity itself.
  const place = at && (at.kind === "entity" || at.kind === "site" ? at : at.siteId ? s.byId.get(at.siteId) : undefined);
  const entity = at?.entityId ? s.byId.get(at.entityId) : s.root.children[0];
  return (
    <div className={css.split}>
      <section className={css.pane} aria-labelledby="outline-title">
        <div className={css.head}>
          <h2 id="outline-title" className="panel__title">{t("structure.outline.title", { name: entity?.name ?? t("structure.root.word") })}</h2>
          <span className="grow" />
          {!s.readOnly && s.phase === "SETUP" && (
            <Link to="/org" search={true} hash="structure-import" className={buttonClass("ghost")}><Upload size={16} aria-hidden />{t("structure.import.label")}</Link>
          )}
          <Button variant="ghost" aria-label={t("structure.outline.close")} onClick={() => void navigate({ search: (q) => ({ ...q, view: undefined }) })}><X size={16} aria-hidden /></Button>
        </div>
        <p className={css.intro}>{t("structure.outline.intro")}</p>
        <OutlineRows s={s} cmd={cmd} cursor={cursor} setCursor={setCursor} closed={closed} setClosed={setClosed} edit={edit} setEdit={setEdit} sel={sel} onSelect={onSelect} />
        <div className={css.foot}>
          {cmd.error ? <CommandError error={cmd.error} /> : cmd.last && <Receipt state="applied" message={cmd.last.message} undoing={cmd.undoing} onUndo={cmd.undo} onDismiss={cmd.dismiss} />}
          <p className={css.keys}>{t("structure.outline.keys")}</p>
          {at?.kind === "site" && edit?.kind === "new" && <p className={css.keys}>{t("structure.outline.tabInert")}</p>}
        </div>
      </section>
      {place && <ChartView key={place.id} quiet s={s} cmd={cmd} focusId={place.id} onFocus={() => undefined} sel={sel} onSelect={onSelect} />}
    </div>
  );
}
