import { t } from "@console/i18n";
import type { LegalEntity } from "@console/api/pending";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Field } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { workplaceName } from "../domain/view";
import { INSURANCE_CHOICES, type WorkplaceDraft, type WpKey, type WpProblem } from "../domain/workplace";
import { InsuranceRows } from "./insurance-fields";
import type { InsuranceAnswer, WorkplaceCreate } from "./use-workplace-create";
import css from "../../../reference/org/ui/structure.module.css";

/**
 * The two questions the law needs answered when a workplace is made, with no default (D7): where its withholding is
 * filed, and its social insurance relations. "with the head office numbers" reports under another workplace's numbers (never the BRN, D11).
 */
export function StatutoryChoices({ e, c }: { e: LegalEntity; c: WorkplaceCreate }) {
  const head = e.workplaces.find((w) => w.id === e.head_office_workplace_id);
  const others = e.workplaces.filter((w) => !w.closed_on);
  const yesNo = (v: boolean | null) => (v === null ? null : v ? "Y" : "N");
  const answers: InsuranceAnswer[] = [INSURANCE_CHOICES[0]!, INSURANCE_CHOICES[1]!, ...(others.length ? (["JOINT"] as const) : []), INSURANCE_CHOICES[2]!, INSURANCE_CHOICES[3]!];
  const rowsShown = c.ins === "ALL_ESTABLISHED_NOW" || c.ins === "PER_INSURER";
  const problem = (k: WpKey) => c.problems[k] as WpProblem | undefined;
  return (
    <>
      <ChoiceField
        label={t(c.corp ? "workplace.create.withholding" : "workplace.field.withholdingIndividual")}
        required
        look="chips"
        options={[
          { value: "N", label: c.corp ? (head ? t("workplace.create.withholdingHead", { name: workplaceName(head) }) : t("workplace.create.withholdingHeadNoName")) : t("workplace.withholdingIndividual.no") },
          { value: "Y", label: c.corp ? t("workplace.create.withholdingOwn") : t("workplace.withholdingIndividual.yes") },
        ]}
        value={yesNo(c.w.independentAccounts)}
        onChange={(v) => c.set("independentAccounts", v === "Y")}
        hint={t(c.corp ? "workplace.create.withholdingHint" : "workplace.withholdingIndividual.yesHint")}
      />
      {c.askHeadOffice && (
        <ChoiceField
          label={t(c.corp ? "workplace.field.headOffice" : "workplace.field.mainPlace")}
          required
          options={[
            { value: "N", label: t(c.corp ? "workplace.headOfficeChoice.no" : "workplace.mainPlaceChoice.no"), description: t(c.corp ? "workplace.headOfficeChoice.noHint" : "workplace.mainPlaceChoice.noHint") },
            { value: "Y", label: t(c.corp ? "workplace.headOfficeChoice.yes" : "workplace.mainPlaceChoice.yes"), description: t(c.corp ? "workplace.headOfficeChoice.yesHint" : "workplace.mainPlaceChoice.yesHint") },
          ]}
          value={yesNo(c.w.headOffice)}
          onChange={(v) => c.set("headOffice", v === "Y")}
        />
      )}
      {c.evident && <p className={css.note}>{t("workplace.headOfficeEvident")}</p>}
      <div className={css.stack}>
        <ChoiceField
          label={t("workplace.field.insurance")}
          required
          look="chips"
          options={answers.map((a) => ({ value: a!, label: t(`workplace.insurance.${a!}`) }))}
          value={c.ins}
          onChange={(v) => c.setIns(v as InsuranceAnswer)}
          hint={c.ins === "JOINT" ? undefined : t("workplace.create.insuranceHint")}
        />
        {c.ins === "JOINT" && (
          <div className="row">
            <Field label={t("workplace.create.jointLabel")} required>
              {(p) => (
                <SelectInput {...p} value={c.joint ?? ""} onChange={(x) => c.setJoint(x.target.value)}>
                  <option value="" disabled>{t("workplace.create.jointPick")}</option>
                  {others.map((w) => <option key={w.id} value={w.id}>{t("workplace.create.jointOption", { name: workplaceName(w) })}</option>)}
                </SelectInput>
              )}
            </Field>
          </div>
        )}
        {c.ins === "JOINT" && <span className={css.note}>{t("workplace.create.insuranceHint")}</span>}
        {rowsShown && (
          <InsuranceRows
            d={{ insurance: c.ins as WorkplaceDraft["insurance"], rows: c.w.rows }}
            set={(k, v) => (k === "rows" ? c.set("rows", v as WorkplaceDraft["rows"]) : undefined)}
            problem={problem}
            today={c.today}
          />
        )}
      </div>
    </>
  );
}
