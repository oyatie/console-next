import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, CornerDownRight, Download, GitMerge, Network, Rows3, Trash2 } from "lucide-react";
import { t } from "@console/i18n";
import { saveFile } from "../../../lib/download";
import { Button, ToggleButton } from "../../../ui/button/button";
import type { ChartNode, Structure } from "../domain/model";
import { LIST_FILTERS, registryCsv, type ListFilter } from "../domain/registry";
import { collapseSelection, movable, orderStep } from "../domain/rules";
import type { Commands } from "./use-structure-commands";
import { levelText } from "../present";
import css from "./chart.module.css";

const route = getRouteApi("/app/org");
const SHEET = ["level", "entity", "site", "dept", "code", "head", "people"] as const;

/** The list's quick filters and the org sheet download (spec S2-registry): the sheet holds the rows shown. */
export function RegistryFilters({ s, rows, filters, onFilters }: { s: Structure; rows: readonly ChartNode[]; filters: ReadonlySet<ListFilter>; onFilters: (f: ReadonlySet<ListFilter>) => void }) {
  const flip = (f: ListFilter) => onFilters(filters.has(f) ? new Set([...filters].filter((x) => x !== f)) : new Set([...filters, f]));
  const download = () =>
    saveFile(new Blob([registryCsv(s, rows, [...SHEET.map((h) => t(`structureChart.sheet.${h}`)), t("asof.label"), t("asof.knownAt")], levelText)], { type: "text/csv;charset=utf-8" }), t("structureChart.sheet.file", { date: s.asOf }));
  return (
    <>
      <div className="row" role="group" aria-label={t("structureChart.list.filters")}>
        {LIST_FILTERS.map((f) => <ToggleButton key={f} className={css.pill} pressed={filters.has(f)} onClick={() => flip(f)}>{t(`structureChart.list.filter.${f}`)}</ToggleButton>)}
      </div>
      <span className="grow" />
      <Button onClick={download} disabled={rows.length === 0}><Download size={16} aria-hidden />{t("structureChart.list.download")}</Button>
    </>
  );
}

/**
 * What the list's chosen rows can do (S2-registry bar): show them on the chart, move departments (the move page),
 * merge or delete one, edit workplaces together. The sheets open over the page as they do from the chart.
 */
export function RegistryActions({ s, sel }: { s: Structure; sel: ReadonlySet<string> }) {
  const navigate = useNavigate();
  const nav = route.useNavigate();
  const { top } = collapseSelection(s, sel);
  const depts = top.length > 0 && top.every(movable) ? top : [];
  const one = top.length === 1 ? top[0] : undefined;
  const sites = top.length > 0 && top.every((n) => n.kind === "site");
  const sheet = (id: string, act: "dept-merge" | "dept-delete" | "wp-delete" | "wp-close") => void nav({ search: (q) => ({ ...q, sel: id, act, kind: undefined }) });
  const deleteAct = one?.kind === "dept" ? "dept-delete" : one?.kind === "site" ? (s.phase === "SETUP" ? "wp-delete" : "wp-close") : undefined;
  return (
    <>
      {!s.readOnly && depts.length > 0 && <Button variant="primary" onClick={() => void navigate({ to: "/org/move", search: { ids: depts.map((d) => d.id).join(",") } })}><CornerDownRight size={16} aria-hidden />{t("structure.selection.move")}</Button>}
      {!s.readOnly && one?.kind === "dept" && <Button onClick={() => sheet(one.id, "dept-merge")}><GitMerge size={16} aria-hidden />{t("structure.menu.merge")}</Button>}
      {!s.readOnly && sites && <Link to="/org/workplaces/edit" className="btn"><Rows3 size={16} aria-hidden />{t("structureChart.list.editTogether")}</Link>}
      {!s.readOnly && one && deleteAct && <Button onClick={() => sheet(one.id, deleteAct)}><Trash2 size={16} aria-hidden />{t("structure.selection.delete")}</Button>}
      <Button onClick={() => void nav({ search: (p) => ({ ...p, view: undefined, focus: undefined }) })}><Network size={16} aria-hidden />{t("structure.list.showOnChart")}</Button>
    </>
  );
}

/** A row's order among its siblings (the S2-registry order column): one place up or down, at once in either phase. */
export function OrderCell({ s, n, order }: { s: Structure; n: ChartNode; order: Commands["order"] }) {
  const step = (d: -1 | 1) => orderStep(s, n, d);
  const run = (d: -1 | 1) => order(step(d)!, t(d < 0 ? "orgStructure.order.upDone" : "orgStructure.order.downDone", { name: n.name }));
  if (s.readOnly || (!step(-1) && !step(1))) return null;
  return (
    <span className={css.orderCell}>
      <Button variant="ghost" className={css.chev} disabled={!step(-1)} onClick={() => run(-1)} aria-label={t("orgStructure.order.up", { name: n.name })}><ArrowUp size={14} aria-hidden /></Button>
      <Button variant="ghost" className={css.chev} disabled={!step(1)} onClick={() => run(1)} aria-label={t("orgStructure.order.down", { name: n.name })}><ArrowDown size={14} aria-hidden /></Button>
    </span>
  );
}

/** A department's head in the list; a vacant one opens the department on the chart, where its head is set (S6). */
export function HeadCell({ n, readOnly = false }: { n: ChartNode; readOnly?: boolean }) {
  const nav = route.useNavigate();
  if (n.head) return <>{n.head.name}{n.head.concurrent ? t("structure.list.concurrent") : ""}</>;
  if (readOnly) return <span className="muted">{t("structure.list.vacant")}</span>;
  return (
    <Button variant="ghost" className={css.headPick} onClick={() => void nav({ search: (q) => ({ ...q, view: undefined, focus: undefined, sel: n.id, act: undefined }) })}>
      <span className="muted">{t("structure.list.vacant")}</span> {t("structureChart.list.setHead")}
    </Button>
  );
}
