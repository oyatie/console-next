import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTimeShort } from "@console/i18n/format";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { reasonCodesQuery, reasonLabel, useNeedsNote } from "../../../lib/reason-codes";
import { ReasonCodeField } from "../../../reference/reason/ui/reason-code-field";
import { ActionBar } from "../../../ui/action-bar/action-bar";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { SectionHead } from "../../../ui/card/section-head";
import { DateField } from "../../../ui/date/date-field";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Field, TextInput } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { Table } from "../../../ui/table";
import { changeNumber, historyQuery, NOTE_MAX, NUMBER_MAX } from "../api";
import { changeProblem } from "../domain/numbering";
import { identifiersError } from "../present";

type Employee = components["schemas"]["Employee"];
const DOMAIN = "employee_number_change";

/**
 * The employee number: the one in force (or that none was given), a change with an effective date (today or earlier)
 * and a reason, and every change so far. The old number stays the person's alias: it still finds them and is never
 * handed to anyone else.
 */
export function NumberCard({ employee }: { employee: Employee }) {
  const history = useQuery(historyQuery(employee.id));
  // The reasons are read with the card, so the form opens whole instead of growing under the pointer.
  useQuery(reasonCodesQuery(DOMAIN));
  const [open, setOpen] = useState(false);
  const current = employee.employee_number ?? null;
  return (
    <Card
      title={t("identifiers.number.title")}
      meta={<span className="code">{current ?? t("identifiers.number.none")}</span>}
      tools={<Button aria-expanded={open} onClick={() => setOpen(!open)}>{t(current ? "identifiers.number.change" : "identifiers.number.give")}</Button>}
    >
      <p className="muted">{t("identifiers.number.why")}</p>
      {open && <ChangeForm employee={employee} onDone={() => setOpen(false)} />}
      <SectionHead>{t("identifiers.history.title")}</SectionHead>
      {(history.data ?? []).length === 0 ? (
        <p className="muted">{t("identifiers.history.none")}</p>
      ) : (
        <Table
          label={t("identifiers.history.title")}
          rows={history.data ?? []}
          rowId={(c) => c.id}
          columns={[
            { header: t("identifiers.history.col.effective"), cell: (c) => <span className="num">{fmtDate(c.effective_date)}</span>, fit: true },
            { header: t("identifiers.history.col.change"), cell: (c) => <span className="code">{t("identifiers.history.change", { from: c.from_number ?? t("identifiers.number.none"), to: c.to_number })}</span> },
            { header: t("identifiers.history.col.reason"), cell: (c) => reasonLabel(DOMAIN, c.reason_code) },
            { header: t("identifiers.history.col.state"), cell: (c) => (c.undone_at ? t("identifiers.history.undone", { at: fmtDateTimeShort(c.undone_at) }) : c.batch_id ? t("identifiers.history.batch") : t("identifiers.history.one")), wide: true },
          ]}
        />
      )}
    </Card>
  );
}

function ChangeForm({ employee, onDone }: { employee: Employee; onDone: () => void }) {
  const today = todayKst();
  const [next, setNext] = useState("");
  const [date, setDate] = useState("");
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const needsNote = useNeedsNote(DOMAIN, reason);
  const problem = changeProblem({ current: employee.employee_number ?? null, next, date, today, reason, needsNote, note });
  const save = useCommand({
    run: () =>
      changeNumber(employee.id, {
        new_number: next.trim(),
        effective_date: date,
        reason_code: reason!,
        ...(note.trim() ? { note: note.trim() } : {}),
        expected_updated_at: employee.updated_at,
      }),
    invalidates: ["/api/v1/employees"],
    announce: (c) => t("identifiers.number.done", { number: c.to_number }),
    onSuccess: onDone,
  });
  const go = t("identifiers.number.save");
  return (
    <div className="form">
      <Field label={t("identifiers.number.new")} required >
        {(p) => <TextInput {...p} value={next} maxLength={NUMBER_MAX} onChange={(e) => setNext(e.target.value)} />}
      </Field>
      <DateField label={t("identifiers.number.effective")} required value={date} onChange={setDate} today={today} max={today}  />
      <ReasonCodeField domain={DOMAIN} label={t("identifiers.number.reason")} value={reason} onChange={setReason} />
      {needsNote && (
        <Field label={t("identifiers.number.note")} required>
          {(p) => <TextArea {...p} value={note} maxLength={NOTE_MAX} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      )}
      <ActionBar
        actions={
          <>
            <Button onClick={onDone}>{t("identifiers.cancel")}</Button>
            {problem ? (
              <DisabledReason control={(p) => <Button {...p} variant="primary">{go}</Button>} reason={t(`identifiers.number.problem.${problem}`)} />
            ) : (
              <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate(undefined)}>{go}</Button>
            )}
          </>
        }
      />
      {/* Under the actions: a refusal lands without moving the button just pressed. */}
      <CommandError error={save.error} own={identifiersError} />
    </div>
  );
}
