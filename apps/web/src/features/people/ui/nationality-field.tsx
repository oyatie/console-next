// SPDX-License-Identifier: LicenseRef-Proprietary
import { type ReactNode } from "react";
import { i18n, t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { InlineField } from "./inline-field";
import { ServerPicker } from "../../../ui/server-picker/server-picker";
import { type FieldConflict } from "./inline-conflict";
import type { PersonalFacts } from "../api/record";

export function NationalityField({ facts, manage, sending, conflict, children, onSave }: {
  facts?: PersonalFacts; manage: boolean; sending?: string; conflict?: FieldConflict;
  children: ReactNode; onSave: (code: string) => void;
}) {
  const label = t("empCard.f.nationality");
  const raw = facts?.nationality ?? "";
  const options = (facts?.countries ?? []).map(country => ({
    id: country.code, search: `${country.code} ${country.label_ko} ${country.label_en} ${country.search_terms ?? ""}`.toLocaleLowerCase(), name: `${i18n.locale === "ko" ? country.label_ko : country.label_en} · ${country.code}`,
  })).sort((a, b) => a.name.localeCompare(b.name, i18n.locale));
  const display = (code: string) => options.find(o => o.id === code)?.name ?? code;
  return <InlineField label={label} raw={raw} manage={manage} sending={sending} conflict={conflict} onSave={onSave}
    display={code => <>{code ? display(code) : t("empCard.none")}{children}</>}
    editor={(query, setQuery, save, close) => <>
      <ServerPicker label={label} group={label} query={query} onQueryChange={setQuery}
        instructions={t("empCard.f.nationality.hint")}
        value={raw || null} onChange={code => { if (code) save(code); }} empty={t("uiServerPicker.none")}
        options={options.filter(o => o.search.includes(query.trim().toLocaleLowerCase()))} />
      {raw && <Button variant="ghost" onClick={() => save("")}>{t("empCard.nationality.clear")}</Button>}
      <Button variant="ghost" onClick={close}>{t("common.cancel")}</Button>
    </>}>
    {raw ? display(raw) : t("empCard.none")}{children}
  </InlineField>;
}
