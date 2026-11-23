// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import type { FilingTask } from "../../../reference/statutory/api";
import { Receipt } from "../../../ui/receipt/receipt";
import { filingLabel } from "../present";
import { FilingComplete } from "./filing-complete";
import { FilingRequest } from "./filing-request";

export function StatutoryConsoleOverlays({
  ediNotice,
  onDismissEdi,
  receipt,
  onDismissReceipt,
  onUndo,
  undoing,
  exportedCount,
  onDismissExport,
  requestTask,
  onCloseRequest,
  recordTask,
  onCloseRecord,
  onDoneRecord,
}: {
  ediNotice: { count: number; empty: boolean } | null;
  onDismissEdi: () => void;
  receipt?: FilingTask;
  onDismissReceipt: () => void;
  onUndo: (task: FilingTask) => void;
  undoing: boolean;
  exportedCount: number | null;
  onDismissExport: () => void;
  requestTask?: FilingTask;
  onCloseRequest: () => void;
  recordTask?: FilingTask;
  onCloseRecord: () => void;
  onDoneRecord: (done: FilingTask) => void;
}) {
  return (
    <>
      {ediNotice ? (
        <Receipt
          placement="docked"
          state="applied"
          message={ediNotice.empty ? t("statutory.ediEmpty") : t("statutory.ediReceiptHint", { count: ediNotice.count })}
          onDismiss={onDismissEdi}
        />
      ) : null}
      {receipt ? (
        <Receipt
          placement="docked"
          state="applied"
          message={
            receipt.record_action === "UNDO"
              ? t("statutory.undone")
              : receipt.record_action === "ASSESS"
                ? t("statutory.assessed")
                : receipt.state === "NOT_APPLICABLE"
                  ? t("statutory.notApplicableSaved", {
                      name: receipt.name,
                      insurer: filingLabel(receipt.insurer),
                      kind: filingLabel(receipt.kind),
                    })
                  : receipt.completed_on
                    ? t("statutory.saved", {
                        name: receipt.name,
                        insurer: filingLabel(receipt.insurer),
                        kind: filingLabel(receipt.kind),
                      })
                    : t("statutory.undone")
          }
          onDismiss={onDismissReceipt}
          onUndo={
            receipt.record_action === "COMPLETE" || receipt.record_action === "NOT_APPLICABLE"
              ? () => onUndo(receipt)
              : undefined
          }
          undoing={undoing}
        />
      ) : null}
      {exportedCount != null ? (
        <Receipt
          placement="docked"
          state="applied"
          message={t("statutory.exported", { count: exportedCount })}
          onDismiss={onDismissExport}
        />
      ) : null}
      {requestTask ? <FilingRequest task={requestTask} onClose={onCloseRequest} /> : null}
      {recordTask ? (
        <FilingComplete task={recordTask} onClose={onCloseRecord} onDone={onDoneRecord} />
      ) : null}
    </>
  );
}
