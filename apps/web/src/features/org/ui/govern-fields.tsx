import { t } from "@console/i18n";
import { DateField } from "../../../ui/date/date-field";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { firstOfNextMonth } from "../domain/proposal";
import type { GovernState } from "./use-govern";

/**
 * effective date · reason (and, only when the tenant routes org changes through approval, the approval route) of a structure change (D12, D17, decisions #26). The route is decided when the proposal is drafted, from the
 * accounts that hold org revision approval; when only the ops account can decide, it is decided alone with a step-up and a
 * later-review mark (decision #7).
 */
export function GovernFields({ s }: { s: GovernState }) {
  const presets = [
    { label: t("orgUnit.gov.today"), date: s.today },
    { label: t("orgUnit.gov.nextMonth", { date: firstOfNextMonth(s.today).slice(5) }), date: firstOfNextMonth(s.today) },
  ];
  return (
    <>
      <DateField label={t("orgUnit.gov.date")} required value={s.g.date} onChange={(date) => s.set({ date })} today={s.today} min={s.today} presets={presets} />
      <Field label={t("orgUnit.gov.reason")} required>
        {(p) => <TextArea {...p} rows={2} maxLength={4000} value={s.g.reason} onChange={(e) => s.set({ reason: e.target.value })} />}
      </Field>
    </>
  );
}
