// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import type { ReadState } from "../../../lib/react/query-view";
import { HeadcountBasis } from "../../../reference/org/ui/headcount-basis";
import { Segmented } from "../../../ui/button/segmented";
import { Chip } from "../../../ui/chip";
import { useNarrow } from "../../../ui/dock-sheet/use-narrow";
import { EmptyState } from "../../../ui/empty-state";
import type { SidePaneSpec } from "../../../ui/pane-grid/pane-grid-side";
import { CanvasPattern } from "../../../ui/patterns/canvas";
import type { Depth } from "../domain/layout";
import type { ChartNode, Structure } from "../domain/model";
import { ChartView } from "./chart-view";
import { CompareResults } from "./compare-control";
import { RegistryExportContext } from "./export-scope";
import { FirstRun } from "./first-run";
import { useOrgHeadSlot } from "./use-org-head-slot";
import { OutlineView } from "./outline-view";
import { StructureAuthz, type ViewCommands } from "./page-head";
import { RegistryView } from "./registry-view";
import { StructureScheduledLink, StructureToolbar, StructureToolButtons, StructureViewButtons } from "./structure-head-parts";
import { useStructureHeadMeta } from "./use-structure-head";
import type { Commands } from "./use-structure-commands";

type View = "chart" | "list" | "outline";
const DEPTHS: readonly Depth[] = ["sites", "one", "all"];

