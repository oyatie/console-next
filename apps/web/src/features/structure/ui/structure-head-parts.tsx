// SPDX-License-Identifier: LicenseRef-Proprietary
import type { MouseEvent, ReactNode, RefObject } from "react";
import type { getRouteApi } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { Download, List, ListTree, Network, Upload } from "lucide-react";
import { t } from "@console/i18n";
import { AsOfControl } from "../../../ui/asof-control/asof-control";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Segmented } from "../../../ui/button/segmented";
import { ActionMenu } from "../../../ui/menu/action-menu";
import { SearchField } from "../../../ui/search/search-field";
import type { ChartNode, Structure } from "../domain/model";
import { AddUnit } from "./add-unit";
import { CompareControl } from "./compare-control";
import { ExportDialog } from "./export-dialog";
import { StructureKeys } from "./structure-keys";
import css from "./chart.module.css";

type RouteApi = ReturnType<typeof getRouteApi<"/app/org">>;
type View = "chart" | "list" | "outline";
const VIEWS: { id: View; icon: typeof Network }[] = [
  { id: "chart", icon: Network },
  { id: "list", icon: List },
  { id: "outline", icon: ListTree },
];

type ViewCommands = { find: (step: number) => void; fold: () => void; add: (parent: ChartNode) => void };

export function StructureViewButtons({ view, nav, defaultView = "chart", segmented = false }: { view: View; nav: ReturnType<RouteApi["useNavigate"]>; defaultView?: View; segmented?: boolean }) {
  const onPick = (id: View) => void nav({ search: (search) => ({ ...search, view: id === defaultView ? undefined : id }) });
  if (segmented) {
    return (
      <Segmented
        size="sm"
        label={t("structure.views")}
        value={view}
        onChange={onPick}
        items={VIEWS.map((v) => ({
          id: v.id,
          label: t(`structure.view.${v.id}`),
          icon: <v.icon size={15} aria-hidden />,
        }))}
      />
    );
  }
  return (
    <div role="group" aria-label={t("structure.views")} className={css.views}>
      {VIEWS.map((v) => (
        <Button key={v.id} variant="ghost" aria-pressed={view === v.id} className={css.viewTab} onClick={() => onPick(v.id)}>
          <v.icon size={16} aria-hidden />
          {t(`structure.view.${v.id}`)}
        </Button>
      ))}
    </div>
  );
}

export function StructureScheduledLink({ scheduled }: { scheduled: number }) {
  if (scheduled <= 0) return null;
  return (
    <Link to="/org" search={{ tab: "changes", filter: "ready" }} className={buttonClass("ghost", { size: "sm", className: css.scheduled })} id="org-scheduled">
      {t("orgChange.chip.scheduled", { count: scheduled })}
    </Link>
  );
}

export function StructureToolButtons({
  s,
  view,
  readFailed,
  readOnly,
  imports,
  unavailable,
  exporting,
  setExporting,
}: {
  s?: Structure;
  view: View;
  readFailed: boolean;
  readOnly: boolean;
  imports: { id: string; label: string; onAction: () => void }[];
  unavailable?: { "aria-disabled": true; "aria-describedby": string; onClick: (e: MouseEvent) => void };
  exporting: boolean;
  setExporting: (open: boolean) => void;
}) {
  return (
    <>
      {view !== "list" && <StructureKeys view={view} />}
      <div id="structure-import" tabIndex={-1} className={css.importEntry} data-hidden={imports.length === 0 || (!readFailed && readOnly) || undefined} inert={!readFailed && (readOnly || imports.length === 0) || undefined}>
        {readFailed ? (
          <Button variant="ghost" {...unavailable}><Upload size={16} aria-hidden />{t("structure.import.label")}</Button>
        ) : (
          <ActionMenu label={t("structure.import.label")} trigger={<><Upload size={16} aria-hidden />{t("structure.import.label")}</>} actions={imports} />
        )}
      </div>
      <Button onClick={() => setExporting(true)} disabled={!readFailed && (!s || s.root.children.length === 0)} {...unavailable}>
        <Download size={16} aria-hidden />{t("structure.export.open")}
      </Button>
      {exporting && s && <ExportDialog s={s} onClose={() => setExporting(false)} />}
    </>
  );
}

export function StructureToolbar({
  today,
  value,
  q,
  nav,
  changeDates,
  loadingDates,
  unavailable,
  find,
  onFind,
  commands,
  readOnly,
  orgEdit,
  addTo,
  inline,
  parent,
  trailing,
}: {
  today: string;
  value: string;
  q: ReturnType<RouteApi["useSearch"]>;
  nav: ReturnType<RouteApi["useNavigate"]>;
  changeDates?: readonly string[];
  loadingDates?: boolean;
  unavailable?: { "aria-disabled": true; "aria-describedby": string; onClick: (e: MouseEvent) => void };
  find: string;
  onFind: (q: string) => void;
  commands: RefObject<ViewCommands | null>;
  readOnly: boolean;
  orgEdit: boolean;
  addTo?: ChartNode;
  inline: boolean;
  parent?: ChartNode;
  trailing?: ReactNode;
}) {
  return (
    <>
      <div className="row" role="group" aria-label={t("structure.toolbar")}>
        <AsOfControl
          today={today}
          value={value}
          knownAt={q.known_at}
          onChange={(date, known_at) => void nav({ search: (search) => ({ ...search, as_of: date === today ? undefined : date, known_at, compare_a: undefined, compare_b: undefined, act: undefined }) })}
          changeDates={changeDates}
          loadingDates={loadingDates}
        />
        <CompareControl unavailable={unavailable} />
        <SearchField
          className={css.toolbarFind}
          id="structure-find"
          label={t("structure.find.label")}
          title={t("structure.find.placeholder")}
          value={find}
          onChange={onFind}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            const step = { Enter: 0, ArrowDown: 1, ArrowUp: -1 }[e.key];
            if (step !== undefined) {
              e.preventDefault();
              commands.current?.find(step);
            }
            if (e.key === "Escape") onFind("");
          }}
        />
        <Button variant="ghost" onClick={() => commands.current?.fold()} {...unavailable}>{t("structure.collapseAll")}</Button>
        {!readOnly && orgEdit && addTo && <AddUnit n={addTo} onAdd={inline ? () => commands.current?.add(addTo) : undefined} />}
      </div>
      {value > today && !q.known_at && !q.compare_a && parent?.unitId && (
        <Button onClick={() => void nav({ search: (search) => ({ ...search, act: "create", sel: parent.unitId, kind: "DEPARTMENT" }) })}>{t("asof.create")}</Button>
      )}
      {trailing ? <><span className="grow" />{trailing}</> : null}
    </>
  );
}
