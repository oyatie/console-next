// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode, RefObject } from "react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import type { ReadState } from "../../../lib/react/query-view";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import type { SidePaneSpec } from "../../../ui/pane-grid/pane-grid-side";
import { CanvasPattern } from "../../../ui/patterns/canvas";
import type { ChartNode, Structure } from "../domain/model";
import { ChartView } from "./chart-view";
import { CompareResults } from "./compare-control";
import { FirstRun } from "./first-run";
import { OutlineView } from "./outline-view";
import { StructureAuthz, type ViewCommands } from "./page-head";
import { RegistryView } from "./registry-view";
import { StructureScheduledLink, StructureToolbar, StructureToolButtons, StructureViewButtons } from "./structure-head-parts";
import { useStructureHeadMeta } from "./use-structure-head";
import type { Commands } from "./use-structure-commands";

type View = "chart" | "list" | "outline";

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
  onVisibleRows,
}: {
  s?: Structure;
  view: View;
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
  onVisibleRows: (rows: readonly ChartNode[] | null) => void;
}) {
  const readFailed = !pageRead.data && Boolean(pageRead.error);
  const m = useStructureHeadMeta({ s, cmd, readFailed });
  const empty = s && s.root.children.length === 0;

  return (
    <StructureAuthz>
      {({ orgEdit, imports }) => (
        <CanvasPattern
          q={pageRead}
          head={{
            title: t(`structure.view.${view}`),
            filters: <StructureViewButtons view={view} nav={m.nav} />,
            meta: (
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
            ),
            tools: (
              <StructureToolButtons
                s={s}
                view={view}
                readFailed={readFailed}
                readOnly={m.readOnly}
                imports={imports}
                unavailable={m.unavailable}
                exporting={m.exporting}
                setExporting={m.setExporting}
              />
            ),
          }}
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
              />
            ) : undefined
          }
          notes={!pageRead.error && dates.error ? <QueryState q={dates} inline own={() => t("asof.error")}>{() => null}</QueryState> : undefined}
          canvas={
            !s ? null : empty ? (
              s.readOnly ? <EmptyState title={t("asof.noRecords")} reason={null} /> : <FirstRun />
            ) : view === "list" ? (
              <RegistryView compact ref={commands} find={find} s={s} cmd={cmd} sel={sel} onSelect={onSelect} onVisibleRows={onVisibleRows} />
            ) : view === "outline" ? (
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
              />
            )
          }
          inspector={proposing ? proposal : side}
          inspectorLabel={t("structure.side")}
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
      )}
    </StructureAuthz>
  );
}
