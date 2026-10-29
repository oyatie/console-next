import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { Field, TextInput } from "../../../ui/field/field";
import type { BoardRow } from "../api";
import { ATTENDANCE_MARK, labeled } from "../../../lib/labels";
import { GLYPH } from "../domain/day";
import { draftState, type Draft } from "../domain/grid";
import { clock } from "../domain/minutes";
import { closed } from "../domain/month-state";
import { problemText, refusalText } from "../present";
import { DayBar } from "./day-bar";
import s from "./records.module.css";

/**
 * One issue row of the day board (A1-day): the mark, the person (a link to the card), the day bar, the sentence, and
 * one verb. A missing clock-out or a missing day is typed in place: the draft waits for the save, which asks for the
 * evidence once for every row. The own row and a closed month's row are read-only.
 */
export function DayRow({ row, draft, onDraft, onOpen, onAssign }: { row: BoardRow; draft?: Draft; onDraft: (value: string | null) => void; onOpen: () => void; onAssign: () => void }) {
  const mark = row.day.marks[0];
  const tone = mark ? labeled(ATTENDANCE_MARK, mark).tone : undefined;
  const start = row.day.entry?.kind === "CLOCK_IN_ONLY" ? row.day.entry.segments[0]?.start : undefined;
  const typed = draft ? (start !== undefined ? draft.value.slice(draft.value.indexOf("-") + 1) : draft.value) : "";
  const state = draft ? draftState(draft, row.day.plan.kind) : null;
  const inline = !row.own && !closed(row.month_state) && (mark === "MISSING_OUT" || mark === "NO_RECORD");
  return (
    <div className={s.boardRow}>
      <span aria-hidden>{tone ? GLYPH[tone] : ""}</span>
      <span>
        <Link from="/attendance" to="." search={(x) => ({ ...x, person: row.employee_id })}>{row.name}</Link> <span className="muted num">{row.employee_number}</span>
        {row.own && <span className="muted"> {t("attendanceRecords.grid.ownTag")}</span>}
      </span>
      <DayBar day={row.day} />
      <span>{mark && <strong>{t(`attendanceRecords.mark.${mark}`)} </strong>}{problemText(row)}</span>
      {row.day.plan.kind === "NO_SCHEDULE" ? (
        <Button size="sm" onClick={onAssign}>{t("attendanceRecords.unscheduled.assign")}</Button>
      ) : inline ? (
        <Field label={t(start !== undefined ? "attendanceRecords.board.out" : "attendanceRecords.board.record", { name: row.name })} required={false} hint={t("attendanceRecords.grammar.hint")} error={state && !state.ok ? refusalText(state.code) : undefined}>
          {(p) => (
            <TextInput
              {...p}
              value={typed}
              maxLength={40}
              placeholder={undefined}
              onChange={(e) => {
                const v = e.target.value.trim();
                onDraft(v ? (start !== undefined ? `${clock(start)}-${v}` : v) : null);
              }}
            />
          )}
        </Field>
      ) : (
        <Button size="sm" onClick={onOpen}>{t("attendanceRecords.board.open")}</Button>
      )}
    </div>
  );
}
