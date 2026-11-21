// SPDX-License-Identifier: LicenseRef-Proprietary
import { ActionBar } from "../action-bar/action-bar";
import { Form } from "../button/button";
import { shown } from "../shown";
import { PatternShell } from "./pattern-shell";
import type { FormPatternProps } from "./form-contract";
import s from "./form.module.css";

/**
 * Form (`P7`) arrangement: `PagePhoneHeader`-aware head, optional `summary` band, ruled `sections` inside `Form`,
 * and sticky or inline `ActionBar`.
 */
export function FormPattern({
  q,
  head,
  tabs,
  summary,
  notes,
  sections,
  notice,
  consequence,
  actions,
  onSubmit,
  formId,
  noValidate,
  stickyActions = true,
  foot,
  facts: _facts,
  overlays,
  statusSegments,
  baseline,
}: FormPatternProps) {
  return (
    <PatternShell
      pattern="form"
      floorplan="P-04"
      q={q}
      head={head}
      tabs={tabs}
      overlays={overlays}
      queryLayout="form"
      phoneHeadAware
      statusSegments={statusSegments}
      baseline={baseline}
    >
      {() => (
        <div className={s.column}>
          {shown(summary) ? <div className={s.summary}>{summary}</div> : null}
          <Form id={formId} noValidate={noValidate} onSubmit={onSubmit} className={s.form}>
            {notes}
            <div className={s.sections}>{sections}</div>
            <ActionBar consequence={consequence} notice={notice} actions={actions} sticky={stickyActions} />
            {foot}
          </Form>
        </div>
      )}
    </PatternShell>
  );
}