export function StructureConsole({
  s,
  view,
  cmd,
  pageRead,
  dates,
  diff,
  find,
  onFind,
  commands,
  inline,
  focus,
  act,
  jump,
  sel,
  onSelect,
  onFocus,
  proposing,
  proposal,
  side,
  sheets,
}: {
  s?: Structure;
  view?: View;
  cmd: Commands;
  pageRead: ReadState;
  dates: ReadState<{ items: string[] }> & { isFetching?: boolean };
  diff: components["schemas"]["StructureDiff"] | undefined;
  find: string;
  onFind: (q: string) => void;
  commands: RefObject<ViewCommands | null>;
  inline: boolean;
  focus?: string;
  act?: string;
  jump?: { id: string; n: number };
  sel: ReadonlySet<string>;
  onSelect: (next: ReadonlySet<string>, gather?: boolean) => void;
  onFocus: (id: string | undefined) => void;
  proposing: boolean;
  proposal: ReactNode;
  side?: SidePaneSpec | false;
  sheets: ReactNode;
}) {
  const defaultView: View = "chart";
  const activeView: View = view ?? defaultView;
  const narrow = useNarrow();
  const stacked = activeView === "chart" && narrow;
  const headSlot = useOrgHeadSlot();
  const [exportRows, setExportRows] = useState<readonly ChartNode[] | null>(null);
  const focusKey = focus ?? "tenant";
  const [depthByFocus, setDepthByFocus] = useState<Record<string, Depth>>({});
  const depth = depthByFocus[focusKey] ?? (focus ? "one" : "sites");
  const handleDepth = (d: Depth) => setDepthByFocus((prev) => (prev[focusKey] === d ? prev : { ...prev, [focusKey]: d }));

  const readFailed = !pageRead.data && Boolean(pageRead.error);
  const m = useStructureHeadMeta({ s, cmd, readFailed });
  const empty = s && s.root.children.length === 0;
  const focusNode = s ? ((focus && s.byId.get(focus)) || s.root) : undefined;

  const headFilters = <StructureViewButtons view={activeView} defaultView={defaultView} nav={m.nav} segmented />;
  const headMeta = (
    <>
      {(readFailed || m.phase === "operating") && (
        <span id={m.reasonId}>
          <Chip tone={readFailed ? "danger" : "info"}>
            {t(readFailed ? "structure.readFailed" : "structure.phase.operatingChip")}
          </Chip>
        </span>
      )}
      <StructureScheduledLink scheduled={m.scheduled} />
    </>
  );

  return (
    <RegistryExportContext.Provider value={activeView === "list" ? exportRows : null}>
      <StructureAuthz>
        {({ orgEdit, imports }) => {
          const headTools = (
            <StructureToolButtons
              s={s}
              view={activeView}
              readFailed={readFailed}
              readOnly={m.readOnly}
              imports={imports}
              unavailable={m.unavailable}
              exporting={m.exporting}
              setExporting={m.setExporting}
            />
          );
          return (
            <>
              {headSlot ? createPortal(<>{headMeta}{headFilters}{headTools}</>, headSlot) : null}
              <CanvasPattern
                q={pageRead}
                head={
                  headSlot
                    ? { title: t(`structure.view.${activeView}`) }
                    : {
                        title: t(`structure.view.${activeView}`),
                        filters: headFilters,
                        meta: headMeta,
                        tools: headTools,
                      }
                }
                toolbar={
                  !m.firstRun ? (
                    <StructureToolbar
                      today={m.today}
                      value={m.value}
                      q={m.q}
                      nav={m.nav}
                      changeDates={dates.data?.items}
                      loadingDates={Boolean(dates.isFetching)}
                      unavailable={m.unavailable}
                      find={find}
                      onFind={onFind}
                      commands={commands}
                      readOnly={m.readOnly}
                      orgEdit={orgEdit}
                      addTo={m.addTo}
                      inline={inline}
                      parent={m.parent}
                      trailing={
                        activeView === "chart" ? (
                          <div className="row">
                            {focusNode ? <HeadcountBasis>{t("structure.headcount.total", { count: focusNode.headcount })}</HeadcountBasis> : null}
                            <Segmented
                              size="sm"
                              label={t("structure.depth.label")}
                              value={depth}
                              onChange={handleDepth}
                              items={DEPTHS.map((d) => ({ id: d, label: t(`structure.depth.${d}`) }))}
                            />
                          </div>
                        ) : undefined
                      }
                    />
                  ) : undefined
                }
                notes={!pageRead.error && dates.error ? <QueryState q={dates} inline own={() => t("asof.error")}>{() => null}</QueryState> : undefined}
                toolbarOnInitialLoad
                canvas={
                  !s ? null : empty ? (
                    s.readOnly ? <EmptyState title={t("asof.noRecords")} reason={null} /> : <FirstRun />
                  ) : activeView === "list" ? (
                    <RegistryView compact ref={commands} find={find} s={s} cmd={cmd} sel={sel} onSelect={onSelect} onVisibleRows={setExportRows} />
                  ) : activeView === "outline" ? (
                    <OutlineView ref={commands} find={find} follow={!act} pick={jump} s={s} cmd={cmd} sel={sel} onSelect={onSelect} />
                  ) : (
                    <ChartView
                      ref={commands}
                      find={find}
                      key={focus ?? "tenant"}
                      pick={jump}
                      covered={Boolean(act)}
                      dimmed={Boolean(pageRead.error)}
                      s={s}
                      cmd={cmd}
                      focusId={focus}
                      onFocus={onFocus}
                      sel={sel}
                      onSelect={onSelect}
                      depth={depth}
                      onDepth={handleDepth}
                      consoleChrome
                    />
                  )
                }
                inspector={proposing ? proposal : stacked ? (side ? side.children : null) : side}
                inspectorLabel={proposing ? t("structure.side") : stacked ? undefined : side ? side.label : t("structure.side")}
                foot={diff ? <CompareResults result={diff} /> : undefined}
                overlays={!cmd.readOnly ? sheets : undefined}
                statusSegments={
                  s
                    ? [
                        { id: "scope", tone: "strong", content: s.root.name },
                        { id: "counts", content: t("structure.list.caption", { count: s.counts.entities + s.counts.sites + s.counts.depts }) },
                      ]
                    : undefined
                }
              />
            </>
          );
        }}
      </StructureAuthz>
    </RegistryExportContext.Provider>
  );
}
