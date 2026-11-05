// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { buttonClass } from "../../../ui/button/button-class";
import { Button } from "../../../ui/button/button";
import { LongTable, TableControl } from "../../../ui/long-table/long-table";
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
  return (
    <div className={s.filings}>
      <LongTable label={t("statutory.insurance")} rows={rows} rowId={(r) => `${r.event_id}:${r.kind}:${r.insurer}`}
        caption={t("statutory.count", { count: total })} total={total} hasMore={false} onLoadMore={() => {}}
        find={{ label: t("statutory.search"), defaultValue: search, onFind }} findSlot={findSlot}
        columns={[
          { id: "employee", rowHeader: true, width: "2fr", header: t("statutory.employee"), cell: (r) => <PersonRef wrap account={{ id: r.employee_id, employee_id: r.employee_id, employee_name: r.name, employee_number: r.employee_number }} /> },
          { id: "workplace", header: t("statutory.workplace"), cell: (r) => r.workplace_name },
          { id: "event", header: t("statutory.event"), cell: (r) => <>{filingLabel(r.insurer)} · {filingLabel(r.kind)}</> },
          { id: "date", header: t("statutory.date"), type: "date", cell: (r) => fmtDate(r.effective_date) },
          { id: "deadline", width: "4fr", header: t("statutory.deadline"), cell: (r) => <FilingWindow task={r} /> },
          { id: "evidence", width: "3fr", header: t("statutory.evidence"), cell: (r) => r.completed_on ? <dl className="facts">
            <dt>{t("statutory.completedOn")}</dt><dd>{fmtDate(r.completed_on)}</dd>
            {r.receipt_number && <><dt>{t("statutory.receiptNumber")}</dt><dd>{r.receipt_number}</dd></>}
            {r.loss_code && <><dt>{t("statutory.lossCode")}</dt><dd>{r.loss_code} · {r.loss_options.find((o) => o.code === r.loss_code)?.label}</dd></>}
            {r.detail && <><dt>{t("statutory.detail")}</dt><dd>{r.detail}</dd></>}
          </dl> : r.state === "LEGAL_REVIEW" ? t("lifecycle.trail.unverified") : r.state === "NOT_APPLICABLE" ? <div><Chip>{t("statutory.notApplicable")}</Chip>{r.not_applicable_reason && <div>{filingLabel(r.not_applicable_reason)}</div>}{r.detail && <dl className="facts"><dt>{t("statutory.reasonEvidence")}</dt><dd>{r.detail}</dd></dl>}</div> : r.state === "COVERED" ? t("statutory.covered") : t("statutory.pending") },
          { id: "action", card: "action", header: t("statutory.action"), width: "2fr", cell: (r) => <div className="row">{r.lifecycle_case_id && <Link to="/people/$id" params={{ id: r.employee_id }} search={{ act: `case:${r.lifecycle_case_id}` }} hash={`case-${r.lifecycle_case_id}`}>{t("lifecycle.trail.openCase")}</Link>}{r.state !== "LEGAL_REVIEW" && <>{r.record_action === "COMPLETE" || r.record_action === "NOT_APPLICABLE" ? <TableControl><Button onClick={() => onUndo(r)} disabled={undoing}>{t("statutory.undo")}</Button></TableControl> : <TableControl><Button onClick={() => onRecord(r)}>{t("statutory.record")}</Button></TableControl>}
            {!r.is_request && ["ACQUIRE", "LOSE"].includes(r.kind) && r.insurer === "EI" && <TableControl><Button onClick={() => onRequest(r)}>{t("statutory.futureRequest")}</Button></TableControl>}</>}</div> },
        ]} empty={<EmptyState title={t("statutory.empty")} reason={t("statutory.emptyReason")} actions={<Link to="/people" className={buttonClass()}>{t("statutory.openPeople")}</Link>} />} />
    </div>
  );
}
