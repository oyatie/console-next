import { useState } from "react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { useFocusInside } from "../../../lib/react/use-focus-inside";
import { Button, Form } from "../../../ui/button/button";
import { Field, TextInput } from "../../../ui/field/field";
import { applySetup, STRUCTURE_READS } from "../api";
import { depts, parentRef, type Node } from "../domain/structure";
import css from "./structure.module.css";

const fold = (s: string) => s.normalize("NFC").trim();

/**
 * A department's name typed in place during setup, applied at once and undoable: a new department under `parent`
 * (its name only; the level follows the parent, decision 18), or `unit` renamed. A name an open sibling already has
 * is caught as it is typed (I-5). Enter saves (adding keeps the field open for the next one); Esc closes it.
 */
export function DeptNameInline({ parent, unit, onDone }: { parent: Node; unit?: Node; onDone: () => void }) {
  const [name, setName] = useState(unit?.name ?? "");
  const taken = depts(parent).some((c) => c.id !== unit?.id && fold(c.name) === fold(name));
  const same = unit !== undefined && fold(name) === fold(unit.name);
  const save = useCommand({
    run: (n: string, key: string) =>
      applySetup(key, [unit ? { op: "RENAME", org_unit_id: unit.id, expected_version: unit.version, name: n } : { op: "CREATE", name: n, ...parentRef(parent) }]),
    invalidates: STRUCTURE_READS,
    awaitFirstRead: true,
    announce: (_, n) => (unit ? t("orgUnit.rename.done", { from: unit.name, name: n }) : t("orgUnit.add.done", { name: n, parent: parent.name })),
    onSuccess: () => (unit ? onDone() : setName("")),
  });
  const box = useFocusInside<HTMLSpanElement>();
  const submit = () => fold(name) && !taken && !same && save.mutate(fold(name));
  const label = unit ? t("orgUnit.rename.label", { name: unit.name }) : t("orgUnit.add.label", { parent: parent.name });
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
        <span className="row">
          <Button type="submit" variant="primary" disabled={save.isPending}>{t(unit ? "orgUnit.rename.save" : "orgUnit.add.save")}</Button>
          <Button variant="ghost" onClick={onDone}>{t("orgStructure.cancel")}</Button>
        </span>
      </Form>
    </span>
  );
}
