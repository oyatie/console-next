// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTimeShort } from "@console/i18n/format";
import { useCan } from "../../../reference/authz/ui/use-can";
import s from "./correction-register.module.css";
import { QueryState } from "../../../lib/react/query-state";
import { useCommand } from "../../../lib/react/command";
import { BIZ_KIND, label } from "../../../lib/labels";
import { FORMATS } from "../../../lib/pure/formats";
import { SectionHead } from "../../../ui/card/section-head";
import { ActionBar } from "../../../ui/action-bar/action-bar";
import { buttonClass } from "../../../ui/button/button-class";
import { Button } from "../../../ui/button/button";
import { EmptyState } from "../../../ui/empty-state";
import { Chip } from "../../../ui/chip";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { KeyValue } from "../../../ui/key-value/key-value";
import { Sheet } from "../../../ui/sheet/sheet";
import { Table } from "../../../ui/table";
import { type IdentifierCorrectionCase, correctionCaseQuery, correctionRegisterQuery, correctIdentifier, correctRegistrationNumber, decideCorrection, documentQuery, ENTITY_READS, reviewCorrection } from "../api";
import { EntityError } from "./entity-error";
import { OpenOriginal } from "./open-original";

type Case = IdentifierCorrectionCase;
const statusText = (r: Case) => t(`entityRecord.corrections.status.${r.reviewed_at ? "REVIEWED" : r.status}`);
const fieldText = (r: Case) => r.proposal ? t(`entityRecord.id.field.${r.proposal.field}`) : t("entityRecord.corrections.title");
const valueText = (r: Case) => !r.proposal ? "—" : r.proposal.field === "crn" ? FORMATS.corpRegNo.display(r.proposal.value) : r.proposal.field === "brn" ? FORMATS.bizRegNo.display(r.proposal.value) : label(BIZ_KIND, r.proposal.value);

/** Org-wide readers only: branch-scoped entity viewers have no register read permission. */
export function CorrectionRegister(props: { entityId?: string; correctionId?: string; onSelect?: (id: string | null) => void }) {
  const can = useCan();
  return can("legal_entity_manage", "tenant") || can("org_change_apply", "tenant") ? <Register {...props} /> : null;
}

function Register({ entityId, correctionId, onSelect }: { entityId?: string; correctionId?: string; onSelect?: (id: string | null) => void }) {
  const [offsets, setOffsets] = useState([0]);
  const [selected, setSelected] = useState<string | null>(null);
  const select = onSelect ?? setSelected;
  const active = correctionId ?? selected;
  const q = useQuery({ ...correctionRegisterQuery(entityId, offsets.at(-1)), retry: false, refetchOnMount: "always" });
  return (
    <section id="identifier-corrections" aria-labelledby="identifier-corrections-title">
      <SectionHead level={2} id="identifier-corrections-title">
        {t("entityRecord.corrections.title")}
      </SectionHead>
      <QueryState q={q} empty={(data) => data.items.length ? null : <EmptyState title={t("entityRecord.corrections.empty")} reason={null} />}>
        {(data) => <>
          <Table label={t("entityRecord.corrections.title")} rows={data.items} rowId={(r) => r.id} onSelect={select} columns={[
            { header: t("entityRecord.corrections.subject"), cell: (r) => <>{r.entity_name} · {fieldText(r)} <b>{valueText(r)}</b></> },
            { header: t("entityRecord.corrections.state"), cell: (r) => <div className={s.status}>{(["APPROVED", "RECORDED"] as const).map((status) => <div key={status} aria-hidden className={s.measure}><Chip>{t(`entityRecord.corrections.status.${status}`)}</Chip></div>)}<div><Chip tone={r.status === "PENDING" || r.status === "RECORDED" && !r.reviewed_at ? "warn" : "neutral"}>{statusText(r)}</Chip></div></div>, fit: true },
            { header: t("entityRecord.corrections.due"), cell: (r) => fmtDateTimeShort(r.review_due_at ?? r.expires_at), fit: true },
          ]} />
          <ActionBar actions={<>
            <Button disabled={offsets.length === 1} onClick={() => setOffsets((pages) => pages.slice(0, -1))}>{t("entityRecord.corrections.previous")}</Button>
            <Button disabled={data.next_offset === null} onClick={() => data.next_offset !== null && setOffsets((pages) => [...pages, data.next_offset!])}>{t("entityRecord.corrections.next")}</Button>
          </>} />
        </>}
      </QueryState>
      {active && <CorrectionDetail key={active} id={active} row={q.data?.items.find((item) => item.id === active)} onClose={() => select(null)} />}
    </section>
  );
}

