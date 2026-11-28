// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import { Field, TextInput } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { Pager } from "../../../ui/pager";
import { controlsQuery, frameworksQuery, obligationsQuery, PAGE_SIZE, regulationsQuery } from "../api";

export type ReferenceKind = "framework" | "control" | "obligation" | "regulation";
export function ReferenceField({ kind, canRead, value, onChange, framework = "", disabled, optional = false }: {
  kind: ReferenceKind; canRead: boolean; value: string; onChange: (value: string) => void; framework?: string; disabled: boolean; optional?: boolean;
}) {
  const [page, setPage] = useState(0);
  const frameworks = useQuery({ ...frameworksQuery(page), enabled: canRead && kind === "framework" });
  const regulations = useQuery({ ...regulationsQuery(page), enabled: canRead && kind === "regulation" });
  const obligations = useQuery({ ...obligationsQuery(page), enabled: canRead && kind === "obligation" });
  const controls = useQuery({ ...controlsQuery(page, framework), enabled: canRead && kind === "control" && !!framework });
  const query = { framework: frameworks, regulation: regulations, obligation: obligations, control: controls }[kind];
  const label = t(`compliance.ref.${kind}`);
  if (!canRead) return <Field label={t("compliance.knownId", { name: label })} required>{p => <TextInput {...p} value={value} disabled={disabled} onChange={e => onChange(e.target.value.trim())} />}</Field>;
  if (kind === "control" && !framework) return null;
  const opts = kind === "framework" ? frameworks.data?.items.map(r => ({ id: r.id, name: r.name })) :
    (kind === "control" ? controls.data?.items : kind === "regulation" ? regulations.data?.items : obligations.data?.items)?.map(r => ({ id: r.id, name: r.title }));
  return <QueryState<unknown> q={query}>{() => <>
    <Field label={label} required={!optional}>{p => <SelectInput {...p} disabled={disabled} value={value} onChange={e => onChange(e.target.value)}>
      <option value="">{t("compliance.choose")}</option>
      {opts?.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
    </SelectInput>}</Field>
    {!!query.data && query.data.total > PAGE_SIZE && <Pager offset={page * PAGE_SIZE} limit={PAGE_SIZE} total={query.data.total}
      onPage={n => { onChange(""); setPage(n / PAGE_SIZE); }} />}
  </>}</QueryState>;
}
