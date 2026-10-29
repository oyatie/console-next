import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Field, TextInput } from "../../../ui/field/field";
import { ServerPicker } from "../../../ui/server-picker/server-picker";
import { personOption } from "../../../reference/person/ui/person-option";
import { PersonLabel } from "../../../reference/person/ui/person-label";
import { peopleQuery, type Evidence } from "../api";
import { EVIDENCE, type EvidenceDraft } from "../domain/evidence";

const NOTE_MAX_LENGTH = 500;

/** What a write was taken from: a paper sheet, a device file, a supervisor (named), the employee's statement or other. */
export function EvidenceField({ value, onChange, disabled }: { value: EvidenceDraft; onChange: (v: EvidenceDraft) => void; disabled?: boolean }) {
  const [query, setQuery] = useState("");
  const found = useQuery({ ...peopleQuery(query.trim()), enabled: query.trim().length > 0, placeholderData: keepPreviousData });
  const people = found.data?.items ?? [];
  const options = people.map((p) => personOption(p, people));
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
      {value.kind === "SUPERVISOR_CONFIRM" && value.confirmer && <PersonLabel person={{ ...people.find((p) => p.id === value.confirmer!.id), ...value.confirmer, employee_id: value.confirmer.id }} peers={people} />}
      {value.kind && (
        <Field label={t("attendanceRecords.evidence.note")} hint={t("attendanceRecords.evidence.note.hint", { limit: NOTE_MAX_LENGTH })} required={value.kind === "OTHER"}>
          {(p) => <TextInput {...p} value={value.note} maxLength={NOTE_MAX_LENGTH} onChange={(e) => onChange({ ...value, note: e.target.value })} />}
        </Field>
      )}
    </fieldset>
  );
}
