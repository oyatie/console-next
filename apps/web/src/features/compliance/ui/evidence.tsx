// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { useServedCapability } from "../../../reference/authz/ui/use-documents-served";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { EmptyState } from "../../../ui/empty-state";
import { Field } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { KeyValue } from "../../../ui/key-value/key-value";
import { LongTable } from "../../../ui/long-table/long-table";
import { Pager } from "../../../ui/pager";
import { Worklist } from "../../../ui/patterns/worklist";
import { Receipt } from "../../../ui/receipt/receipt";
import type { components } from "@console/api/schema";
import { PAGE_SIZE } from "../api";
import { applyEvidence, evidencePath, evidenceQuery, evidenceStates, evLabel, targetTypes } from "../api/evidence";

export function EvidenceWorklist() {
  const [status, setStatus] = useState<components["schemas"]["EvidenceBindingStatus"]>();
  const [target, setTarget] = useState<components["schemas"]["EvidenceTargetType"]>();
  const [page, setPage] = useState(0);
  const [selected, select] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [receipt, setReceipt] = useState(false);
  const q = useQuery(evidenceQuery(page, status, target));
  const rows = q.data?.items ?? [];
  const row = rows.find(item => item.id === selected);
  const propose = useServedCapability("served_compliance_evidence_link");
  const accept = useServedCapability("served_compliance_evidence_accept");
  const command = useCommand({ run: applyEvidence, invalidates: [evidencePath], settle: true,
    onSuccess: () => { setConfirm(false); setReceipt(true); } });
  const inspect = (id: string) => { select(id); setConfirm(false); setReceipt(false); command.reset(); };
  const resetFilter = () => { setPage(0); inspect(""); };
  return <Worklist q={q} head={{ title: t("compliance.evidence"), titleId: "evidence-bindings", actions: propose &&
    <Link to="/compliance/evidence/new" className={buttonClass("primary")}>{t("compliance.propose")}</Link> }}
    filters={<><Field label={t("compliance.status")} required={null}>{p => <SelectInput {...p} value={status ?? ""} onChange={e => {
      resetFilter(); setStatus(evidenceStates.find(s => s === e.target.value));
    }}><option value="">{t("compliance.allStates")}</option>{evidenceStates.map(s => <option key={s} value={s}>{evLabel(s)}</option>)}</SelectInput>}</Field>
    <Field label={t("compliance.targetKind")} required={null}>{p => <SelectInput {...p} value={target ?? ""} onChange={e => {
      resetFilter(); setTarget(targetTypes.find(v => v === e.target.value));
    }}><option value="">{t("compliance.allTypes")}</option>{targetTypes.map(s => <option key={s} value={s}>{evLabel(s)}</option>)}</SelectInput>}</Field></>}
    list={<><LongTable label={t("compliance.evidence")} rows={rows} rowId={r => r.id} total={rows.length} hasMore={false} onLoadMore={() => {}}
      empty={<EmptyState title={t("compliance.evidenceEmpty")} reason={null} />} onRowAction={inspect} activeRowId={row?.id}
      columns={[
        { id: "target", header: t("compliance.target"), rowHeader: true, card: "title", cell: r => r.evidence_target_id },
        { id: "type", header: t("compliance.targetKind"), card: "fact", cell: r => evLabel(r.evidence_target_type) },
        { id: "status", header: t("compliance.status"), card: "status", cell: r => evLabel(r.status) },
      ]} />
      {q.data && <Pager offset={page * PAGE_SIZE} limit={PAGE_SIZE} total={q.data.total} onPage={offset => { inspect(""); setPage(offset / PAGE_SIZE); }} />}
      {receipt && <Receipt state="recorded" message={t("compliance.accepted")} />}</>}
    record={row && { id: row.id, title: row.evidence_target_id, label: t("compliance.evidenceRecord"), onClose: () => inspect(""),
      children: <><KeyValue items={[
        { key: "control", label: t("compliance.ref.control"), value: row.control_id },
        { key: "obligation", label: t("compliance.ref.obligation"), value: row.obligation_id },
        { key: "status", label: t("compliance.status"), value: evLabel(row.status) },
        { key: "confidence", label: t("compliance.confidence"), value: evLabel(row.confidence) },
        { key: "audit", label: t("compliance.auditId"), value: row.source_audit_event_id },
        { key: "digest", label: t("compliance.digest"), value: row.hash_sha256 },
        { key: "collector", label: t("compliance.collector"), value: row.collected_by },
        { key: "collected", label: t("compliance.collected"), value: row.collected_at && fmtDateTime(row.collected_at) },
        { key: "from", label: t("compliance.validFrom"), value: row.valid_from && fmtDate(row.valid_from) },
        { key: "to", label: t("compliance.validTo"), value: row.valid_to && fmtDate(row.valid_to) },
      ]} />
      {row.status === "PROPOSED" && accept && (confirm ? <>
        <Button variant="primary" disabled={command.isPending} onClick={() => command.mutate({ accept: row.id })}>{t("compliance.confirmAccept")}</Button>
        <Button disabled={command.isPending} onClick={() => setConfirm(false)}>{t("common.cancel")}</Button>
      </> : <Button onClick={() => setConfirm(true)}>{t("compliance.accept")}</Button>)}
      <CommandError error={command.error} /></> }} />;
}
