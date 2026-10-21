import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Field, TextInput } from "../../../ui/field/field";
import { ServerPicker } from "../../../ui/server-picker/server-picker";
import { peopleQuery, type Evidence } from "../api";
import { EVIDENCE, type EvidenceDraft } from "../domain/evidence";

/** What a write was taken from: a paper sheet, a device file, a supervisor (named), the employee's statement or other. */
export function EvidenceField({ value, onChange, disabled }: { value: EvidenceDraft; onChange: (v: EvidenceDraft) => void; disabled?: boolean }) {
  const [query, setQuery] = useState("");
  const found = useQuery({ ...peopleQuery(query.trim()), enabled: query.trim().length > 0, placeholderData: keepPreviousData });
  const options = (found.data?.items ?? []).map((p) => ({ id: p.id, name: p.name, code: p.employee_number ?? undefined }));
  return (
    <fieldset className="form" disabled={disabled}>
      <ChoiceField
        label={t("attendanceRecords.evidence.label")}
        required
        columns={2}
        value={value.kind}
        onChange={(k) => onChange({ ...value, kind: k as Evidence["kind"] })}
        options={EVIDENCE.map((k) => ({ value: k, label: t(`attendanceRecords.evidence.${k}`) }))}
      />
      {value.kind === "SUPERVISOR_CONFIRM" && (
        <ServerPicker
          label={t("attendanceRecords.evidence.confirmer")}
          group={t("attendanceRecords.evidence.confirmerGroup")}
          query={query}
          onQueryChange={setQuery}
          options={options}
          value={value.confirmer?.id ?? null}
          loading={found.isFetching}
          empty={t("attendanceRecords.evidence.confirmerNone")}
          isRequired
          onChange={(id) => {
            const o = options.find((x) => x.id === id);
            if (o) onChange({ ...value, confirmer: { id: o.id, name: o.name } });
          }}
        />
      )}
      {value.kind && (
        <Field label={t("attendanceRecords.evidence.note")} required={value.kind === "OTHER"}>
          {(p) => <TextInput {...p} value={value.note} maxLength={500} onChange={(e) => onChange({ ...value, note: e.target.value })} />}
        </Field>
      )}
    </fieldset>
  );
}
