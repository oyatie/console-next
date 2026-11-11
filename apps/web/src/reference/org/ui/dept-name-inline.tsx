import { useInlineUnitValues } from "./use-inline-unit-values";
import { useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { announce } from "../../../lib/react/announce";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { useFocusInside } from "../../../lib/react/use-focus-inside";
import { Button, Form } from "../../../ui/button/button";
import { Field, TextInput } from "../../../ui/field/field";
import { applySetup, governed, inlineUnitBody, changeReceipt, setupDated, STRUCTURE_READS } from "../api";
import { depts, parentRef, unitIdOf, type Node } from "../domain/structure";
import { noteChange } from "./use-change-note";
import { InlineUnitFields } from "./inline-unit-fields";
import css from "./structure.module.css";

const fold = (s: string) => s.normalize("NFC").trim();

/**
 * A department's name typed in place during setup, applied at once and undoable: a new department under `parent`
 * (its name only; the level follows the parent, decision 18), or `unit` renamed. A name an open sibling already has
 * is caught as it is typed (I-5). Enter saves (adding keeps the field open for the next one); Esc closes it.
 */
export function DeptNameInline({ parent, unit, setup = true, onDone }: { parent: Node; unit?: Node; setup?: boolean; onDone: () => void }) {
  const nav = useNavigate();
  const search = useSearch({ strict: false }) as { as_of?: string };
  const state = useInlineUnitValues(setup, search.as_of, unit ? "rename" : "create");
  const [baseUnit] = useState(unit);
  const [baseParent, setBaseParent] = useState(parent);
  const [name, setName] = useState(baseUnit?.name ?? "");
  const save = useCommand({
    run: async ({ name: n, submit }: { name: string; submit: boolean }, key: string) => setup
      ? (await applySetup(key, [baseUnit ? { op: "RENAME", org_unit_id: baseUnit.id, expected_version: baseUnit.version, name: n } : { op: "CREATE", name: n, ...parentRef(baseParent) }], state.values.effectiveDate), undefined)
      : governed(key, inlineUnitBody(baseUnit ? { kind: "rename", orgUnitId: baseUnit.id, fromName: baseUnit.name, name: n, ...state.values, submit } : { kind: "create", parentUnitId: unitIdOf(baseParent), name: n, ...state.values, submit }), submit),
    invalidates: STRUCTURE_READS,
    awaitFirstRead: true,
    onSuccess: (out, { name: n }) => {
      if (out && out.sent !== "sent") return void nav({ to: "/org/changes/$id", params: { id: out.id }, search: { done: "drafted", unsent: out.sent === "unsent" || undefined } });
      if (out) noteChange({ id: out.id, code: out.code, message: changeReceipt(out.status, baseUnit ? t("orgChange.title.rename", { from: baseUnit.name, to: n }) : t("orgChange.title.create", { name: n }), out.code, state.values.effectiveDate) });
      else announce(setupDated(baseUnit ? t("orgUnit.rename.done", { from: baseUnit.name, name: n }) : t("orgUnit.add.done", { name: n, parent: baseParent.name }), state.values.effectiveDate).message);
      if (baseUnit) onDone(); else setName("");
      if (out?.select) void nav({ to: "/org", search: (q: Record<string, unknown>) => ({ ...q, sel: out.select, act: undefined }) });
    },
  });
  if (!save.isPending && baseParent !== parent) setBaseParent(parent);
  const taken = depts(baseParent).some((c) => c.id !== baseUnit?.id && fold(c.name) === fold(name));
  const same = baseUnit !== undefined && fold(name) === fold(baseUnit.name);
  const box = useFocusInside<HTMLSpanElement>();
  const submit = (send = true) => fold(name) && !taken && !same && state.attempt() && save.mutate({ name: fold(name), submit: send });
  const label = baseUnit ? t("orgUnit.rename.label", { name: baseUnit.name }) : t("orgUnit.add.label", { parent: baseParent.name });
  return (
    <span ref={box} className={css.stack}>
      <Form className={css.stack} onSubmit={() => submit()}>
        <Field
          label={label}
          required
          error={taken ? t("orgUnit.add.taken", { parent: parent.name }) : save.error ? <CommandError error={save.error} /> : undefined}
        >
          {(p) => <TextInput {...p} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => (e.key === "Escape" ? onDone() : e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229 && submit())} />}
        </Field>
        <InlineUnitFields setup={setup} state={state} pending={save.isPending} onDraft={() => submit(false)} />
        <span className="row">
          <Button aria-description={state.missingReason ? t("orgUnit.gov.reasonForApproval") : undefined} type="submit" variant="primary" disabled={save.isPending || !state.valid}>{t(unit ? "orgUnit.rename.save" : "orgUnit.add.save")}</Button>
          <Button variant="ghost" onClick={onDone}>{t("orgStructure.cancel")}</Button>
        </span>
      </Form>
    </span>
  );
}
