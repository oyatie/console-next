// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { buttonClass } from "../../../ui/button/button-class";
import { Button } from "../../../ui/button/button";
import { SearchField } from "../../../ui/search/search-field";
import { RecordRows } from "../../../ui/record/rows";
import { PersonRef } from "../../../reference/person/ui/person-label";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import type { FilingTask } from "../../../reference/statutory/api";
import { FilingWindow } from "./filing-deadline";
import { filingLabel } from "../present";
import s from "./statutory.module.css";

export function FilingTable({ rows, total, search, onFind, findSlot, onRecord, onRequest, onUndo, undoing }: {
  rows: FilingTask[]; total: number; search: string; onFind: (value: string) => void; findSlot?: HTMLElement | null;
  onRecord: (task: FilingTask) => void; onRequest: (task: FilingTask) => void; onUndo: (task: FilingTask) => void; undoing: boolean;
}) {
  const [find, setFind] = useState({ source: search, value: search });
  if (find.source !== search) setFind({ source: search, value: search });
  const finder = <SearchField label={t("statutory.search")} value={find.value}
    onChange={value => { setFind({ source: search, value }); if (!value) onFind(""); }}
    onKeyDown={event => { if (event.key === "Enter") onFind(find.value); }} />;
  return <>
    {findSlot === undefined ? finder : findSlot && createPortal(finder, findSlot)}
    <Chip>{t("statutory.count", { count: total })}</Chip>
    {rows.length ? (
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users need to scroll this wide table.
      <div className={`${s.scroll} ${s.filings}`} tabIndex={0} role="region" aria-label={t("statutory.insurance")}><RecordRows mobileLayout="cards" label={t("statutory.insurance")} rows={rows} rowId={(r) => `${r.event_id}:${r.kind}:${r.insurer}`}
      columns={[
        { rowHeader: true, header: t("statutory.employee"), cell: (r) => <PersonRef wrap account={{ id: r.employee_id, employee_id: r.employee_id, employee_name: r.name, employee_number: r.employee_number }} /> },
        { header: t("statutory.workplace"), cell: (r) => r.workplace_name },
        { header: t("statutory.event"), cell: (r) => <div className={s.filingEvent}>{filingLabel(r.insurer)} · {filingLabel(r.kind)}</div> },
        { header: t("statutory.date"), cell: (r) => fmtDate(r.effective_date) },
        { header: t("statutory.deadline"), cell: (r) => <FilingWindow task={r} /> },
        { header: t("statutory.evidence"), cell: (r) => r.completed_on ? <dl className="facts">
          <dt>{t("statutory.completedOn")}</dt><dd>{fmtDate(r.completed_on)}</dd>
          {r.receipt_number && <><dt>{t("statutory.receiptNumber")}</dt><dd>{r.receipt_number}</dd></>}
          {r.loss_code && <><dt>{t("statutory.lossCode")}</dt><dd>{r.loss_code} · {r.loss_options.find((o) => o.code === r.loss_code)?.label}</dd></>}
          {r.detail && <><dt>{t("statutory.detail")}</dt><dd>{r.detail}</dd></>}
        </dl> : r.state === "LEGAL_REVIEW" ? t("lifecycle.trail.unverified") : r.state === "NOT_APPLICABLE" ? <div><Chip>{t("statutory.notApplicable")}</Chip>{r.not_applicable_reason && <div>{filingLabel(r.not_applicable_reason)}</div>}{r.detail && <dl className="facts"><dt>{t("statutory.reasonEvidence")}</dt><dd>{r.detail}</dd></dl>}</div> : r.state === "COVERED" ? t("statutory.covered") : t("statutory.pending") },
        { end: true, card: "action", header: t("statutory.action"), cell: (r) => <div className="row">{r.lifecycle_case_id && <Link className={buttonClass("ghost", { size: "sm" })} to="/people/$id" params={{ id: r.employee_id }} search={{ act: `case:${r.lifecycle_case_id}` }} hash={`case-${r.lifecycle_case_id}`}>{t("lifecycle.trail.openCase")}</Link>}{r.state !== "LEGAL_REVIEW" && <>{r.record_action === "COMPLETE" || r.record_action === "NOT_APPLICABLE" ? <Button onClick={() => onUndo(r)} disabled={undoing}>{t("statutory.undo")}</Button> : <Button onClick={() => onRecord(r)}>{t("statutory.record")}</Button>}
          {!r.is_request && ["ACQUIRE", "LOSE"].includes(r.kind) && r.insurer === "EI" && <Button onClick={() => onRequest(r)}>{t("statutory.futureRequest")}</Button>}</>}</div> },
      ]} /></div>) : <EmptyState title={t("statutory.empty")} reason={t("statutory.emptyReason")} actions={<Link to="/people" className={buttonClass()}>{t("statutory.openPeople")}</Link>} />}
  </>;
}
