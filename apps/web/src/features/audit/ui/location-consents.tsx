// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import type { ReadState } from "../../../lib/react/query-view";
import { saveFile } from "../../../lib/download";
import { CommandError } from "../../../lib/react/command-error";
import { useIsDesktop } from "../../../lib/react/use-desktop";
import { AuditTabs } from "../../../reference/audit/ui/audit-tabs";
import { authzQuery } from "../../../reference/authz/api";
import { branchesQuery } from "../../../reference/org/api";
import { Button } from "../../../ui/button/button";
import { EmptyState } from "../../../ui/empty-state";
import { Field } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { KeyValue } from "../../../ui/key-value/key-value";
import { LongTable } from "../../../ui/long-table/long-table";
import { ListRecord } from "../../../ui/patterns/list-record";
import { consentLedgerCsv, consentLedgerQuery, type ConsentEvent } from "../api";
import { consentCode } from "../present";
import s from "./audit.module.css";

const limit = 25;
export function LocationConsents() {
  const authority = useQuery(authzQuery);
  const cap = authority.isError ? undefined : authority.data?.capabilities.find(grant => grant.feature === "served_location_consent_ledger");
  const branches = useQuery({ ...branchesQuery, enabled: !!cap });
  const names = new Map(branches.data?.map(branch => [branch.id, branch.name]));
  const ids = cap?.branch_scope.kind === "branches" ? cap.branch_scope.branches ?? [] : [...names.keys()];
  const [scope, setScope] = useState<string>();
  const initial = cap?.org_wide ? "all" : ids.length === 1 ? ids[0] : undefined;
  const validSelection = scope === "all" ? cap?.org_wide : scope && ids.includes(scope);
  const branch = validSelection ? scope : initial;
  const ready = !!cap && !!branch;
  return <ConsentRegister key={branch ?? "none"} branch={branch} ready={ready} catalog={branches} names={names}
    filter={<Field label={t("audit.consents.branch")} required={!cap?.org_wide}>{props =>
      <SelectInput {...props} value={branch ?? ""} onChange={e => setScope(e.target.value)}>
        {cap?.org_wide ? <option value="all">{t("audit.consents.all")}</option> : <option value="">{t("audit.consents.pick")}</option>}
        {ids.map(id => <option key={id} value={id}>{names.get(id) ?? id}</option>)}
      </SelectInput>}</Field>} hasOptions={ids.length > 0} />;
}

function ConsentRegister({ branch, ready, names, filter, hasOptions, catalog }: {
  branch?: string; ready: boolean; names: ReadonlyMap<string, string>; filter: ReactNode; hasOptions: boolean;
  catalog: ReadState;
}) {
  const [offset, setOffset] = useState(0);
  const [selected, select] = useState<string | null>();
  const desktop = useIsDesktop();
  const query = { limit, offset, branch_id: branch === "all" ? undefined : branch };
  const ledger = useQuery({ ...consentLedgerQuery(query), enabled: ready });
  const download = useMutation({ mutationFn: () => consentLedgerCsv(query), onSuccess: blob => saveFile(blob, "location-consent-ledger.csv") });
  const rows = ready ? ledger.data?.items ?? [] : [];
  const row = selected === undefined && desktop ? rows[0] : rows.find(event => event.id === selected);
  const page = ledger.data;
  function turn(next: number) {
    select(undefined); download.reset(); setOffset(next);
  }
  return <ListRecord q={ready ? ledger : catalog} head={{ title: t("audit.consents.title"), titleId: "consents-title" }} tabs={<AuditTabs />}
    filters={filter}
    list={!ready ? <EmptyState title={t(hasOptions ? "audit.consents.pick" : "audit.consents.noBranches")}
          reason={t(hasOptions ? "audit.consents.selectReason" : "audit.consents.noBranchReason")} />
      : rows.length ? <LongTable label={t("audit.consents.title")} rows={rows} rowId={event => event.id}
        onRowAction={select} activeRowId={row?.id} total={rows.length} hasMore={false} onLoadMore={() => {}}
        density="compact" mobileLayout="compact" empty={t("audit.consents.empty")} columns={[
          { id: "action", header: t("audit.consents.action"), card: "title", rowHeader: true, width: "2fr", cell: event => consentCode(event.action) },
          { id: "branch", header: t("audit.consents.branch"), card: "fact", width: "1fr", cell: event => names.get(event.branch_id) ?? event.branch_id },
          { id: "state", header: t("audit.consents.after"), card: "fact", width: "1fr", cell: event => consentCode(event.to_status) },
          { id: "date", header: t("audit.consents.date"), card: "omit", width: 178, cell: event => fmtDateTime(event.occurred_at) },
        ]} /> : <EmptyState title={t("audit.consents.empty")} reason={t("audit.consents.emptyReason")} />}
    foot={ready && page && <div className={s.foot}>
      {rows.length > 0 && <>{t("audit.consents.page", { start: offset + 1, end: offset + rows.length, total: page.total })}
        <Button disabled={download.isPending} onClick={() => download.mutate()}>{t("audit.consents.csv")}</Button></>}
      {download.error && <CommandError error={download.error} read />}
      {(page.total > limit || offset > 0) && <>
        <Button disabled={offset === 0} onClick={() => turn(Math.max(0, offset - limit))}>{t("audit.log.pagination.prev")}</Button>
        <Button disabled={offset + limit >= page.total} onClick={() => turn(offset + limit)}>{t("audit.log.pagination.next")}</Button>
      </>}
    </div>}
    record={row && { id: row.id, label: t("audit.consents.record"), title: consentCode(row.action), meta: fmtDateTime(row.occurred_at),
      onClose: () => select(null), children: <EventFacts row={row} branch={names.get(row.branch_id) ?? row.branch_id} /> }} />;
}

function EventFacts({ row, branch }: { row: ConsentEvent; branch: string }) {
  return <KeyValue density="dense" items={[
    { key: "account", label: t("audit.consents.person"), value: row.user_id },
    { key: "branch", label: t("audit.consents.branch"), value: branch },
    { key: "id", label: t("audit.consents.id"), value: row.consent_id },
    { key: "from", label: t("audit.consents.before"), value: consentCode(row.from_status) },
    { key: "to", label: t("audit.consents.after"), value: consentCode(row.to_status) },
    ...(row.actor ? [{ key: "actor", label: t("audit.consents.actor"), value: row.actor }] : []),
    { key: "created", label: t("audit.consents.created"), value: fmtDateTime(row.created_at) },
  ]} />;
}
