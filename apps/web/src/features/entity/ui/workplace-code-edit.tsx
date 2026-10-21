import { useState } from "react";
import type { Workplace } from "@console/api/pending";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { EntityError } from "./entity-error";
import { useFocusInside } from "../../../lib/react/use-focus-inside";
import { STRUCTURE_READS } from "../../../reference/org/api";
import { Button, Form } from "../../../ui/button/button";
import { Field, TextInput } from "../../../ui/field/field";
import { setWorkplaceCode } from "../api";
import { workplaceName } from "../domain/view";
import css from "../../../reference/org/ui/structure.module.css";

/** The code rule the server checks (the same as a department code): 1–30 letters, digits, '.', '_' or '-'. */
const CODE = /^[A-Za-z0-9._-]{1,30}$/;

/**
 * A workplace's code typed in place (review R16): a label the org sheet import matches first, direct in both phases. An
 * empty field clears it. A code a closed workplace held is accepted and the server's warning is said (R17).
 */
export function WorkplaceCodeEdit({ w, onDone }: { w: Workplace; onDone: () => void }) {
  const [code, setCode] = useState(w.code ?? "");
  const box = useFocusInside<HTMLSpanElement>();
  const v = code.trim();
  const bad = v !== "" && !CODE.test(v);
  const save = useCommand({
    run: (next: string | null, key: string) => setWorkplaceCode(key, w.id, next),
    invalidates: STRUCTURE_READS,
    announce: (r, next) =>
      [next ? t("workplace.code.done", { name: workplaceName(w), code: next }) : t("workplace.code.cleared", { name: workplaceName(w) }), r.warnings?.some((x) => x.code === "code_reused") && t("workplace.code.reused")].filter(Boolean).join(" "),
    onSuccess: onDone,
  });
  const submit = () => !bad && v !== (w.code ?? "") && save.mutate(v || null);
  return (
    <span ref={box} className={css.stack}>
      <Form className={css.stack} onSubmit={submit}>
        <Field label={t("workplace.code.label", { name: workplaceName(w) })} required={null} hint={t("workplace.code.hint")} error={bad ? t("workplace.code.invalid") : save.error ? <EntityError error={save.error} /> : undefined}>
          {(p) => <TextInput {...p} maxLength={30} value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onDone()} />}
        </Field>
        <span className="row">
          <Button type="submit" variant="primary" disabled={save.isPending}>{t("workplace.code.save")}</Button>
          <Button variant="ghost" onClick={onDone}>{t("orgStructure.cancel")}</Button>
        </span>
      </Form>
    </span>
  );
}
