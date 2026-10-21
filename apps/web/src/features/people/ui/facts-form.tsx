import { useState } from "react";
import { t, type MessageId } from "@console/i18n";
import { fmtDate, fmtDateTime, fmtNumber } from "@console/i18n/format";
import { ID_TYPE, PAY_UNIT, label } from "../../../lib/labels";
import { announce } from "../../../lib/react/announce";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { useDirtyEscape } from "../../../lib/react/dirty-escape";
import { edit, isConflict, load, rebaseAll, resolve, type Fields } from "../../../lib/pure/three-way";
import { todayKst } from "../../../lib/pure/today";
import { Button, Form } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { ConflictPanel } from "../../../ui/conflict/field-conflict";
import { DateField } from "../../../ui/date/date-field";
import { Field, TextInput } from "../../../ui/field/field";
import { FACT_PATHS, PAY_UNITS, emailOk, factValues, factsPatch, type FactKey, type FactValues, type Facts } from "../domain/facts";
import { isFieldConflict, patchFacts } from "../api";

const KEYS = Object.keys(FACT_PATHS) as FactKey[];
const LABEL: Record<FactKey, MessageId> = {
  birth_date: "facts.birthDate",
  work_email: "facts.workEmail",
  id_type: "facts.idType",
  base_pay_won: "facts.basePay",
  pay_unit: "facts.payUnit",
  probation_end_date: "facts.probationEnd",
};
const fields = (v: FactValues) => Object.fromEntries(KEYS.map((k) => [k, load(v[k])])) as Fields<FactKey>;
const yours = (f: Fields<FactKey>) => Object.fromEntries(KEYS.map((k) => [k, f[k].yours])) as FactValues;
const bases = (f: Fields<FactKey>) => Object.fromEntries(KEYS.map((k) => [k, f[k].base])) as FactValues;

/**
 * Edits the employment record in place. Every write is sent with a test of the value it was read as; when someone
 * saved meanwhile (409 field_conflict, or a re-read that moved a field) untouched fields take the new value and an
 * edited one asks which to keep (concurrent-editing ME-1..ME-5). A recorded base pay is shown, not edited: it
 * changes through a contract correction. Nothing is preselected.
 */
