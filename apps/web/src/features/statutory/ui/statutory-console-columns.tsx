// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { saveFile } from "../../../lib/download";
import { PersonRef } from "../../../reference/person/ui/person-label";
import type { FilingTask, RegisterPage } from "../../../reference/statutory/api";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { DueCell } from "../../../ui/due-cell/due-cell";
import type { LongColumn } from "../../../ui/long-table/long-table";
import { buildStatutoryEdiCsv } from "../domain/edi-export";
import { filingLabel } from "../present";
import { registerPrintHtml } from "./register-print";
import s from "./statutory-console.module.css";

export const taskKey = (r: FilingTask) => `${r.event_id}:${r.kind}:${r.insurer}`;
const formatEvent = (r: FilingTask) => `${filingLabel(r.insurer)} · ${filingLabel(r.kind)}`;

export function downloadStatutoryEdi(picked: readonly FilingTask[], today: string) {
  const csv = buildStatutoryEdiCsv(picked, {
    headers: [
      t("statutory.insurerLabel"),
      t("statutory.event"),
      t("statutory.workplace"),
      t("statutory.employeeNumber"),
      t("statutory.employee"),
      t("statutory.date"),
      t("statutory.acquiredOn"),
      t("statutory.lossCode"),
      t("statutory.detail"),
      t("statutory.remuneration"),
      t("statutory.deadline"),
      t("statutory.deadlineStatus"),
    ],
    formatInsurer: filingLabel,
    formatKind: filingLabel,
  });
  saveFile(new Blob([csv], { type: "text/csv;charset=utf-8" }), t("statutory.ediFile", { date: today }));
}

export function printRegisterConsole(page: RegisterPage) {
  const frame = document.createElement("iframe");
  frame.className = "sr-only";
  frame.setAttribute("aria-hidden", "true");
  frame.onload = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 1000);
  };
  frame.srcdoc = registerPrintHtml(page);
  document.body.append(frame);
}

function taskStatusChip(r: FilingTask) {
  if (r.state === "LEGAL_REVIEW") return <Chip tone="warn">{t("lifecycle.trail.unverified")}</Chip>;
  if (r.state === "NOT_APPLICABLE") return <Chip>{t("statutory.notApplicable")}</Chip>;
  if (r.state === "COVERED") return <Chip>{t("statutory.covered")}</Chip>;
  if (r.completed_on) return <Chip tone="ok">{fmtDate(r.completed_on)}</Chip>;
  if (r.deadline_status === "HOLD") return <Chip tone="warn">{t("statutory.codeHold")}</Chip>;
  return <Chip>{t("statutory.pending")}</Chip>;
}

export function buildFilingColumns(onInspect: (id: string) => void, state: "PENDING" | "DONE"): LongColumn<FilingTask>[] {
  return [
    {
      id: "employee",
      header: t("statutory.employee"),
      card: "title",
      rowHeader: true,
      minWidth: 120,
      cell: (r) => (
        <PersonRef
          details={false}
          account={{
            id: r.employee_id,
            employee_id: r.employee_id,
            employee_name: r.name,
            employee_number: r.employee_number,
          }}
        />
      ),
    },
    {
      id: "employee_number",
      header: t("statutory.employeeNumber"),
      card: "fact",
      minWidth: 96,
      cell: (r) => r.employee_number ?? "",
    },
    {
      id: "event",
      header: t("statutory.event"),
      card: "fact",
      minWidth: 150,
      cell: (r) => <bdi className={s.nowrap}>{formatEvent(r)}</bdi>,
    },
    {
      id: "workplace",
      header: t("statutory.workplace"),
      card: "fact",
      minWidth: 110,
      cell: (r) => r.workplace_name ?? "",
    },
    {
      id: "effective_date",
      header: t("statutory.date"),
      type: "date",
      card: "omit",
      minWidth: 112,
      cell: (r) => <time dateTime={r.effective_date}>{fmtDate(r.effective_date)}</time>,
    },
    {
      id: "deadline",
      header: t("statutory.deadline"),
      card: state === "PENDING" ? "status" : "omit",
      minWidth: 140,
      cell: (r) => <DueCell days={r.due_in_days} fill />,
    },
    {
      id: "status",
      header: t("statutory.evidence"),
      card: state === "DONE" ? "status" : "omit",
      minWidth: 150,
      cell: (r) => <bdi className={s.nowrap}>{taskStatusChip(r)}</bdi>,
    },
    {
      id: "action",
      type: "action",
      header: <bdi className="sr-only">{t("statutory.openCol")}</bdi>,
      card: "action",
      minWidth: 72,
      cell: (r) => (
        <Button
          size="sm"
          className={s.nowrap}
          aria-label={t("statutory.openRow", { name: r.name, insurer: filingLabel(r.insurer), kind: filingLabel(r.kind) })}
          onClick={() => onInspect(taskKey(r))}
        >
          {t("statutory.openCol")}
        </Button>
      ),
    },
  ];
}
