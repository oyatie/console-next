// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import type { FilingTask } from "../../../reference/statutory/api";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Chip } from "../../../ui/chip";
import { KeyValue } from "../../../ui/key-value/key-value";
import { RecordSection } from "../../../ui/record/record-section";
import { filingLabel } from "../present";
import { FilingWindow } from "./filing-deadline";
import { taskKey } from "./statutory-console-columns";
import s from "./statutory-console.module.css";

export function buildFilingSidePane({
  task,
  onClose,
  onRecord,
  onRequest,
  onUndo,
  undoing,
}: {
  task: FilingTask;
  onClose: () => void;
  onRecord: (t: FilingTask) => void;
  onRequest: (t: FilingTask) => void;
  onUndo: (t: FilingTask) => void;
  undoing: boolean;
}) {
  return {
    id: taskKey(task),
    label: t("statutory.detailTitle"),
    title: task.name,
    meta: [task.workplace_name, filingLabel(task.insurer), filingLabel(task.kind)].filter(Boolean).join(" · "),
    onClose,
    children: (
      <div className={s.paneDetail}>
        <RecordSection id="statutory-detail-deadline" title={t("statutory.deadline")}>
          <FilingWindow task={task} />
        </RecordSection>
        <RecordSection id="statutory-detail-facts" title={t("statutory.detailTitle")}>
          <KeyValue
            items={[
              { key: "workplace", label: t("statutory.workplace"), value: task.workplace_name ?? "" },
              { key: "effective_date", label: t("statutory.date"), value: fmtDate(task.effective_date) },
              ...(task.acquired_on
                ? [{ key: "acquired_on", label: t("statutory.acquiredOn"), value: fmtDate(task.acquired_on) }]
                : []),
              ...(task.total_remuneration_won != null
                ? [
                    {
                      key: "remuneration",
                      label: t("statutory.remuneration"),
                      value: t("statutory.won", { amount: task.total_remuneration_won }),
                    },
                  ]
                : []),
              ...(task.completed_on
                ? [{ key: "completed_on", label: t("statutory.completedOn"), value: fmtDate(task.completed_on) }]
                : []),
              ...(task.receipt_number
                ? [{ key: "receipt_number", label: t("statutory.receiptNumber"), value: task.receipt_number }]
                : []),
              ...(task.loss_code
                ? [
                    {
                      key: "loss_code",
                      label: t("statutory.lossCode"),
                      value: [
                        task.loss_code,
                        task.loss_options.find((o) => o.code === task.loss_code)?.label,
                      ]
                        .filter(Boolean)
                        .join(" · "),
                    },
                  ]
                : []),
              ...(task.detail ? [{ key: "detail", label: t("statutory.detail"), value: task.detail }] : []),
              ...(task.not_applicable_reason
                ? [{ key: "reason", label: t("statutory.reason"), value: filingLabel(task.not_applicable_reason) }]
                : []),
            ]}
          />
        </RecordSection>
        <RecordSection id="statutory-detail-actions" title={t("statutory.action")}>
          <div className={s.actionRow}>
            {task.state !== "LEGAL_REVIEW" ? (
              <>
                {task.record_action === "COMPLETE" || task.record_action === "NOT_APPLICABLE" ? (
                  <Button size="sm" onClick={() => onUndo(task)} disabled={undoing}>
                    {t("statutory.undo")}
                  </Button>
                ) : (
                  <Button variant="primary" size="sm" onClick={() => onRecord(task)}>
                    {t("statutory.record")}
                  </Button>
                )}
                {!task.is_request && ["ACQUIRE", "LOSE"].includes(task.kind) && task.insurer === "EI" ? (
                  <Button size="sm" onClick={() => onRequest(task)}>
                    {t("statutory.futureRequest")}
                  </Button>
                ) : null}
              </>
            ) : (
              <Chip tone="warn">{t("lifecycle.trail.unverified")}</Chip>
            )}
            {task.lifecycle_case_id ? (
              <Link
                className={buttonClass("ghost", { size: "sm" })}
                to="/people/$id"
                params={{ id: task.employee_id }}
                search={{ act: `case:${task.lifecycle_case_id}` }}
                hash={`case-${task.lifecycle_case_id}`}
              >
                {t("lifecycle.trail.openCase")}
              </Link>
            ) : null}
          </div>
        </RecordSection>
      </div>
    ),
  };
}
