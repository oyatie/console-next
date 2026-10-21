import { useState } from "react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { KeyValue } from "../../../ui/key-value/key-value";
import { Sheet } from "../../../ui/sheet/sheet";
import { cancelLayer, type Layer } from "../api";
import { dateText, refusalText } from "../present";

/**
 * Cancel a work schedule before it takes effect. The layer stays in history as cancelled with the reason; once its start date
 * has come the server refuses (schedule_layer_in_effect) and the way on is a new layer from a later date.
 */
function CancelLayerSheetOpen({ layer, onClose, onCancelled }: { layer: Layer | null; onClose: () => void; onCancelled: (message: string) => void }) {
  const [reason, setReason] = useState("");
  const run = useCommand({
    run: (l: Layer) => cancelLayer(l.id, reason.trim()),
    invalidates: ["/api/v1/attendance"],
    onSuccess: (l) => onCancelled(t("attendanceSchedule.cancel.done", { scope: l.scope_name, pattern: l.pattern_name, date: dateText(l.effective_from) })),
  });
  const label = t("attendanceSchedule.cancel.commit");
  return (
    <Sheet
      open={!!layer}
      title={t("attendanceSchedule.cancel.title")}
      onClose={onClose}
      pending={run.isPending}
      notice={<CommandError error={run.error} own={refusalText} />}
      consequence={layer && t("attendanceSchedule.cancel.consequence", { scope: layer.scope_name, date: dateText(layer.effective_from) })}
      actions={
        <>
          <Button onClick={onClose}>{t("attendance.close")}</Button>
          {reason.trim() ? (
            <Button variant="danger" onClick={() => layer && run.mutate(layer)} disabled={run.isPending}>{label}</Button>
          ) : (
            <DisabledReason reason={t("attendanceSchedule.cancel.needReason")} control={(p) => <Button {...p} variant="danger">{label}</Button>} />
          )}
        </>
      }
    >
      {layer && (
        <div className="form">
          <KeyValue
            items={[
              { key: "scope", label: t("attendanceSchedule.cancel.scope"), value: layer.scope_name },
              { key: "pattern", label: t("attendanceSchedule.history.col.pattern"), value: layer.pattern_name },
              { key: "from", label: t("attendanceSchedule.assign.from"), value: dateText(layer.effective_from) },
            ]}
          />
          <Field label={t("attendanceSchedule.cancel.reason")} required example={t("attendanceSchedule.cancel.reason.example")}>
            {(p) => <TextArea {...p} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />}
          </Field>
        </div>
      )}
    </Sheet>
  );
}

export function CancelLayerSheet(p: { layer: Layer | null; onClose: () => void; onCancelled: (message: string) => void }) {
  return p.layer ? <CancelLayerSheetOpen {...p} /> : null;
}
