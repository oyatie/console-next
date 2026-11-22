// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { PaneGrid } from "../pane-grid/pane-grid";
import type { SidePaneSpec } from "../pane-grid/pane-grid-side";
import { PatternShell } from "./pattern-shell";
import { shownSlot } from "./pattern-slot";
import type { CanvasPatternProps } from "./canvas-contract";
import s from "./canvas.module.css";

const isSidePane = (value: SidePaneSpec | ReactNode | false | null | undefined): value is SidePaneSpec =>
  typeof value === "object" && value !== null && !("$$typeof" in value) && "id" in value && "onClose" in value && "label" in value;

/**
 * Canvas (`P10`) arrangement: optional `toolbar` strip, viewport-locked `canvas` stage inside `PaneGrid`, and
 * optional `inspector` (`SidePaneSpec` or docked `<aside>`).
 */
export function CanvasPattern({
  q,
  head,
  tabs,
  toolbar,
  notes,
  canvas,
  inspector,
  inspectorLabel,
  foot,
  facts: _facts,
  overlays,
  statusSegments,
  keepOnLoss,
  back,
  own,
  baseline,
  ...panes
}: CanvasPatternProps) {
  const paneInspector = isSidePane(inspector) ? inspector : undefined;
  const dockedCandidate: ReactNode = isSidePane(inspector) ? null : inspector;
  const dockedInspector = shownSlot(dockedCandidate) ? dockedCandidate : null;

  return (
    <PatternShell
      pattern="canvas"
      floorplan="canvas"
      q={q}
      head={head}
      tabs={tabs}
      overlays={overlays}
      queryLayout="grid"
      detailActive={Boolean(paneInspector)}
      statusSegments={statusSegments}
      keepOnLoss={keepOnLoss}
      back={back}
      own={own}
      baseline={baseline}
    >
      {() => (
        <div className={s.shell} data-docked-inspector={Boolean(dockedInspector) || undefined}>
          {shownSlot(toolbar) ? <div className={s.toolbar}>{toolbar}</div> : null}
          <div className={s.stageArea}>
            <div className={s.paneWrap}>
              <PaneGrid
                {...panes}
                record={paneInspector}
                main={
                  <div className={s.workspace}>
                    {notes}
                    <div className={s.canvasHost}>{canvas}</div>
                    {foot}
                  </div>
                }
              />
            </div>
            {dockedInspector ? (
              <aside className={s.inspectorAside} aria-label={inspectorLabel}>
                {dockedInspector}
              </aside>
            ) : null}
          </div>
        </div>
      )}
    </PatternShell>
  );
}
