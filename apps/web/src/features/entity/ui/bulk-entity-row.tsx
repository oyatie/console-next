// SPDX-License-Identifier: LicenseRef-Proprietary
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
  busy = false,
}: {
  row: EntityRow;
  set: (d: Draft) => void;
  setRow?: (r: EntityRow) => void;
  error?: string;
  busy?: boolean;
}) {
  const op: BulkOp = row.op ?? "CREATE_ENTITY";
  const d = row.draft;
  const changeDraft = (patch: Partial<Draft>) => {
    const updatedDraft = { ...d, ...patch };
    if (setRow) {
      setRow({ ...row, draft: updatedDraft });
    } else {
      set(updatedDraft);
    }
  };
  const changeRow = (patch: Partial<EntityRow>) => {
    if (setRow) {
      setRow({ ...row, ...patch });
    }
  };

  const gaps = bulkGaps(row);
  const named = d.representatives.filter((n) => n.trim()).length;
  const displayName = row.workplaceName || d.name || "";
  const opLabel = t(`setup.entityBulk.op.${op}`);

  const opOptions = BULK_OPERATIONS.map((o) => ({
    value: o,
    label: t(`setup.entityBulk.op.${o}`),
  }));

  return (
    <details className="form" open={gaps.length > 0 || Boolean(error)}>
      <summary>
        {opLabel} · {t("setup.entityBulk.row", { line: row.line, name: displayName })}
        {gaps.length > 0 && ` · ${t("setup.entityBulk.missing", { count: gaps.length })}`}
      </summary>
      {error && <output role="alert">{error}</output>}
      <fieldset className="form__group form" disabled={busy}>
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
          <div className="row">
            <Field label={t("setup.entityBulk.field.id")} required>
              {(f) => (
                <TextInput
                  {...f}
                  value={row.id ?? ""}
                  placeholder="UUID"
                  onChange={(e) => changeRow({ id: e.target.value.trim() })}
                />
              )}
            </Field>
            <Field label={t("setup.entityBulk.field.version")} required>
              {(f) => (
                <TextInput
                  {...f}
                  type="number"
                  min={0}
                  value={row.expectedVersion != null ? String(row.expectedVersion) : ""}
                  placeholder="1"
                  onChange={(e) =>
                    changeRow({
                      expectedVersion: e.target.value ? Number(e.target.value) : undefined,
                    })
                  }
                />
              )}
            </Field>
          </div>
        )}

        {op === "CREATE_WORKPLACE" && (
          <Field label={t("setup.entityBulk.field.legalEntityId")} required>
            {(f) => (
              <TextInput
                {...f}
                value={row.legalEntityId ?? row.entityRef ?? ""}
                placeholder="UUID or row reference"
                onChange={(e) => changeRow({ legalEntityId: e.target.value.trim() })}
              />
            )}
          </Field>
        )}

        {op === "CREATE_WORKPLACE" || op === "REVISE_WORKPLACE" ? (
          <Field label={t("setup.entityBulk.field.workplaceName")} required>
            {(f) => (
              <TextInput
                {...f}
                value={row.workplaceName ?? d.name}
                onChange={(e) => {
                  changeRow({ workplaceName: e.target.value });
                  changeDraft({ name: e.target.value });
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
