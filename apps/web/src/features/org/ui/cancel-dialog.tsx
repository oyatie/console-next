import { useState } from "react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { ORG_READS } from "../../../reference/org/api";
import { Button } from "../../../ui/button/button";
import { Dialog } from "../../../ui/dialog";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { changeCommands, movedElsewhere, probed } from "../api";
import { elsewhereNote, type Note } from "./use-note";
import css from "./org-change.module.css";

type Detail = components["schemas"]["OrgChangeDetail"];

/**
 * Cancelling a draft or a scheduled change (schedule cancel, org-02), with its reason: what it does is said first, and the
 * button waits for the reason. Cancelled, nothing of it applies and the reason stays on the record.
 */
export function CancelDialog({ d, title, scheduled, open, onClose, refetch, onNote }: {
  d: Detail;
  title: string;
  scheduled: boolean;
  open: boolean;
  onClose: () => void;
  refetch: () => Promise<{ data?: Detail }>;
  onNote: (n: Note) => void;
}) {
  const [reason, setReason] = useState("");
  const cancel = useCommand({
    run: () => probed(() => changeCommands(d.id).cancel(reason.trim()), refetch, (x) => x.status === "CANCELLED", (x) => movedElsewhere(x, ["CANCELLED"])),
    invalidates: ORG_READS,
    onSuccess: (other) => {
      onClose();
      onNote(other ? elsewhereNote(other) : { message: t(scheduled ? "orgChange.receipt.unscheduled" : "orgChange.receipt.cancelled", { title, code: d.code }) });
    },
  });
  const commit = t(scheduled ? "orgChange.scheduled.cancel.commit" : "orgChange.cancel.commit", { title });
  return (
    <Dialog open={open} title={commit} onClose={onClose} dismissable={!reason.trim()}>
      <p className={css.consequence}>{t(scheduled ? "orgChange.scheduled.cancel.consequence" : "orgChange.cancel.consequence", { title })}</p>
      <Field label={t("orgChange.cancel.reason")} required>
        {(p) => <TextArea {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>
      <CommandError error={cancel.error} />
      <div className="form__actions">
        <Button onClick={onClose}>{t("common.back")}</Button>
        {reason.trim() ? (
          <Button variant="danger" disabled={cancel.isPending} onClick={() => cancel.mutate(undefined)}>{commit}</Button>
        ) : (
          <DisabledReason control={(p) => <Button variant="danger" {...p}>{commit}</Button>} reason={t("orgChange.cancel.needReason")} />
        )}
      </div>
    </Dialog>
  );
}
