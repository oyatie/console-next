import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { JOB_TITLE_KIND, label as enumLabel } from "../../../lib/labels";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { jobTitlesQuery, type JobTitleKind } from "../api";
import { activeTitles } from "../domain/titles";
import { ServerPicker } from "../../../ui/server-picker/server-picker";
import { shouldServerSearch } from "../../../ui/server-picker/size";
import { TitleAdd } from "./title-add";

/** One typed catalog picker for corrections and changes, with in-place catalog creation. */
export function CatalogPicker({ kind, label, currentId, value, onChange, required = true }: {
  kind: JobTitleKind; label: string; currentId?: string | null;
  value: string | null; onChange: (id: string) => void; required?: boolean;
}) {
  const catalog = useQuery(jobTitlesQuery);
  const [query, setQuery] = useState("");
  return <QueryState q={catalog}>{(data) => {
    const options = activeTitles(data.items, kind).map((x) => ({ value: x.id, label: x.label, disabled: x.id === currentId ? t("empFix.catalog.current") : undefined }));
    const add = data.can_manage ? <TitleAdd kind={kind} what={enumLabel(JOB_TITLE_KIND, kind)} onAdded={onChange} /> : undefined;
    const clear = !required && value ? <Button variant="ghost" onClick={() => onChange("")}>{t("lifecycle.appoint.keep")}</Button> : undefined;
    if (shouldServerSearch(options.length)) return <>
      <ServerPicker label={label} isRequired={required} query={query} onQueryChange={setQuery} value={value}
        onChange={(id) => onChange(id ?? "")} options={options.filter((x) => !x.disabled && x.label.includes(query.trim())).map((x) => ({ id: x.value, name: x.label }))}
        group={label} empty={t("lifecycle.promote.none")} />
      {add}{clear}
    </>;
    return <>
      <ChoiceField label={label} required={required} look="chips" options={options} value={value} onChange={onChange}
        add={add} />
      {clear}
      {!options.length && <p>{t(data.can_manage ? "empFix.catalog.empty" : "empFix.catalog.denied", { field: label })}</p>}
    </>;
  }}</QueryState>;
}
