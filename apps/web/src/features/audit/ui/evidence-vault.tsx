// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { evidenceQuery } from "../api";
import { vaultCode } from "../present";
import { useIsDesktop } from "../../../lib/react/use-desktop";
import { AuditTabs } from "../../../reference/audit/ui/audit-tabs";
import { Button, Form } from "../../../ui/button/button";
import { EmptyState } from "../../../ui/empty-state";
import { Field, TextInput } from "../../../ui/field/field";
import { LongTable } from "../../../ui/long-table/long-table";
import { ListRecord } from "../../../ui/patterns/list-record";
import { EvidenceRecord } from "./evidence-record";
import s from "./audit.module.css";

export function EvidenceVault() {
  const [term, setTerm] = useState("");
  const [query, setQuery] = useState("");
  const [pages, setPages] = useState<string[]>([]);
  const [snapshot, setSnapshot] = useState<number>();
  // undefined opens the first record on desktop, null preserves an explicit dismissal.
  const [selection, select] = useState<string | null>();
  const desktop = useIsDesktop();
  const q = useQuery(evidenceQuery({ q: query || undefined, limit: 25, as_of: snapshot, cursor: pages.at(-1) }));
  const rows = q.data?.items ?? [];
  const selected = selection === undefined && desktop ? rows[0] : rows.find(row => row.id === selection);
  function turn(next: string[]) {
    setPages(next);
    select(undefined);
  }
  return <ListRecord q={q} head={{ title: t("audit.vault.title"), titleId: "evidence-title" }} tabs={<AuditTabs />}
    filters={<Form className={s.filters} onSubmit={() => { setQuery(term.trim()); setSnapshot(undefined); turn([]); }}>
      <Field label={t("audit.vault.search")} required={null}>{props => <TextInput {...props} value={term} onChange={e => setTerm(e.target.value)} />}</Field>
      <Button type="submit">{t("audit.log.filter.apply")}</Button>
    </Form>}
    list={rows.length ? <LongTable label={t("audit.vault.title")} rows={rows} rowId={row => row.id}
      activeRowId={selected?.id} onRowAction={select} total={rows.length} hasMore={false} onLoadMore={() => {}}
      density="compact" mobileLayout="compact" empty={t("audit.vault.empty")}
      columns={[
        { id: "title", header: t("audit.vault.record"), rowHeader: true, card: "title", width: "2fr", cell: row => row.title },
        { id: "code", header: t("audit.vault.code"), card: "fact", width: "1fr", cell: row => row.code },
        { id: "hold", header: t("audit.vault.hold"), card: "fact", width: "1fr", cell: row => vaultCode(row.legal_hold_state) },
        { id: "updated", header: t("audit.vault.updated"), card: "omit", width: 178, cell: row => fmtDateTime(row.updated_at) },
      ]} /> : <EmptyState title={t("audit.vault.empty")} reason={t("audit.vault.emptyReason")} />}
    foot={q.data && (pages.length || q.data.next_cursor) ? <div className={s.foot}>
      <Button disabled={!pages.length} onClick={() => turn(pages.slice(0, -1))}>{t("audit.log.pagination.prev")}</Button>
      <Button disabled={!q.data.next_cursor} onClick={() => { if (q.data.next_cursor) { setSnapshot(q.data.as_of); turn([...pages, q.data.next_cursor]); } }}>{t("audit.log.pagination.next")}</Button>
    </div> : undefined}
    record={selected && { id: selected.id, label: t("audit.vault.record"), title: selected.title, meta: selected.code,
      onClose: () => select(null), children: <EvidenceRecord key={selected.id} id={selected.id} /> }} />;
}
