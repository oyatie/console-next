// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { ExternalLink } from "../../../ui/external-link";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { Sheet } from "../../../ui/sheet/sheet";
import { QueryState } from "../../../lib/react/query-state";
import { FilingDeadline } from "../../../reference/statutory/ui/filing-deadline";
import { lifecycleCasesQuery, lifecycleCaseQuery, lifecycleTemplateQuery, type LifecycleCase, type CaseItem } from "../api/lifecycle-trail";
import { CaseItemAction, CaseCloseAction } from "./lifecycle-trail-action";

import { lifecycleTrailError, trailText, trailItemLabel, ownerLabel, trailGroup } from "../present";
import { filingLabel } from "../../../reference/statutory/present";
import s from "./lifecycle-trail.module.css";

export function TrailItems({ value, onRecord }: { value: LifecycleCase; onRecord?: (target: string) => void }) {
  return <div className="form" id={`case-${value.id}`}>
    <p>{trailText(`lifecycle.trail.kind.${value.kind}`)} · <time dateTime={value.effective_date}>{fmtDate(value.effective_date)}</time> · {trailText(`lifecycle.trail.state.${value.state}`)}</p>
    {value.linked_case_id && <LinkedCase id={value.linked_case_id} />}
    {(["documents", "filing", "payment", "access", "return"] as const).map((key) => {
      const items = value.items.filter((item) => trailGroup(item.kind) === key);
      return items.length ? <TrailGroup key={key} label={t(`lifecycle.trail.group.${key}`)}>
        <h4>{t(`lifecycle.trail.group.${key}`)}</h4>
        <ul className="list-plain">{items.map((item) => <li key={item.id} id={`item-${item.id}`} className="form">
          <div className="row"><b>{item.filing_kind && item.insurer ? `${filingLabel(item.insurer)} ${filingLabel(item.filing_kind)}` : trailItemLabel(item.label_key, item.label)}</b><Chip>{item.status_code === "LEGAL_REVIEW" ? t("lifecycle.trail.unverified") : item.status_code === "PRE_CONSOLE" ? t("lifecycle.trail.preConsole") : trailText(`lifecycle.trail.status.${item.status}`)}</Chip></div>
          {item.status_code !== "PRE_CONSOLE" && (item.due_rule_ref || item.opens_rule_ref) && <ItemWindow item={item} />}
          {item.owner_line && <p>{t("lifecycle.trail.owner", { line: ownerLabel(item.owner_line) })}</p>}
          <details><summary>{t("statutory.basis")}</summary><Basis item={item} /></details>
          <ItemEvidence item={item} employeeId={value.employee_id} />

          {item.completion_reason && <p>{t("lifecycle.trail.reason")} · {item.completion_reason}</p>}
          {item.filing_obligation_id && item.status_code !== "LEGAL_REVIEW" && <Link to="/statutory" search={{ event: value.trigger_id ?? undefined, filing: item.filing_obligation_id }}>{t("lifecycle.trail.openFiling")}</Link>}
          {value.state === "OPEN" && item.record_target && item.status === "OPEN" && (onRecord ? <Button onClick={() => onRecord(item.record_target!)}>{item.record_target === "contract" ? trailItemLabel(item.label_key, item.label) : t("lifecycle.trail.recordFact", { item: trailItemLabel(item.label_key, item.label) })}</Button> : <Link to="/people/$id" params={{ id: value.employee_id }} hash={item.record_target === "contract" ? "contracts" : "facts"}>{t("lifecycle.trail.openFacts")}</Link>)}
          {value.state === "OPEN" && !item.filing_obligation_id && <CaseItemAction caseId={value.id} item={item} />}
        </li>)}</ul>
      </TrailGroup> : null;
    })}
    {value.cancellation_reason && <p>{value.cancellation_reason}</p>}
    {value.state === "OPEN" && <CaseCloseAction id={value.id} />}
  </div>;
}

function TrailGroup({ label, children }: { label: string; children: ReactNode }) {
  const element = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const group = element.current;
    // A live cancellation removes actions; keep the reader's place until this case is unmounted.
    if (group) group.style.minHeight = `${group.getBoundingClientRect().height}px`;
  });
  return <section ref={element} aria-label={label}>{children}</section>;
}

type ItemDates = Pick<CaseItem, "opens_on" | "opens_in_days" | "due_date" | "due_in_days" | "due_disposition"> & { basis?: CaseItem["basis"] };
export function ItemWindow({ item, rules }: { item: ItemDates; rules?: { opens: ReactNode; due: ReactNode } }) {
  return <div className="row">
    <span>{t("statutory.opens")} {item.opens_on ? <time dateTime={item.opens_on}>{fmtDate(item.opens_on)}</time> : rules?.opens ?? t("lifecycle.trail.opensUnknown")}</span>
    {item.opens_in_days !== null && item.opens_in_days > 0 && <Chip>{t("lifecycle.trail.startsIn", { days: item.opens_in_days })}</Chip>}
    <span aria-hidden="true">·</span><span>{(rules ? rules.due !== t("statutory.unknown") : item.due_disposition !== "UNKNOWN" && item.due_date) && t("statutory.deadline")} {rules?.due}</span>
    {!rules && <FilingDeadline task={{ due_date: item.due_disposition === "UNKNOWN" ? null : item.due_date, due_in_days: item.due_in_days, deadline_status: item.basis?.legal_review_required === true ? "HOLD" : item.due_disposition }} />}
  </div>;
}

