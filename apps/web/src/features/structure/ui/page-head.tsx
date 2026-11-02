import { useId, useState, type MouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { Download, List, ListTree, Network, Upload } from "lucide-react";
import { t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { ActionMenu } from "../../../ui/menu/action-menu";
import type { Structure } from "../domain/model";
import { get } from "../../../lib/query";
import { authzApplies, authzQuery, granted, type Feature } from "../../../reference/authz/api";
import { checklistRef } from "../../../reference/entity/api";
import { AsOfControl } from "../../../ui/asof-control/asof-control";
import { CompareControl } from "./compare-control";
import { AddUnit } from "./add-unit";
import { StructureKeys } from "./structure-keys";
import { ExportDialog } from "./export-dialog";
import type { Commands } from "./use-structure-commands";
import css from "./chart.module.css";

const route = getRouteApi("/app/org");
type View = "chart" | "list" | "outline";
const VIEWS: { id: View; icon: typeof Network }[] = [
  { id: "chart", icon: Network },
  { id: "list", icon: List },
  { id: "outline", icon: ListTree },
];

/**
 * The page head: the org chart · list · outline switch, the phase, as-of date with the scheduled changes beside it (org-26), the change list and
 * history as a visible entry (org-26); the receipt of a change made from the chart sits in the chart's gutter (org-19).
 */
export function PageHead({ s, view, cmd, changeDates, loadingDates, readFailed = false }: {
  s?: Structure; view: View; cmd: Commands; changeDates?: readonly string[]; loadingDates?: boolean; readFailed?: boolean;
}) {
  const reasonId = useId();
  const unavailable = readFailed ? { "aria-disabled": true as const, "aria-describedby": reasonId, onClick: (e: MouseEvent) => e.preventDefault() } : undefined;
  const nav = route.useNavigate();
  const navigate = useNavigate();
  const q = route.useSearch();
  const today = todayKst();
  const value = q.compare_b ?? q.as_of ?? today;
  const readOnly = cmd.readOnly;
  const firstRun = s?.phase === "SETUP" && s.root.children.length === 0 && !s.readOnly;
  const selected = s?.byId.get(q.sel ?? "");
  const parent = selected?.kind === "site" ? selected : selected?.siteId ? s?.byId.get(selected.siteId) : s?.root.children[0]?.children[0];
  const [exporting, setExporting] = useState(false);
  const checklist = useQuery(checklistRef);
  const phase = (s?.phase ?? checklist.data?.phase) === "OPERATING" ? "operating" : "setup";
  const authz = useQuery({ ...authzQuery, enabled: authzApplies() });
  // Until the grants land every verb is drawn (as before), so a holder's head never moves when they arrive; a reader's
  // verbs then leave (people-self-37).
  const can = (f: Feature, scope?: "tenant") => authz.isPending || granted(authz.data?.capabilities, authz.isError)(f, scope);
  const orgEdit = can("org_change_draft") || can("org_change_apply");
  const imports = [
    ...(orgEdit
      ? [
          { id: "sheet", label: t("orgBulk.links.import"), onAction: () => void navigate({ to: "/org/import" }) },
          { id: "paste", label: t("orgBulk.links.paste"), onAction: () => void navigate({ to: "/org/paste" }) },
          { id: "edit", label: t("orgBulk.links.edit"), onAction: () => void navigate({ to: "/org/workplaces/edit" }) },
        ]
      : []),
    ...(can("employee_directory_manage", "tenant") ? [{ id: "roster", label: t("structure.import.roster"), onAction: () => void navigate({ to: "/people/import" }) }] : []),
  ];
  // Scheduled = approved and waiting for its date (the change list's scheduled view); its count only.
  const scheduled = useQuery({ ...get("/api/v1/org-changes", { params: { query: { status: ["APPROVED"], limit: 1 } } }), enabled: phase === "operating" }).data?.total ?? 0;
  return (
    <>
    <div className={`page__head ${css.head}`}>
      <div role="group" aria-label={t("structure.views")} className={css.views}>
        {VIEWS.map((v) => (
          <Button key={v.id} variant="ghost" aria-pressed={view === v.id} className={css.viewTab} onClick={() => void nav({ search: (search) => ({ ...search, view: v.id === "chart" ? undefined : v.id }) })}>
            <v.icon size={16} aria-hidden />
            {t(`structure.view.${v.id}`)}
          </Button>
        ))}
      </div>
      {(readFailed || phase === "operating") && <p id={reasonId} className={css.phase} aria-hidden={!s && !readFailed || undefined} data-loading={!s && !readFailed || undefined} data-failed={readFailed || undefined}>
        {(readFailed || phase === "operating") && <span aria-hidden={readFailed || undefined}>{t("structure.phase.operatingChip")}</span>}
        {readFailed && <span className={css.phaseError}>{t("structure.readFailed")}</span>}
      </p>}
      {!readOnly && orgEdit && selected?.kind === "entity" && <AddUnit n={selected} primary />}
      <span className="grow" />
      {view !== "list" && <StructureKeys view={view} />}
      {scheduled > 0 && <Link to="/org" search={{ tab: "changes", filter: "ready" }} className={buttonClass("ghost", { size: "sm", className: css.scheduled })} id="org-scheduled">{t("orgChange.chip.scheduled", { count: scheduled })}</Link>}
      <div id="structure-import" tabIndex={-1} className={css.importEntry} data-hidden={imports.length === 0 || (!readFailed && readOnly) || undefined} inert={!readFailed && (readOnly || imports.length === 0) || undefined}>
        {readFailed ? <Button variant="ghost" {...unavailable}><Upload size={16} aria-hidden />{t("structure.import.label")}</Button>
          : <ActionMenu label={t("structure.import.label")} trigger={<><Upload size={16} aria-hidden />{t("structure.import.label")}</>} actions={imports} />}
      </div>
      <Button onClick={() => setExporting(true)} disabled={!readFailed && (!s || s.root.children.length === 0)} {...unavailable}><Download size={16} aria-hidden />{t("structure.export.open")}</Button>
      {exporting && s && <ExportDialog s={s} onClose={() => setExporting(false)} />}
      {cmd.pending && <span className="sr-only" role="status">{t("structure.saving")}</span>}
    </div>
    {!firstRun && <div className="row">
    <AsOfControl today={today} value={value} knownAt={q.known_at} onChange={(date, known_at) => void nav({ search: (search) => ({ ...search, as_of: date === today ? undefined : date, known_at, compare_a: undefined, compare_b: undefined, act: undefined }) })} changeDates={changeDates} loadingDates={loadingDates} />
    <CompareControl unavailable={unavailable} />
    </div>}
    {value > today && !q.known_at && !q.compare_a && parent?.unitId && <Button onClick={() => void nav({ search: (search) => ({ ...search, act: "create", sel: parent.unitId, kind: "DEPARTMENT" }) })}>{t("asof.create")}</Button>}
    </>
  );
}
