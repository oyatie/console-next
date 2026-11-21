// SPDX-License-Identifier: LicenseRef-Proprietary
import { ActionBar } from "../action-bar/action-bar";
import { PatternShell } from "./pattern-shell";
import { shownSlot } from "./pattern-slot";
import type { WizardPatternProps } from "./wizard-contract";
import s from "./wizard.module.css";

/**
 * Wizard (`P8`) arrangement: `PageHead`, optional `steps` bar (`StepLine`), primary step `body` with optional `aside`
 * reference column, and sticky or inline `ActionBar`.
 */
export function WizardPattern({
  q,
  head,
  tabs,
  steps,
  notes,
  body,
  aside,
  asideLabel,
  consequence,
  notice,
  actions,
  stickyActions = true,
  foot,
  facts: _facts,
  overlays,
  statusSegments,
  baseline,
}: WizardPatternProps) {
  const hasAside = shownSlot(aside);
  return (
    <PatternShell
      pattern="wizard"
      floorplan="P-04"
      q={q}
      head={head}
      tabs={tabs}
      overlays={overlays}
      queryLayout="form"
      statusSegments={statusSegments}
      baseline={baseline}
    >
      {() => (
        <div className={s.shell}>
          {shownSlot(steps) ? <div className={s.stepsBar}>{steps}</div> : null}
          <div className={s.workspace} data-has-aside={hasAside || undefined}>
            <div className={s.mainCol}>
              {notes}
              <div className={s.body}>{body}</div>
              {foot}
            </div>
            {hasAside ? (
              asideLabel ? (
                <aside className={s.asideCol} aria-label={asideLabel}>
                  {aside}
                </aside>
              ) : (
                <div className={s.asideCol}>{aside}</div>
              )
            ) : null}
          </div>
          <div className={s.actionWrap}>
            <ActionBar consequence={consequence} notice={notice} actions={actions} sticky={stickyActions} />
          </div>
        </div>
      )}
    </PatternShell>
  );
}