function Basis({ item }: { item: CaseItem }) {
  const basis = item.basis;
  return <p>{item.due_rule_ref && <>{item.due_rule_ref} · </>}{typeof basis.instrument === "string" && basis.instrument} {typeof basis.article === "string" && basis.article}
    {(item.due_disposition === "HOLD" || basis.legal_review_required === true) && <> · {t("lifecycle.trail.unverified")}</>}</p>;
}

function LinkedCase({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({ ...lifecycleCaseQuery(id), enabled: open });
  return <><Button variant="ghost" onClick={() => setOpen(true)}>{t("lifecycle.trail.linked")}</Button>
    {open && <Sheet open title={t("lifecycle.trail.linked")} onClose={() => setOpen(false)} consequence={t("lifecycle.trail.shared")} actions={<Button onClick={() => setOpen(false)}>{t("uiSheet.close")}</Button>}>
      <QueryState q={q} own={lifecycleTrailError}>{(value) => <TrailItems value={{ ...value, linked_case_id: null }} />}</QueryState>
    </Sheet>}
  </>;
}

export function LifecycleTrail({ employeeId, eventId, caseKind, exitCaseId, onRecord }: { employeeId: string; eventId?: string; caseKind?: string; exitCaseId?: string; compact?: boolean; onRecord?: (target: string) => void }) {
  const [open, setOpen] = useState(false);
  const cases = useQuery({ ...lifecycleCasesQuery(employeeId), enabled: !exitCaseId && (!eventId || open) });
  const exit = useQuery({ ...lifecycleCaseQuery(exitCaseId ?? ""), enabled: !!exitCaseId, select: (value) => [value] });
  const q = exitCaseId ? exit : cases;
  const body = <QueryState q={q} own={lifecycleTrailError} empty={(rows) => !rows.length ? <><p>{t("lifecycle.trail.empty")}</p>{caseKind && <TemplatePreview template={caseKind} />}</> : null}>{(rows) => <>
    {rows.filter((c) => (!eventId || c.trigger_id === eventId) && (!caseKind || c.kind === caseKind) && (!exitCaseId || c.id === exitCaseId) && (!eventId || !rows.some((peer) => peer.kind === "HIRE" && peer.linked_case_id === c.id))).map((c) => <TrailItems key={c.id} value={c} onRecord={onRecord} />)}
  </>}</QueryState>;
  if (!eventId) return <section aria-label={t("lifecycle.trail.title")}><h3>{t("lifecycle.trail.title")}</h3>{body}</section>;
  return <><Button variant="ghost" onClick={() => setOpen(true)}>{t("lifecycle.trail.title")}</Button>{open && <Sheet open title={t("lifecycle.trail.title")} onClose={() => setOpen(false)} consequence={t("lifecycle.trail.shared")} actions={<Button onClick={() => setOpen(false)}>{t("uiSheet.close")}</Button>}>{body}</Sheet>}</>;
}

function TemplatePreview({ template }: { template: string }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({ ...lifecycleTemplateQuery(template), enabled: open });
  return <details onToggle={(e) => setOpen(e.currentTarget.open)}><summary>{t("lifecycle.trail.preview")}</summary>
    {open && <QueryState q={q} own={lifecycleTrailError}>{(items) => <ul>{items.map((item) => <li key={item.item_key}>{trailItemLabel(item.label_key ?? null, item.label)}</li>)}</ul>}</QueryState>}
  </details>;
}

export function CaseSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery(lifecycleCaseQuery(id));
  return <Sheet open title={t("lifecycle.trail.title")} onClose={onClose} consequence={t("lifecycle.trail.shared")} actions={<Button onClick={onClose}>{t("uiSheet.close")}</Button>}><QueryState q={q} own={lifecycleTrailError}>{(value) => <TrailItems value={value} />}</QueryState></Sheet>;
}

function ItemEvidence({ item, employeeId }: { item: CaseItem; employeeId: string }) {
  const ref = item.observed_ref;
  if (!ref) return null;
  const document = ref.document;
  if (document && typeof document === "object" && "name" in document && "url" in document && typeof document.url === "string" && document.url.startsWith("https://")) return <p className={s.evidence} title={String(document.name)}><ExternalLink href={document.url}>{String(document.name)}</ExternalLink></p>;
  const event = ref.table === "employee_lifecycle_events";
  const filing = ref.table === "insurance_filing_records";
  if (filing && item.filing_obligation_id) return <p className={s.evidence}><Link to="/statutory" search={{ filing: item.filing_obligation_id }}>{t("lifecycle.trail.filingReceipt")}</Link></p>;
  return <p className={s.evidence}><Link to="/people/$id" params={{ id: employeeId }} search={{ tab: event ? "events" : ref.table === "audit_events" ? "access" : undefined }} hash={event ? `ev-${String(ref.id)}` : ref.table === "employee_contracts" ? "contracts" : "facts"}>{event ? t("lifecycle.trail.eventReceipt") : ref.table === "audit_events" ? t("lifecycle.trail.accessReceipt") : trailItemLabel(item.label_key, item.label)}</Link></p>;
}
