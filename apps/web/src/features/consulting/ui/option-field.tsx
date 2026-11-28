// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { Field, TextInput } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { optionsQuery, type OptionKind } from "../api";

export function OptionField({ kind, engagement, label, required, value, onChange }: {
  kind: OptionKind; engagement?: string; label: string; required: boolean; value: string; onChange: (id: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const query = useQuery(optionsQuery(kind, search, offset, engagement));
  function changePage(next: number) { setOffset(next); onChange(""); }
  return <>
    <Field label={t("consulting.searchOptions", { label })} required={null}>{p => <TextInput {...p} value={search}
      onChange={e => { setSearch(e.target.value); changePage(0); }} />}</Field>
    <QueryState q={query} inline>{page => <>
      <Field label={label} required={required} hint={!page.items.length && t("consulting.noOptions")}>{p =>
        <SelectInput {...p} value={value} onChange={e => onChange(e.target.value)}>
          <option value="">{t("consulting.choose")}</option>
          {page.items.map(item => <option key={item.id} value={item.id}>{item.label}{item.recorded_at && ` · ${fmtDateTime(item.recorded_at)}`}</option>)}
        </SelectInput>}</Field>
      {offset > 0 && <Button onClick={() => changePage(Math.max(0, offset - 30))}>{t("consulting.prev")}</Button>}
      {page.next_offset !== null && <Button onClick={() => changePage(page.next_offset!)}>{t("consulting.next")}</Button>}
    </>}</QueryState>
  </>;
}
