// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Band } from "../band/band";
import { Button } from "../button/button";
import { PaneHead } from "../pane-grid/pane-grid";
import s from "./month-grid-parts.module.css";

/** Scrollable side-pane dock container with an anchored bottom band for `SaveDock` / `DayDock` inside `PaneGrid`. */
export function MonthGridPaneBody({
  pending,
  children,
  footer,
}: {
  pending?: boolean;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className={s.paneDock}>
      <div className={s.paneDockBody} inert={pending || undefined}>
        {children}
      </div>
      <Band edge="top" tone="canvas" className={s.paneDockFoot}>
        {footer}
      </Band>
    </div>
  );
}

/** Padded empty state container for the lower split issues column. */
export function MonthGridEmptyCell({ children }: { children: ReactNode }) {
  return <div className={s.empty}>{children}</div>;
}

/**
 * Collapsible lower split panel for `MonthGridPattern` (`P5`): exceptions table on the start side and
 * recognition basis + mark legend on the end side, collapsing cleanly to a single bar on phone viewports.
 */
export function MonthGridBottomSplit({
  toggleLabel,
  expandLabel,
  collapseLabel,
  issuesTitle,
  issuesMeta,
  issuesContent,
  basisTitle,
  basisText,
  legendItems,
}: {
  toggleLabel: ReactNode;
  expandLabel: string;
  collapseLabel: string;
  issuesTitle: ReactNode;
  issuesMeta?: ReactNode;
  issuesContent: ReactNode;
  basisTitle: ReactNode;
  basisText: ReactNode;
  legendItems: readonly { key: string; glyph: ReactNode; text: ReactNode }[];
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className={s.wrap}>
      <div className={s.phoneBar}>
        <bdi className={s.phoneSummary}>{toggleLabel}</bdi>
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(v => !v)}>
          {open ? collapseLabel : expandLabel}
          {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronUp size={14} aria-hidden="true" />}
        </Button>
      </div>
      <div className={s.split} data-open={open || undefined}>
        <div className={s.col}>
          <PaneHead title={issuesTitle} meta={issuesMeta} />
          {issuesContent}
        </div>
        <div className={s.col}>
          <PaneHead title={basisTitle} />
          <div className={s.basisCallout}>
            <bdi className="t-xs t-medium">{basisText}</bdi>
          </div>
          <div className={s.legendGrid}>
            {legendItems.map(item => (
              <div key={item.key} className={s.legendItem}>
                <bdi aria-hidden="true">{item.glyph}</bdi>
                <bdi>{item.text}</bdi>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
