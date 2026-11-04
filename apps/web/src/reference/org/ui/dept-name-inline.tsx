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
  const [baseUnit] = useState(unit);
  const [baseParent, setBaseParent] = useState(parent);
  const [name, setName] = useState(baseUnit?.name ?? "");
  const save = useCommand({
    run: (n: string, key: string) =>
      applySetup(key, [baseUnit ? { op: "RENAME", org_unit_id: baseUnit.id, expected_version: baseUnit.version, name: n } : { op: "CREATE", name: n, ...parentRef(baseParent) }]),
    invalidates: STRUCTURE_READS,
    awaitFirstRead: true,
    announce: (_, n) => (baseUnit ? t("orgUnit.rename.done", { from: baseUnit.name, name: n }) : t("orgUnit.add.done", { name: n, parent: baseParent.name })),
    onSuccess: () => (baseUnit ? onDone() : setName("")),
  });
  if (!save.isPending && baseParent !== parent) setBaseParent(parent);
  const taken = depts(baseParent).some((c) => c.id !== baseUnit?.id && fold(c.name) === fold(name));
  const same = baseUnit !== undefined && fold(name) === fold(baseUnit.name);
  const box = useFocusInside<HTMLSpanElement>();
  const submit = () => fold(name) && !taken && !same && save.mutate(fold(name));
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
        <span className="row">
          <Button type="submit" variant="primary" disabled={save.isPending}>{t(unit ? "orgUnit.rename.save" : "orgUnit.add.save")}</Button>
          <Button variant="ghost" onClick={onDone}>{t("orgStructure.cancel")}</Button>
        </span>
      </Form>
    </span>
  );
}
