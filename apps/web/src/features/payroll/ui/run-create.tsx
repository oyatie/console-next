// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { todayKst } from "../../../lib/pure/today";
import { Page } from "../../../ui/page/page";
import { EmptyState } from "../../../ui/empty-state";
import { Composer } from "../../../ui/composer/composer";
import { Field, TextInput } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { DateField } from "../../../ui/date/date-field";
import { createPayrollRun, payGroupsQuery, type CreatePayrollRun, type PayGroup } from "../api";
import { runInput } from "../present";

export function PayrollRunCreate() {
  const groups = useQuery(payGroupsQuery);
  return <Page floorplan="form" head={{ title: t("payroll.create.title"), tools: <Link to="/payroll">{t("payroll.title")}</Link> }}>
    <QueryState q={groups} layout="list">{data => data.items.length
      ? <RunForm groups={data.items} entities={data.legal_entities} />
      : <EmptyState title={t("payroll.create.noGroups")} reason={t("payroll.create.noGroupsReason")} />}</QueryState>
  </Page>;
}
function RunForm({ groups, entities }: { groups: readonly PayGroup[]; entities: readonly { id: string; name: string | null }[] }) {
  const [draft, setDraft] = useState<Partial<CreatePayrollRun>>({});
  const [attempted, setAttempted] = useState(false);
  const navigate = useNavigate();
  const input = runInput(draft, groups);
  const change = (key: keyof CreatePayrollRun, value: string) => setDraft(current => ({ ...current, [key]: value }));
  const save = useCommand({ run: createPayrollRun, invalidates: ["/api/v1/payroll/runs"],
    announce: run => t("payroll.create.saved", { name: run.source_label }),
    onSuccess: run => { void navigate({ to: "/payroll/runs/$id", params: { id: run.id } }); } });
  return <Composer layout="inline" title={t("payroll.create.details")} action={{ kind: "payrollRun", mode: "save" }} pending={save.isPending}
    notice={<CommandError error={save.error} />} consequence={input ? t("payroll.create.consequence") : undefined}
    onSubmit={() => { setAttempted(true); if (!input) return false; save.mutate(input); }}>
    <Field label={t("payroll.create.group")} required>{control => <SelectInput {...control} value={draft.pay_group_id ?? ""} onChange={event => change("pay_group_id", event.target.value)}>
      <option value="" disabled>{t("payroll.setup.choose")}</option>
      {groups.map(group => <option key={group.id} value={group.id}>{entities.find(entity => entity.id === group.legal_entity_id)?.name ?? t("payroll.entityUnnamed")} · {group.name}</option>)}
    </SelectInput>}</Field>
    <Field label={t("payroll.runName")} required>{control => <TextInput {...control} value={draft.source_label ?? ""} onChange={event => change("source_label", event.target.value)} />}</Field>
    {(["period_start", "period_end"] as const).map(key => <DateField key={key} label={t(key === "period_start" ? "payroll.create.start" : "payroll.create.end")} required today={todayKst()}
      value={draft[key] ?? ""} onChange={value => change(key, value)}
      min={key === "period_end" ? draft.period_start : undefined} />)}
    {attempted && !input && <p role="alert">{t("payroll.create.required")}</p>}
  </Composer>;
}
