import { t } from "@console/i18n";
import { REPRESENTATION, label } from "../../../lib/labels";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Field, TextInput } from "../../../ui/field/field";
import { bulkGaps } from "../domain/bulk";
import type { Draft } from "../domain/draft";
import type { EntityRow } from "../domain/bulk";
import { KindAndName } from "./create-kind-and-name";
import { AddressEdit } from "./record-address-edit";

export function BulkEntityRow({ row, set, error, busy = false }: { row: EntityRow; set: (d: Draft) => void; error?: string; busy?: boolean }) {
  const d = row.draft;
  const change = (patch: Partial<Draft>) => set({ ...d, ...patch });
  const gaps = bulkGaps(row);
  const named = d.representatives.filter((n) => n.trim()).length;
  return <details className="form" open={gaps.length > 0 || Boolean(error)}>
    <summary>{t("setup.entityBulk.row", { line: row.line, name: d.name })}{gaps.length > 0 && ` · ${t("setup.entityBulk.missing", { count: gaps.length })}`}</summary>
    {error && <output role="alert">{error}</output>}
    <fieldset className="form__group form" disabled={busy}>
    <KindAndName kind={d.bizKind} onKind={(bizKind) => change({ bizKind })} name={d.name} onName={(name) => change({ name })} clash={false} />
    <Field label={t("setup.entityBulk.representativesInput")} required>
      {(f) => <TextInput {...f} value={d.representatives.join("|")} onChange={(e) => change({ representatives: e.target.value.split("|") })} />}
    </Field>
    {(named > 1 || d.representationMode !== null || row.modeUnrecognized) && <ChoiceField label={t("entityCreate.field.representationMode")} required
      options={REPRESENTATION.values.filter((m) => named <= 1 || m !== "SINGLE").map((m) => ({ value: m, label: label(REPRESENTATION, m) }))}
      value={d.representationMode} onChange={(m) => change({ representationMode: m as Draft["representationMode"] })} />}
    {d.bizKind === "CORPORATION" && <>
      <Field label={t("entityCreate.field.crn")} required>
        {(f) => <TextInput {...f} value={d.crn} maxLength={13} onChange={(e) => change({ crn: e.target.value.replace(/[- ]/g, "") })} />}
      </Field>
      <AddressEdit label={t("entityCreate.field.headOfficeAddress")} v={d.headOfficeAddress} set={(headOfficeAddress) => change({ headOfficeAddress })} />
    </>}
    </fieldset>
  </details>;
}
