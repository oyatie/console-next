// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { EmployeeView, EmployeeViewFilters } from "@console/api/pending";
import { t } from "@console/i18n";
import { createEmployeeView, employeeViewsQuery } from "../api/roster";
import { COMMAND_NOT_APPLIED, useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { Composer } from "../../../ui/composer/composer";
import { Field, TextInput } from "../../../ui/field/field";
import { EmptyState } from "../../../ui/empty-state";

export function RosterSavedViews({ filters, onApply }: { filters: EmployeeViewFilters; onApply: (filters: EmployeeViewFilters) => void }) {
  const [open, setOpen] = useState(false);
  const list = useQuery(employeeViewsQuery);
  return <>
    <Button disabled={!list.data || list.isError} onClick={() => setOpen(true)}>{t("directoryViews.open")}</Button>
    {list.isError && <QueryState q={list} inline>{() => null}</QueryState>}
    {open && list.data && !list.isError && <SavedViews list={list} filters={filters} onApply={value => { onApply(value); setOpen(false); }} onClose={() => setOpen(false)} />}
  </>;
}

function SavedViews({ list, filters, onApply, onClose }: { list: UseQueryResult<Awaited<ReturnType<typeof employeeViewsQuery.queryFn>>>; filters: EmployeeViewFilters; onApply: (filters: EmployeeViewFilters) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [missing, setMissing] = useState(false);
  const save = useCommand<Omit<EmployeeView, "id">, EmployeeView>({
    run: createEmployeeView,
    verify: async (_input, key) => (await employeeViewsQuery.queryFn())?.items.find(view => view.id === key) ?? COMMAND_NOT_APPLIED,
    invalidates: ["/api/v1/me/employee-views"], settle: true,
    onSuccess: () => { setName(""); setMissing(false); },
    announce: () => t("directoryViews.saved"),
  });
  return <Composer title={t("directoryViews.open")} action={{ kind: "directoryView", mode: "save" }}
    onClose={onClose} pending={save.isPending} loading={list.isPending} locked={list.isError}
    notice={<CommandError error={save.error} />}
    onSubmit={() => {
      if (!name.trim()) { setMissing(true); return false; }
      setMissing(false);
      save.mutate({ name: name.trim(), filters });
    }}>
    <QueryState q={list} inline>{data => data && <>
      {data.items.length ? <div className="form">{data.items.map(view => <Button key={view.id} onClick={() => onApply(view.filters)}>{view.name}</Button>)}</div> : <EmptyState title={t("directoryViews.empty")} reason={t("directoryViews.hint")} />}
      <Field label={t("directoryViews.name")} required error={missing ? t("directoryViews.required") : undefined}>
        {control => <TextInput {...control} value={name} onChange={event => { setName(event.target.value); setMissing(false); }} />}
      </Field>
    </>}</QueryState>
  </Composer>;
}
