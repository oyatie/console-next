// SPDX-License-Identifier: LicenseRef-Proprietary
import type { EntitySetupItem, LegalEntity } from "@console/api/pending";
import { changeLine } from "../present";
import { entityName } from "../../../reference/entity/domain/names";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { REPRESENTATION, label } from "../../../lib/labels";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Field, TextInput } from "../../../ui/field/field";
import { BULK_OPERATIONS, bulkGaps, type BulkOp, type EntityRow } from "../domain/bulk";
import type { Draft } from "../domain/draft";
import { KindAndName } from "./create-kind-and-name";
import { AddressEdit } from "./record-address-edit";

export function BulkEntityRow({
  row,
  set,
  setRow,
  error,
  changes,
  busy = false,
  records = [],
}: {
  row: EntityRow;
  set: (d: Draft) => void;
  setRow?: (r: EntityRow) => void;
  error?: string;
  changes?: EntitySetupItem["changes"];
  busy?: boolean;
  records?: readonly LegalEntity[];
}) {
  const op: BulkOp = row.op ?? "CREATE_ENTITY";
  const d = row.draft;
  const changeDraft = (patch: Partial<Draft>) => {
    const updatedDraft = { ...d, ...patch };
    const columns: Partial<Record<keyof Draft, typeof row.fields>> = { name: ["name"], bizKind: ["kind"], representatives: ["representatives"], representationMode: ["mode"], crn: ["crn"], headOfficeAddress: ["road", "zip"] };
    const fields = [...new Set([...(row.fields ?? []), ...Object.keys(patch).flatMap((key) => columns[key as keyof Draft] ?? [])])];
    if (setRow) {
      setRow({ ...row, fields, draft: updatedDraft });
    } else {
      set(updatedDraft);
    }
  };
  const changeRow = (patch: Partial<EntityRow>) => {
    if (setRow) {
      setRow({ ...row, ...patch });
    }
  };

  const gaps = bulkGaps(row, records);
  const named = d.representatives.filter((n) => n.trim()).length;
  const displayName = row.workplaceName || d.name || "";
  const opLabel = t(`setup.entityBulk.op.${op}`);

  const opOptions = BULK_OPERATIONS.filter((o) => o !== "CREATE_WORKPLACE").map((o) => ({
    value: o,
    label: t(`setup.entityBulk.op.${o}`),
  }));

  return (
    <details className="form" open={gaps.length > 0 || Boolean(error) || Boolean(changes?.length)}>
      <summary>
        {opLabel} · {t("setup.entityBulk.row", { line: row.line, name: displayName })}
        {gaps.length > 0 && ` · ${t("setup.entityBulk.missing", { count: gaps.length })}`}
      </summary>
      {error && <output role="alert">{error}</output>}
      {changes && <output>{changes.map(changeLine).join(" · ")}</output>}
      {gaps.includes("record") && <output>{t("setup.entityBulk.recordNeeded")}</output>}
      {op === "CREATE_WORKPLACE" && <Link to="/org/paste">{t("setup.entityBulk.workplaceFlow")}</Link>}
      <fieldset className="form__group form" disabled={busy || op === "CREATE_WORKPLACE"}>
        {setRow && (
          <ChoiceField
            label={t("setup.entityBulk.field.op")}
            required
            columns={2}
            options={opOptions}
            value={op}
            onChange={(v) => changeRow({ op: v as BulkOp })}
          />
        )}

        {(op === "REVISE_ENTITY" || op === "REVISE_WORKPLACE") && (
          <ChoiceField label={t("setup.entityBulk.field.id")} required value={row.id ?? null}
            options={records.flatMap((e) => op === "REVISE_ENTITY" ? [{ value: e.id, label: entityName(e) }] : e.workplaces.map((w) => ({ value: w.id, label: `${entityName(e)} · ${w.current?.name ?? ""}` })))}
            onChange={(id) => changeRow({ id, expectedVersion: undefined })} />
        )}

        {op === "CREATE_WORKPLACE" || op === "REVISE_WORKPLACE" ? (
          <Field label={t("setup.entityBulk.field.workplaceName")} required>
            {(f) => (
              <TextInput
                {...f}
                value={row.workplaceName ?? d.name}
                onChange={(e) => {
                  if (setRow) setRow({ ...row, workplaceName: e.target.value, draft: { ...d, name: e.target.value }, fields: [...new Set([...(row.fields ?? []), "workplaceName" as const])] });
                  else set({ ...d, name: e.target.value });
                }}
              />
            )}
          </Field>
        ) : (
          <KindAndName
            kind={d.bizKind}
            onKind={(bizKind) => changeDraft({ bizKind })}
            name={d.name}
            onName={(name) => changeDraft({ name })}
            clash={false}
          />
        )}

        {(op === "CREATE_ENTITY" || op === "REVISE_ENTITY") && (
          <>
            <Field label={t("setup.entityBulk.representativesInput")} required>
              {(f) => (
                <TextInput
                  {...f}
                  value={d.representatives.join("|")}
                  onChange={(e) => changeDraft({ representatives: e.target.value.split("|") })}
                />
              )}
            </Field>
            {(named > 1 || d.representationMode !== null || row.modeUnrecognized) && (
              <ChoiceField
                label={t("entityCreate.field.representationMode")}
                required
                options={REPRESENTATION.values
                  .filter((m) => named <= 1 || m !== "SINGLE")
                  .map((m) => ({ value: m, label: label(REPRESENTATION, m) }))}
                value={d.representationMode}
                onChange={(m) =>
                  changeDraft({ representationMode: m as Draft["representationMode"] })
                }
              />
            )}
            {d.bizKind === "CORPORATION" && (
              <Field label={t("entityCreate.field.crn")} required>
                {(f) => (
                  <TextInput
                    {...f}
                    value={d.crn}
                    maxLength={13}
                    onChange={(e) => changeDraft({ crn: e.target.value.replace(/[- ]/g, "") })}
                  />
                )}
              </Field>
            )}
          </>
        )}

        {((op === "CREATE_WORKPLACE" || op === "REVISE_WORKPLACE") ||
          ((op === "CREATE_ENTITY" || op === "REVISE_ENTITY") && d.bizKind === "CORPORATION")) && (
          <AddressEdit
            label={
              op === "CREATE_WORKPLACE" || op === "REVISE_WORKPLACE"
                ? t("setup.entityBulk.field.road")
                : t("entityCreate.field.headOfficeAddress")
            }
            v={d.headOfficeAddress}
            set={(headOfficeAddress) => changeDraft({ headOfficeAddress })}
          />
        )}
      </fieldset>
    </details>
  );
}
