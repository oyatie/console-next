// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { PaneGrid } from "../pane-grid/pane-grid";
import type { SidePaneSpec } from "../pane-grid/pane-grid-side";
import { PatternShell } from "./pattern-shell";
import { shownSlot } from "./pattern-slot";
import type { DocumentDecisionProps } from "./document-decision-contract";
import s from "./document-decision.module.css";

const isSidePane = (value: SidePaneSpec | ReactNode | false | null | undefined): value is SidePaneSpec =>
  typeof value === "object" && value !== null && "id" in value && "onClose" in value && "label" in value;

/**
 * DocumentDecision (`P4`) arrangement: optional `start` rail (facts/chain/attachments or queue), center `document`
 * body, and right-hand `decision` (`SidePaneSpec` in `PaneGrid` or docked `<aside>`).
 */
export function DocumentDecision({
  q,
  head,
  tabs,
  notes,
  start,
  document,
  decision,
  decisionLabel,
  foot,
  facts: _facts,
  overlays,
  statusSegments,
  baseline,
  ...panes
}: DocumentDecisionProps) {
  const paneDecision = isSidePane(decision) ? decision : undefined;
  const dockedCandidate: ReactNode = isSidePane(decision) ? null : decision;
  const dockedDecision = shownSlot(dockedCandidate) ? dockedCandidate : null;

  return (
    <PatternShell
      pattern="document-decision"
      floorplan="P-02"
      q={q}
      head={head}
      tabs={tabs}
      overlays={overlays}
      queryLayout="record"
      detailActive={Boolean(paneDecision)}
      statusSegments={statusSegments}
      baseline={baseline}
    >
      {() => (
        <div className={s.workspace} data-docked-decision={Boolean(dockedDecision) || undefined}>
          <div className={s.paneWrap}>
            <PaneGrid
              {...panes}
              start={start}
              record={paneDecision}
              main={
                <div className={s.docCol}>
                  {notes}
                  {document}
                  {foot}
                </div>
              }
            />
          </div>
          {dockedDecision ? (
            <aside className={s.decisionAside} aria-label={decisionLabel}>
              {dockedDecision}
            </aside>
          ) : null}
        </div>
      )}
    </PatternShell>
  );
}
