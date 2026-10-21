import { useState } from "react";
import { t } from "@console/i18n";
import { ActionBar } from "../../../ui/action-bar/action-bar";
import { Button } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Field, TextInput } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import type { NumberRule } from "../api";
import { ruleProblem, sample, WIDTH, type Scope } from "../domain/numbering";

const WIDTHS = Array.from({ length: WIDTH.max - WIDTH.min + 1 }, (_, i) => WIDTH.min + i);
/** A width people usually pick, offered first-time only (the select keeps any width). */
const USUAL_WIDTH = 4;

/** The prefix and digit count of one scope's numbers, with the first number they make. */
export function RuleForm({ scope, rule, busy, onSave, onCancel }: { scope: Scope; rule?: NumberRule; busy: boolean; onSave: (prefix: string, width: number) => void; onCancel: () => void }) {
  const [prefix, setPrefix] = useState(rule?.prefix ?? "");
  const [width, setWidth] = useState(rule?.width ?? USUAL_WIDTH);
  const problem = ruleProblem(prefix, width);
  const go = t("identifiers.rules.save", { scope: scope.label });
  return (
    <div className="form">
      <Field label={t("identifiers.rules.prefix", { scope: scope.label })} required={false} hint={t("identifiers.rules.prefixHint")}>
        {(p) => <TextInput {...p} value={prefix} maxLength={16} onChange={(e) => setPrefix(e.target.value)} />}
      </Field>
      <Field label={t("identifiers.rules.width", { scope: scope.label })} required>
        {(p) => (
          <SelectInput {...p} value={String(width)} onChange={(e) => setWidth(Number(e.target.value))}>
            {WIDTHS.map((w) => <option key={w} value={w}>{t("identifiers.rules.digits", { count: w })}</option>)}
          </SelectInput>
        )}
      </Field>
      <ActionBar
        consequence={!problem && <span className="muted">{t("identifiers.rules.sample", { sample: sample(prefix, width) })}</span>}
        actions={
          <>
            <Button onClick={onCancel}>{t("identifiers.cancel")}</Button>
            {problem ? (
              <DisabledReason control={(p) => <Button {...p} variant="primary">{go}</Button>} reason={t(`identifiers.rules.problem.${problem}`)} />
            ) : (
              <Button variant="primary" disabled={busy} onClick={() => onSave(prefix, width)}>{go}</Button>
            )}
          </>
        }
      />
    </div>
  );
}
