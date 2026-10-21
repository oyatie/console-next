import { getRouteApi } from "@tanstack/react-router";
import { CornerDownRight, List, Trash2, X } from "lucide-react";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import type { Structure } from "../domain/model";
import { collapseSelection, movable } from "../domain/rules";
import type { Gestures } from "../present";
import css from "./chart.module.css";

const route = getRouteApi("/app/org");
/** The chart's keys for the same acts (use-chart-keys). */
const KEYS = { move: "M", clear: "Esc" } as const;

/**
 * The bar for a multiple selection (spec S2, R26), docked in the chart's gutter: what is chosen, how many people and
 * from which workplace, which chosen department ride along with a chosen ancestor (a note above it), and move, delete, show in
 * the list, clear. One gesture for all of them.
 */
export function SelectionBar({ s, c, g }: {
  s: Structure;
  /** `cursor`: the box the keyboard is on (named when it is not chosen); `byKeys`: the choice was made with the keyboard (its keys are shown). */
  c: { sel: ReadonlySet<string>; setSel: (x: ReadonlySet<string>) => void; cursor: string; byKeys: boolean };
  g: Pick<Gestures, "move" | "remove">;
}) {
  const navigate = route.useNavigate();
  if (c.sel.size < 2) return null;
  const { top, folded } = collapseSelection(s, c.sel);
  const depts = top.filter(movable);
  const people = top.reduce((n, x) => n + x.headcount, 0);
  const first = depts[0];
  // One workplace holds them all: it is named (where the move starts from).
  const sites = new Set(top.map((n) => n.siteId));
  const site = sites.size === 1 ? s.byId.get([...sites][0] ?? "") : undefined;
  // One level chosen is named ("4 departments chosen").
  const kinds = new Set([...c.sel].map((id) => s.byId.get(id)?.kind));
  const level = kinds.size === 1 ? t(`structure.level.${[...kinds][0] ?? "dept"}`) : "none";
  const cursor = c.sel.has(c.cursor) ? undefined : s.byId.get(c.cursor);
  return (
    <div className={css.selwrap}>
      {folded.length > 0 && <p className={`${css.selnote} card`}>{t("structure.selection.folded", { count: folded.length, moving: top.length })}</p>}
      <div className={css.selbar} role="region" aria-label={t("structure.selection.label")}>
        <span role="status">
          <b>{t("structure.selection.summary", { count: c.sel.size, level })}</b>
          {" · "}{t("structure.selection.people", { people })}
          {cursor && c.byKeys ? <> · {t("structureChart.selection.cursor", { name: cursor.name })}</> : site && <> · {site.name}</>}
        </span>
        {first && depts.length === top.length && (
          <>
            <Button variant="primary" onClick={() => g.move(first)}><CornerDownRight size={16} aria-hidden />{t("structure.selection.move")}<kbd className={css.kbd}>{KEYS.move}</kbd></Button>
            <Button onClick={() => g.remove(first)}><Trash2 size={16} aria-hidden />{t("structure.selection.delete")}</Button>
          </>
        )}
        <Button variant="ghost" onClick={() => void navigate({ search: (q) => ({ ...q, view: "list" }) })}><List size={16} aria-hidden />{t("structure.selection.inList")}</Button>
        <Button variant="ghost" onClick={() => c.setSel(new Set())}><X size={16} aria-hidden />{t("structure.selection.clear")}<kbd className={css.kbd}>{KEYS.clear}</kbd></Button>
      </div>
      {c.byKeys && <p className={`${css.selnote} card`}>{t("structureChart.selection.keys")}</p>}
    </div>
  );
}
