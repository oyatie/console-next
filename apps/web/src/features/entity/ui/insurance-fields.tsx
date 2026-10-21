import { t } from "@console/i18n";
import { INSURANCE_STATUS, INSURER, label } from "../../../lib/labels";
import { FORMATS } from "../../../lib/pure/formats";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DateField } from "../../../ui/date/date-field";
import { MaskedField } from "../../../ui/masked-field/masked-field";
import { INSURANCE_CHOICES, rowsFor, type InsuranceRow, type WorkplaceDraft, type WpKey, type WpProblem } from "../domain/workplace";
import { RefPick } from "./ref-pick";

const STATUSES = ["ESTABLISHED", "ESTABLISHED_NUMBER_PENDING", "NOT_ESTABLISHED"] as const;

/**
 * The four social insurance relations of a workplace (design §3.4, challenge A-8): one choice covers all four
 * with no default, and numbers are asked only where a relation is established with its number at hand.
 */
export function InsuranceFields({ d, set, problem, today }: {
  d: Pick<WorkplaceDraft, "insurance" | "rows">;
  set: <K extends "insurance" | "rows">(k: K, v: WorkplaceDraft[K]) => void;
  problem: (k: WpKey) => WpProblem | undefined;
  today: string;
}) {
  const text = (p?: WpProblem) => (p ? t(`workplace.problem.${p}`) : undefined);
  return (
    <>
      <ChoiceField
        label={t("workplace.field.insurance")}
        required
        options={INSURANCE_CHOICES.map((c) => ({ value: c, label: t(`workplace.insurance.${c}`), description: t(`workplace.insurance.hint.${c}`) }))}
        value={d.insurance}
        onChange={(v) => set("insurance", v as WorkplaceDraft["insurance"])}
        error={text(problem("insurance"))}
      />
      <InsuranceRows d={d} set={set} problem={problem} today={today} />
    </>
  );
}

type Props = Parameters<typeof InsuranceFields>[0];
/** Each insurer's status (when chosen per insurer) and its management number and establishment date where it is established with its number at hand. */
export function InsuranceRows({ d, set, problem, today }: Props) {
  const text = (p?: WpProblem) => (p ? t(`workplace.problem.${p}`) : undefined);
  const setRow = (i: number, patch: Partial<InsuranceRow>) => set("rows", d.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const shown = rowsFor(d);
  return (
    <>
      {(d.insurance === "ALL_ESTABLISHED_NOW" || d.insurance === "PER_INSURER") &&
        shown.map((r, i) => (
          <fieldset key={r.insurer} className="form__group">
            <legend className="field__label">{label(INSURER, r.insurer)}</legend>
            <div className="grid-3">
              {d.insurance === "PER_INSURER" && (
                <ChoiceField
                  label={t("workplace.field.status")}
                  required
                  options={STATUSES.map((v) => ({ value: v, label: label(INSURANCE_STATUS, v) }))}
                  value={r.status}
                  onChange={(v) => setRow(i, { status: v as InsuranceRow["status"] })}
                  error={text(problem(`row.${r.insurer}.status`))}
                />
              )}
              {r.status === "ESTABLISHED" && (
                <>
                  <MaskedField
                    label={t("workplace.field.mgmtNo")}
                    required
                    format={FORMATS.insuranceNo}
                    value={r.mgmtNo}
                    onChange={(v) => setRow(i, { mgmtNo: v })}

                    error={text(problem(`row.${r.insurer}.mgmtNo`))}
                  />
                  <DateField label={t("workplace.field.establishedOn")} required value={r.establishedOn} onChange={(v) => setRow(i, { establishedOn: v })} today={today} max={today} error={text(problem(`row.${r.insurer}.establishedOn`))} />
                </>
              )}
              {r.insurer === "NHIS" && r.status !== null && r.status !== "NOT_ESTABLISHED" && (
                <RefPick listKey="insurance_branch" label={t("capture.field.nhisOffice")} required={false} value={r.code ?? null} onChange={(code) => setRow(i, { code })} />
              )}
            </div>
          </fieldset>
        ))}
    </>
  );
}
