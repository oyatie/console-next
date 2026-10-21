import { useState } from "react";
import { t } from "@console/i18n";
import type { WorkplaceKind } from "@console/api/pending";
import { useCommand } from "../../../lib/react/command";
import { EntityError } from "./entity-error";
import { Button, Form } from "../../../ui/button/button";
import { ChoiceAdd, ChoiceField } from "../../../ui/choice/choice-field";
import { Field, TextInput } from "../../../ui/field/field";
import { addKind } from "../api";
import { useFocusInside } from "../../../lib/react/use-focus-inside";
import { kindLabel, kindTaken } from "../present";
import css from "../../../reference/org/ui/structure.module.css";

/**
 * workplace kind (decision 18): a label only, never a rule, so nothing is preselected. A kind that is not listed is added
 * in place and chosen; head office is set apart from the kind.
 */
export function KindChoice({ kinds, value, onChange }: { kinds: readonly WorkplaceKind[]; value: string | null; onChange: (code: string) => void; headOffice?: string }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className={css.stack}>
      <ChoiceField
        label={t("workplace.create.kind")}
        required
        look="chips"
        options={kinds.filter((k) => k.active || k.code === value).map((k) => ({ value: k.code, label: kindLabel(k) }))}
        value={value}
        onChange={onChange}
        add={!adding && <ChoiceAdd id="kind-add" label={t("workplace.create.kindAdd")} onPress={() => setAdding(true)} />}
      />
      {adding && (
        <AddKind
          kinds={kinds}
          onAdded={(code) => {
            onChange(code);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      )}
    </div>
  );
}

/** A tenant kind typed in place; it joins the list and is chosen. A label any kind already shows is refused here. */
export function AddKind({ kinds, onAdded, onCancel }: { kinds: readonly WorkplaceKind[]; onAdded: (code: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const taken = name.trim() !== "" && kindTaken(kinds, name);
  const box = useFocusInside<HTMLSpanElement>();
  const add = useCommand({
    run: (label: string, key: string) => addKind(key, label),
    invalidates: ["/api/v1/workplace-kinds"],
    onSuccess: (k) => onAdded(k.code),
  });
  return (
    <span ref={box}>
      <Form className="row" onSubmit={() => name.trim() && !taken && add.mutate(name.trim())}>
        <Field label={t("workplace.create.kindNew")} required error={taken ? t("workplace.kind.taken", { name: name.trim() }) : add.error ? <EntityError error={add.error} /> : undefined}>
          {(p) => <TextInput {...p} maxLength={40} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onCancel()} />}
        </Field>
        <Button type="submit" disabled={add.isPending}>{t("workplace.create.kindNewSave")}</Button>
      </Form>
    </span>
  );
}
