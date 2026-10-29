// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { ExternalLink } from "../../../ui/external-link";
import { FilingDeadline } from "../../../reference/statutory/ui/filing-deadline";
import { filingLabel } from "../../../reference/statutory/present";
import { trailItemLabel, ownerLabel, trailText } from "../present";
import type { LifecycleCase, CaseItem } from "../api/lifecycle-trail";
import { CaseItemAction, CaseCloseAction } from "./lifecycle-trail-action";
import s from "./lifecycle-trail.module.css";

export function TrailCaseEnd({ value }: { value: LifecycleCase }) {
  return <>
    {value.cancellation_reason && <p>{value.cancellation_reason}</p>}
    {value.state === "OPEN" && <CaseCloseAction id={value.id} items={value.items} />}
  </>;
}

export function TrailItem({ item, value, onRecord, deadline }: { item: CaseItem; value: LifecycleCase; onRecord?: (target: string) => void; deadline?: ReactNode }) {
  return <>
    <div className="row"><b>{item.filing_kind && item.insurer ? `${filingLabel(item.insurer)} ${filingLabel(item.filing_kind)}` : trailItemLabel(item.label_key, item.label)}</b><Chip>{item.status_code === "LEGAL_REVIEW" ? t("lifecycle.trail.unverified") : item.status_code === "PRE_CONSOLE" ? t("lifecycle.trail.preConsole") : trailText(`lifecycle.trail.status.${item.status}`)}</Chip></div>
    {item.status_code !== "PRE_CONSOLE" && (item.due_rule_ref || item.opens_rule_ref || deadline) && <ItemWindow item={item} deadline={deadline} />}
    {item.owner_line && <p>{t("lifecycle.trail.owner", { line: ownerLabel(item.owner_line) })}</p>}
    <details><summary>{t("statutory.basis")}</summary><Basis item={item} /></details>
    <ItemEvidence item={item} employeeId={value.employee_id} />

    {item.completion_reason && <p>{t("lifecycle.trail.reason")} · {item.completion_reason}</p>}
    {item.filing_obligation_id && item.status_code !== "LEGAL_REVIEW" && <Link to="/statutory" search={{ event: value.trigger_id ?? undefined, filing: item.filing_obligation_id }}>{t("lifecycle.trail.openFiling")}</Link>}
    {value.state === "OPEN" && item.record_target && item.status === "OPEN" && (onRecord ? <Button onClick={() => onRecord(item.record_target!)}>{item.record_target === "contract" ? trailItemLabel(item.label_key, item.label) : t("lifecycle.trail.recordFact", { item: trailItemLabel(item.label_key, item.label) })}</Button> : <Link to="/people/$id" params={{ id: value.employee_id }} hash={item.record_target === "contract" ? "contracts" : "facts"}>{t("lifecycle.trail.openFacts")}</Link>)}
    {value.state === "OPEN" && !item.filing_obligation_id && <CaseItemAction caseId={value.id} item={item} />}
  </>;
}


type ItemDates = Pick<CaseItem, "opens_on" | "opens_in_days" | "due_date" | "due_in_days" | "due_disposition"> & { basis?: CaseItem["basis"] };
export function ItemWindow({ item, rules, deadline }: { item: ItemDates; rules?: { opens: ReactNode; due: ReactNode }; deadline?: ReactNode }) {
  return <div className="row">
    <span>{t("statutory.opens")} {item.opens_on ? <time dateTime={item.opens_on}>{fmtDate(item.opens_on)}</time> : rules?.opens ?? t("lifecycle.trail.opensUnknown")}</span>
    {item.opens_in_days !== null && item.opens_in_days > 0 && <Chip>{t("lifecycle.trail.startsIn", { days: item.opens_in_days })}</Chip>}
    <span aria-hidden="true">·</span><span>{(rules ? rules.due !== t("statutory.unknown") : item.due_disposition !== "UNKNOWN" && item.due_date) && t("statutory.deadline")} {rules?.due}</span>
    {!rules && (deadline ?? <FilingDeadline task={{ due_date: item.due_disposition === "UNKNOWN" ? null : item.due_date, due_in_days: item.due_in_days, deadline_status: item.basis?.legal_review_required === true ? "HOLD" : item.due_disposition }} />)}
  </div>;
}

function Basis({ item }: { item: CaseItem }) {
  const basis = item.basis;
  return <p>{item.due_rule_ref && <>{item.due_rule_ref} · </>}{typeof basis.instrument === "string" && basis.instrument} {typeof basis.article === "string" && basis.article}
    {(item.due_disposition === "HOLD" || basis.legal_review_required === true) && <> · {t("lifecycle.trail.unverified")}</>}</p>;
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
