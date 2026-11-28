// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { SEARCH_DEBOUNCE_MS } from "../../../lib/freshness";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { Composer } from "../../../ui/composer/composer";
import { DateInput } from "../../../ui/date/date-input";
import { EmptyState } from "../../../ui/empty-state";
import { Field } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { Page } from "../../../ui/page/page";
import { Receipt } from "../../../ui/receipt/receipt";
import { ServerPicker } from "../../../ui/server-picker/server-picker";
import { assignMembership, payGroupCandidates, payGroupsQuery } from "../api";

export function PayGroupMembersPage() {
  const groups = useQuery(payGroupsQuery);
  const [targetId, setTarget] = useState("");
  const [date, setDate] = useState(todayKst);
  const [invalidDate, setInvalidDate] = useState(false);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);
  const [employeeId, setEmployee] = useState<string | null>(null);
  const [receipt, setReceipt] = useState("");
  const options = groups.data?.items.filter(group => groups.data?.manageable_group_ids?.includes(group.id)) ?? [];
  const target = options.find(group => group.id === targetId);
  const candidates = useQuery({
    ...payGroupCandidates({ pay_group_id: targetId, effective_from: date, q: query }),
    enabled: Boolean(target && date && !invalidDate && query && query === search.trim()),
    retry: false,
  });
  const rows = query === search.trim() ? candidates.data ?? [] : [];
  const selected = rows.find(row => row.employee_id === employeeId);
  const groupName = (id: string | null) => groups.data?.items.find(group => group.id === id)?.name ?? t("payroll.members.unassigned");
  const input = selected && target && date && !invalidDate && !candidates.isError && selected.current_pay_group_id !== target.id
    ? { employee_id: selected.employee_id, pay_group_id: target.id, effective_from: date, expected_pay_group_id: selected.current_pay_group_id }
    : null;
  const [expectedSource, setExpectedSource] = useState<string | null>(null);
  const ready = input && input.expected_pay_group_id === expectedSource;
  const save = useCommand({
    run: assignMembership,
    invalidates: ["/api/v1/payroll/pay-group-memberships", "/api/v1/payroll/runs"],
    onSuccess: () => { setReceipt(t("payroll.members.saved")); setEmployee(null); setSearch(""); },
  });
  return <Page floorplan="P-05" head={{ title: t("payroll.members.title"), tools: <Link to="/payroll/setup">{t("payroll.setup.page")}</Link> }}>
    <QueryState q={groups} layout="list">{() => options.length === 0 ?
      <EmptyState title={t("payroll.members.noGroups")} reason={null} /> :
      <Composer title={t("payroll.members.assign")} layout="inline" action={{ kind: "payGroup", mode: "assign" }}
        pending={save.isPending} incomplete={!ready} error={save.error}
        notice={<><CommandError error={save.error} />{receipt && <Receipt state="applied" message={receipt} onDismiss={() => setReceipt("")} />}</>}
        consequence={selected && target && date && !invalidDate ? selected.current_pay_group_id === target.id ? t("payroll.members.same") : t("payroll.members.change", { name: selected.name, from: groupName(selected.current_pay_group_id), to: target.name, date: fmtDate(date) }) : undefined}
        onSubmit={() => { if (!ready || !input) return false; save.mutate(input); }}>
        <Field label={t("payroll.members.target")} required>{control => <SelectInput {...control} value={targetId}
          onChange={event => { setTarget(event.target.value); setEmployee(null); setSearch(""); }}>
          <option disabled value="">{t("payroll.setup.choose")}</option>
          {options.map(group => <option value={group.id} key={group.id}>{groups.data?.legal_entities.find(e => e.id === group.legal_entity_id)?.name} · {group.name}</option>)}
        </SelectInput>}</Field>
        <Field label={t("payroll.employee.effective")} required>{control => <DateInput {...control} value={date} onInvalid={setInvalidDate}
          onChange={value => { setDate(value); setEmployee(null); setSearch(""); }} />}</Field>
        <ServerPicker label={t("payroll.members.search")} group={t("payroll.members.people")} isRequired
          query={search} onQueryChange={setSearch} loading={candidates.isFetching || query !== search.trim()}
          disabledReason={!target || !date || invalidDate ? t("payroll.members.chooseFirst") : undefined}
          empty={t("payroll.members.none")} readError={candidates.isError ? <CommandError read error={candidates.error} /> : undefined}
          value={employeeId} onChange={id => { setEmployee(id); setExpectedSource(rows.find(row => row.employee_id === id)?.current_pay_group_id ?? null); }}
          options={rows.map(row => ({ id: row.employee_id, name: row.name, code: row.employee_number ?? undefined, context: groupName(row.current_pay_group_id) }))} />
      </Composer>
    }</QueryState>
  </Page>;
}