function CorrectionDetail({ id, row, onClose }: { id: string; row?: Case; onClose: () => void }) {
  const q = useQuery({ ...correctionCaseQuery(id), refetchOnMount: "always", retry: false });
  const r = q.data?.items[0];
  const [note, setNote] = useState("");
  const command = useCommand({
    run: async (action: "APPROVE" | "DECLINE" | "APPLY" | "REVIEW", key: string) => {
      if (action === "REVIEW") return reviewCorrection(id, note);
      if (action !== "APPLY") return decideCorrection(id, action, note, r!.payload_hash);
      const proposal = r!.proposal!;
      const body = { ...proposal, exception_id: id };
      return proposal.field === "brn" ? correctRegistrationNumber(key, r!.subject_id, body)
        : correctIdentifier(key, r!.subject_id, { ...body, field: proposal.field });
    },
    invalidates: ENTITY_READS,
    announce: () => t("entityRecord.corrections.saved"),
    onSuccess: (_, action) => { setNote(""); if (action === "APPLY") onClose(); },
  });
  const busy = command.isPending;
  const status = (r ?? row)?.status;
  const help = status === "APPROVED" ? "applyHelp" : status === "RECORDED" ? "reviewHelp" : "decisionHelp";
  return (
    <Sheet open onClose={onClose} pending={busy} title={t("entityRecord.corrections.detail")}
      notice={<EntityError error={command.error} own={(code) => correctionRefusal(code)} />}
      consequence={<div className={s.consequence}>{(["applyHelp", "reviewHelp", "decisionHelp"] as const).map((key) =>
        <div key={key} className={key === help ? undefined : s.measure} aria-hidden={key !== help || undefined}>{t(`entityRecord.corrections.${key}`)}</div>
      )}</div>}
      actions={<div className={s.actions}>
        <div aria-hidden className={s.measure}>
          <Button disabled tabIndex={-1}>{t("common.back")}</Button>
          <Button disabled tabIndex={-1}>{t("entityRecord.corrections.decline")}</Button>
          <Button variant="primary" disabled tabIndex={-1}>{t("entityRecord.corrections.approve")}</Button>
        </div>
        <div>
          <Button onClick={onClose} disabled={busy}>{t("common.back")}</Button>
        {r?.can_decide && <>
          <Button disabled={busy} aria-disabled={!note.trim() || undefined} onClick={() => note.trim() && command.mutate("DECLINE")}>{t("entityRecord.corrections.decline")}</Button>
          <Button variant="primary" disabled={busy} onClick={() => command.mutate("APPROVE")}>{t("entityRecord.corrections.approve")}</Button>
        </>}
        {r?.can_apply && <Button variant="primary" disabled={busy} onClick={() => command.mutate("APPLY")}>{t("entityRecord.corrections.apply")}</Button>}
        {r?.can_review && <Button variant="primary" disabled={busy} aria-disabled={!note.trim() || undefined} onClick={() => note.trim() && command.mutate("REVIEW")}>{t("entityRecord.corrections.review")}</Button>}
        </div>
      </div>}>
      <QueryState q={q}>
        {(data) => {
          const item = data.items[0]!;
          return <>
            <KeyValue label={t("entityRecord.corrections.detail")} items={[
              { key: "entity", label: t("entityRecord.corrections.subject"), value: item.entity_name },
              { key: "field", label: fieldText(item), value: valueText(item) },
              { key: "state", label: t("entityRecord.corrections.state"), value: statusText(item) },
              { key: "requester", label: t("entityRecord.corrections.requester"), value: item.requester_name ?? "—" },
              { key: "created", label: t("entityRecord.corrections.created"), value: fmtDateTimeShort(item.created_at) },
              { key: "due", label: t("entityRecord.corrections.due"), value: fmtDateTimeShort(item.review_due_at ?? item.expires_at) },
              ...(item.decision_note || item.review_note ? [{ key: "note", label: t("entityRecord.corrections.note"), value: item.review_note ?? item.decision_note }] : []),
              ...(item.proposal ? [{ key: "reason", label: t("entityRecord.id.reason"), value: t(`entityRecord.id.reason.${item.proposal.reason_code}`) }] : []),
            ]} />
            <Link to="/org/entities/$id" params={{ id: item.entity_id }} className={buttonClass()} onClick={onClose}>{t("entityRecord.corrections.openRecord")}</Link>
            {(item.can_decide || item.can_review) && <Field label={t("entityRecord.corrections.note")} required={Boolean(item.can_review)}>
              {(props) => <TextArea {...props} value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} disabled={busy} />}
            </Field>}
            {item.proposal && <ProposedEvidence id={item.proposal.document_id} />}
          </>;
        }}
      </QueryState>
    </Sheet>
  );
}

function ProposedEvidence({ id }: { id: string }) {
  const q = useQuery({ ...documentQuery(id), retry: false });
  return <QueryState q={q}>{(doc) => <OpenOriginal doc={doc} />}</QueryState>;
}

function correctionRefusal(code: string) {
  switch (code) {
    case "exception_self_decision": return t("entityRecord.corrections.self");
    case "exception_contributor_decision": return t("entityRecord.corrections.contributor");
    case "exception_decide_forbidden": return t("entityRecord.corrections.forbidden");
    case "step_up_required": case "passkey_step_up_failed": return t("entityRecord.corrections.stepUp");
    case "exception_not_pending": case "exception_expired": case "exception_not_recorded": return t("entityRecord.corrections.stale");
    default: return undefined;
  }
}
