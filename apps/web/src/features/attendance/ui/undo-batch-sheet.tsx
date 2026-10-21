import { useState } from "react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { Sheet } from "../../../ui/sheet/sheet";
import { undoBatch } from "../api";
import { monthText, refusalText } from "../present";

/** batch undo: the whole save stops counting with a reason, until its month closes; the entries stay as history. */
export function UndoBatchSheet({ batchId, saved, month, onClose, onDone }: { batchId: string; saved: number; month: string; onClose: () => void; onDone: (message: string) => void }) {
  const [reason, setReason] = useState("");
  const run = useCommand({
    run: () => undoBatch(batchId, reason.trim()),
    invalidates: ["/api/v1/attendance"],
    onSuccess: () => onDone(t("attendanceRecords.undo.done", { count: saved })),
  });
  const label = t("attendanceRecords.undo.commit", { count: saved });
  return (
    <Sheet
      open
      title={t("attendanceRecords.undo.title")}
      onClose={onClose}
      pending={run.isPending}
      notice={<CommandError error={run.error} own={refusalText} />}
      consequence={<span>{t("attendanceRecords.undo.consequence", { count: saved, month: monthText(month) })}</span>}
      actions={
        <>
          <Button onClick={onClose}>{t("attendance.close")}</Button>
          {reason.trim() ? <Button variant="danger" disabled={run.isPending} onClick={() => run.mutate()}>{label}</Button> : <DisabledReason reason={t("attendanceRecords.correct.needsReason")} control={(p) => <Button {...p} variant="danger">{label}</Button>} />}
        </>
      }
    >
      <Field label={t("attendanceRecords.correct.reason")} required>
        {(p) => <TextArea {...p} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />}
      </Field>
    </Sheet>
  );
}
