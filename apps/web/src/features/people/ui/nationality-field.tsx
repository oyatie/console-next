// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState, type ReactNode } from "react";
import { i18n, t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { FieldMark, FieldRow } from "../../../ui/record/field-row";
import { ServerPicker } from "../../../ui/server-picker/server-picker";
import { InlineConflict, type FieldConflict } from "./inline-conflict";
import type { PersonalFacts } from "../api/record";

export function NationalityField({ facts, manage, sending, conflict, children, onSave }: {
  facts?: PersonalFacts; manage: boolean; sending?: string; conflict?: FieldConflict;
  children: ReactNode; onSave: (code: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState("");
  const label = t("empCard.f.nationality");
  const raw = facts?.nationality ?? "";
  const options = (facts?.countries ?? []).map(country => ({
    id: country.code, name: `${i18n.locale === "ko" ? country.label_ko : country.label_en} · ${country.code}`,
  })).sort((a, b) => a.name.localeCompare(b.name, i18n.locale));
  const display = (code: string) => options.find(o => o.id === code)?.name ?? code;
  const save = (code: string) => { setEditing(false); if (code !== raw) onSave(code); };
  return <>
    <FieldRow label={editing ? "" : label} edit={editing} mark={manage && !editing && sending === undefined &&
      <FieldMark kind="inline" field={label} onPress={() => { setQuery(raw ? display(raw) : ""); setEditing(true); }} />}>
      {editing ? <div>
        <ServerPicker label={label} group={label} query={query} onQueryChange={setQuery}
          instructions={t("empCard.f.nationality.hint")}
          value={raw || null} onChange={code => { if (code) save(code); }} empty={t("common.failed.code.nationality_unknown")}
          options={options.filter(o => `${o.name} ${o.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))} />
        {raw && <Button variant="ghost" onClick={() => save("")}>{t("empCard.nationality.clear")}</Button>}
        <Button variant="ghost" onClick={() => setEditing(false)}>{t("common.cancel")}</Button>
      </div> : <>{(sending === undefined ? raw : sending) ? display(sending ?? raw) : t("empCard.none")}{children}</>}
    </FieldRow>
    {conflict && <InlineConflict field={label} now={raw} c={conflict} />}
  </>;
}