export function FactsForm({ f, name, refetch, onClose }: { f: Facts; name: string; refetch: () => unknown; onClose: () => void }) {
  const today = todayKst();
  const m = f.employment ?? f.pending_employment;
  const [form, setForm] = useState(() => fields(factValues(f)));
  const [seen, setSeen] = useState(f.updated_at);
  const [tried, setTried] = useState(false);
  if (f.updated_at !== seen) {
    // The record moved while the form was open: merge it, never reset what was typed.
    setSeen(f.updated_at);
    setForm(rebaseAll(form, factValues(f)).fields);
  }
  const v = yours(form);
  const set = (k: FactKey) => (value: string | number | null) => setForm((x) => ({ ...x, [k]: edit(x[k], value === "" ? null : value) }));
  const conflicts = KEYS.filter((k) => isConflict(form[k]));
  const patch = factsPatch(bases(form), v);
  const errors = {
    email: v.work_email != null && !emailOk(String(v.work_email)) ? t("facts.workEmail.invalid") : undefined,
    pay: (v.base_pay_won == null) !== (v.pay_unit == null) ? t("facts.edit.payPair") : undefined,
    form: tried && patch.length === 0 ? t("facts.edit.nothing") : undefined,
  };
  const save = useCommand({
    run: () => patchFacts(f.employee_id, patch),
    invalidates: ["/api/v1/employees"],
    onSuccess: onClose,
    announce: () => t("facts.edit.saved", { name }),
  });
  const press = () => {
    setTried(true);
    const count = [errors.email, errors.pay].filter(Boolean).length;
    if (count) return announce(t("facts.errors", { count }));
    if (patch.length === 0 || conflicts.length) return;
    // Someone saved first: re-read, so the fields they changed are merged or asked about.
    save.mutate(undefined, { onError: (e) => void (isFieldConflict(e) && refetch()) });
  };
  const { ref, armed } = useDirtyEscape<HTMLDivElement>(patch.length > 0, onClose);
  const shown = (k: FactKey, x: unknown) =>
    x == null ? "" : k === "id_type" ? label(ID_TYPE, String(x)) : k === "pay_unit" ? label(PAY_UNIT, String(x)) : k === "base_pay_won" ? fmtNumber(Number(x)) : k.endsWith("date") ? fmtDate(x) : String(x);
  const payRecorded = m?.pay_unit != null && form.pay_unit.base != null;
  return (
    <div ref={ref}>
      <Form className="form" aria-label={t("facts.edit")} noValidate onSubmit={press}>
        {conflicts.length > 0 && (
          <ConflictPanel
            kind="field_conflict"
            choices={{}}
            onChoose={(k, c) => setForm((x) => ({ ...x, [k]: resolve(x[k as FactKey], c) }))}
            conflicts={conflicts.map((k) => ({ field: k, label: t(LABEL[k]), base: shown(k, form[k].base), mine: shown(k, form[k].yours), current: shown(k, form[k].current), at: fmtDateTime(f.updated_at) }))}
          />
        )}
        <DateField label={t("facts.birthDate")} required={false} value={String(v.birth_date ?? "")} onChange={set("birth_date")} today={today} max={today} />
        <Field label={t("facts.workEmail")} required={false}  error={tried ? errors.email : undefined}>
          {(p) => <TextInput {...p} type="email" autoComplete="off" value={String(v.work_email ?? "")} onChange={(e) => set("work_email")(e.target.value.trim())} />}
        </Field>
        <ChoiceField
          label={t("facts.idType")}
          required={false}
          options={ID_TYPE.values.map((x) => ({ value: x, label: label(ID_TYPE, x) }))}
          value={(v.id_type as string | null) ?? null}
          onChange={set("id_type")}
        />
        {m && !payRecorded && (
          <>
            <Field label={t("facts.basePay")} required={false} unit={t("facts.won")} error={tried ? errors.pay : undefined}>
              {(p) => (
                <TextInput
                  {...p}
                  inputMode="numeric"
                  className="num"
                  value={v.base_pay_won == null ? "" : fmtNumber(Number(v.base_pay_won))}
                  onChange={(e) => {
                    const d = e.target.value.replace(/[^\d]/g, "");
                    set("base_pay_won")(d === "" ? null : Number(d));
                  }}
                />
              )}
            </Field>
            <ChoiceField label={t("facts.payUnit")} required={false} options={PAY_UNITS.map((x) => ({ value: x, label: label(PAY_UNIT, x) }))} value={(v.pay_unit as string | null) ?? null} onChange={set("pay_unit")} />
          </>
        )}
        {payRecorded && <p className="muted">{t("facts.basePay.locked")}</p>}
        {m && !m.probation_confirmed_at && (
          <DateField label={t("facts.probationEnd")} required={false} value={String(v.probation_end_date ?? "")} onChange={set("probation_end_date")} today={today} />
        )}
        {m?.probation_confirmed_at && <p className="muted">{t("facts.probationEnd.locked")}</p>}
        {errors.form && <p className="alert" role="alert">{errors.form}</p>}
        {armed && <p className="muted" role="status">{t("facts.escConfirm")}</p>}
        <p id="facts-consequence" className="muted">{t("facts.edit.consequence")}</p>
        <CommandError error={isFieldConflict(save.error) ? null : save.error} />
        <div className="row">
          <Button disabled={save.isPending} onClick={onClose}>{t("common.back")}</Button>
          <Button type="submit" variant="primary" disabled={save.isPending || conflicts.length > 0} aria-describedby="facts-consequence">{t("facts.edit.save")}</Button>
        </div>
      </Form>
    </div>
  );
}
