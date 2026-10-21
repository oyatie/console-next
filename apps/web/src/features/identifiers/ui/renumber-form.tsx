import { useState } from "react";
import { t } from "@console/i18n";
import { useNeedsNote } from "../../../lib/reason-codes";
import { ReasonCodeField } from "../../../reference/reason/ui/reason-code-field";
import { ActionBar } from "../../../ui/action-bar/action-bar";
import { Button } from "../../../ui/button/button";
import { DateField } from "../../../ui/date/date-field";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Field, TextInput } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { TextArea } from "../../../ui/field/text-area";
import { NOTE_MAX, type RenumberRequest } from "../api";
import { ruleProblem, sample, scopeKey, WIDTH, type Scope } from "../domain/numbering";

const DOMAIN = "employee_number_change";
const WIDTHS = Array.from({ length: WIDTH.max - WIDTH.min + 1 }, (_, i) => WIDTH.min + i);

/** Which people (a scope), the new scheme, when and why: what a renumbering preview asks the server for. */
export function RenumberForm({ scopes, today, busy, onPreview, onEdit }: {
  scopes: readonly Scope[];
  today: string;
  busy: boolean;
  onPreview: (r: RenumberRequest) => void;
  onEdit: () => void;
}) {
  const [scope, setScope] = useState<string>("");
  const [prefix, setPrefix] = useState("");
  const [width, setWidth] = useState(4);
  const [date, setDate] = useState("");
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const needsNote = useNeedsNote(DOMAIN, reason);
  const edit = <T,>(set: (v: T) => void) => (v: T) => (set(v), onEdit());
  const chosen = scopes.find((s) => scopeKey(s) === scope);
  const rule = ruleProblem(prefix, width);
  const problem =
    !chosen ? t("identifiers.renumber.problem.scope")
    : rule ? t(`identifiers.rules.problem.${rule}`)
    : !date ? t("identifiers.renumber.problem.date")
    : date > today ? t("identifiers.renumber.problem.future")
    : !reason ? t("identifiers.renumber.problem.reason")
    : needsNote && !note.trim() ? t("identifiers.renumber.problem.note")
    : null;
  const go = t("identifiers.renumber.preview");
  const request = (): RenumberRequest => ({
    scope_kind: chosen!.kind,
    ...(chosen!.id ? { scope_id: chosen!.id } : {}),
    prefix,
    width,
    effective_date: date,
    reason_code: reason!,
    ...(note.trim() ? { note: note.trim() } : {}),
  });
  return (
    <div className="form">
      <Field label={t("identifiers.renumber.scope")} required>
        {(p) => (
          <SelectInput {...p} value={scope} onChange={(e) => edit(setScope)(e.target.value)}>
            <option value="" disabled>{t("identifiers.renumber.scopePick")}</option>
            {scopes.map((s) => <option key={scopeKey(s)} value={scopeKey(s)}>{s.label}</option>)}
          </SelectInput>
        )}
      </Field>
      <Field label={t("identifiers.renumber.prefix")} required={false} hint={t("identifiers.rules.prefixHint")}>
        {(p) => <TextInput {...p} value={prefix} maxLength={16} onChange={(e) => edit(setPrefix)(e.target.value)} />}
      </Field>
      <Field label={t("identifiers.renumber.width")} required>
        {(p) => (
          <SelectInput {...p} value={String(width)} onChange={(e) => edit(setWidth)(Number(e.target.value))}>
            {WIDTHS.map((w) => <option key={w} value={w}>{t("identifiers.rules.digits", { count: w })}</option>)}
          </SelectInput>
        )}
      </Field>
      {!rule && <p className="muted">{t("identifiers.rules.sample", { sample: sample(prefix, width) })}</p>}
      <DateField label={t("identifiers.renumber.effective")} required value={date} onChange={edit(setDate)} today={today} max={today} />
      <ReasonCodeField domain={DOMAIN} label={t("identifiers.renumber.reason")} value={reason} onChange={edit(setReason)} />
      {needsNote && (
        <Field label={t("identifiers.number.note")} required>
          {(p) => <TextArea {...p} value={note} maxLength={NOTE_MAX} onChange={(e) => edit(setNote)(e.target.value)} />}
        </Field>
      )}
      <ActionBar
        actions={
          problem ? (
            <DisabledReason control={(p) => <Button {...p}>{go}</Button>} reason={problem} />
          ) : (
            <Button variant="primary" disabled={busy} onClick={() => onPreview(request())}>{go}</Button>
          )
        }
      />
    </div>
  );
}
