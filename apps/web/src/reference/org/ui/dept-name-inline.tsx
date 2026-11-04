import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { announce } from "../../../lib/react/announce";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { useFocusInside } from "../../../lib/react/use-focus-inside";
import { Button, Form } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { DateField } from "../../../ui/date/date-field";
import { isDate } from "../../../ui/date/days";
import { Field, TextInput } from "../../../ui/field/field";
import { applySetup, defaultEffectiveDate, STRUCTURE_READS, submitInlineUnitChange } from "../api";
import { depts, parentRef, unitIdOf, type Node } from "../domain/structure";
import { noteChange } from "./use-change-note";
import css from "./structure.module.css";

const fold = (s: string) => s.normalize("NFC").trim();

/**
 * A department's name typed in place during setup, applied at once and undoable: a new department under `parent`
 * (its name only; the level follows the parent, decision 18), or `unit` renamed. A name an open sibling already has
 * is caught as it is typed (I-5). Enter saves (adding keeps the field open for the next one); Esc closes it.
 */
export function DeptNameInline({ parent, unit, setup = true, onDone }: { parent: Node; unit?: Node; setup?: boolean; onDone: () => void }) {
  const nav = useNavigate();
  const today = todayKst();
  const [baseUnit] = useState(unit);
  const [baseParent, setBaseParent] = useState(parent);
  const [name, setName] = useState(baseUnit?.name ?? "");
  const [date, setDate] = useState(() => defaultEffectiveDate(today));
  const save = useCommand({
    run: async (n: string, key: string) => setup
      ? (await applySetup(key, [baseUnit ? { op: "RENAME", org_unit_id: baseUnit.id, expected_version: baseUnit.version, name: n } : { op: "CREATE", name: n, ...parentRef(baseParent) }]), undefined)
      : submitInlineUnitChange(key, baseUnit ? { kind: "rename", orgUnitId: baseUnit.id, fromName: baseUnit.name, name: n, effectiveDate: date } : { kind: "create", parentUnitId: unitIdOf(baseParent), name: n, effectiveDate: date }),
    invalidates: STRUCTURE_READS,
    awaitFirstRead: true,
    onSuccess: (out, n) => {
      if (out && out.sent !== "sent") return void nav({ to: "/org/changes/$id", params: { id: out.id }, search: { done: "drafted", unsent: true } });
      if (out) noteChange({ id: out.id, code: out.code, message: out.message });
      else announce(baseUnit ? t("orgUnit.rename.done", { from: baseUnit.name, name: n }) : t("orgUnit.add.done", { name: n, parent: baseParent.name }));
      if (baseUnit) onDone(); else setName("");
      if (out?.createdUnitIds[0]) void nav({ to: "/org", search: (q: Record<string, unknown>) => ({ ...q, sel: out.createdUnitIds[0], act: undefined }) });
    },
  });
  if (!save.isPending && baseParent !== parent) setBaseParent(parent);
  const taken = depts(baseParent).some((c) => c.id !== baseUnit?.id && fold(c.name) === fold(name));
  const same = baseUnit !== undefined && fold(name) === fold(baseUnit.name);
  const dateOk = setup || (isDate(date) && date >= today);
  const box = useFocusInside<HTMLSpanElement>();
  const submit = () => fold(name) && !taken && !same && dateOk && save.mutate(fold(name));
  const label = baseUnit ? t("orgUnit.rename.label", { name: baseUnit.name }) : t("orgUnit.add.label", { parent: baseParent.name });
  return (
    <span ref={box} className={css.stack}>
      <Form className={css.stack} onSubmit={submit}>
        <Field
          label={label}
          required
          error={taken ? t("orgUnit.add.taken", { parent: parent.name }) : save.error ? <CommandError error={save.error} /> : undefined}
        >
          {(p) => <TextInput {...p} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => (e.key === "Escape" ? onDone() : e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229 && submit())} />}
        </Field>
        {setup ? <Chip>{t("orgUnit.gov.date")} · {t("asof.today")}</Chip> : <DateField label={t("orgUnit.gov.date")} required value={date} onChange={setDate} today={today} min={today} />}
        <span className="row">
          <Button type="submit" variant="primary" disabled={save.isPending || !dateOk}>{t(unit ? "orgUnit.rename.save" : "orgUnit.add.save")}</Button>
          <Button variant="ghost" onClick={onDone}>{t("orgStructure.cancel")}</Button>
        </span>
      </Form>
    </span>
  );
}
