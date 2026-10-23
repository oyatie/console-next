import { verbLabel } from "../../../ui/composer/actions";
import { useState } from "react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { ORG_READS } from "../../../reference/org/api";
import { Composer } from "../../../ui/composer/composer";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { changeCommands, movedElsewhere, probed } from "../api";
import { elsewhereNote, type Note } from "./use-note";

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
  return (
    <Composer open={open} title={t(scheduled ? "orgChange.scheduled.cancel" : "orgChange.cancel")}
      onClose={onClose} pending={cancel.isPending} tone="danger"
      action={{ kind: "orgChange", mode: d.status === "IN_APPROVAL" ? "withdraw" : "cancel" }}
      consequence={t(scheduled ? "orgChange.scheduled.cancel.consequence" : "orgChange.cancel.consequence", { title })}
      notice={<CommandError error={cancel.error} />}
      blocked={!reason.trim() ? { reason: t("orgChange.cancel.needReason") } : undefined}
      onSubmit={() => { if (reason.trim()) cancel.mutate(undefined); }}
    >
      <Field label={t("composer.reason", { verb: verbLabel(d.status === "IN_APPROVAL" ? "withdraw" : "cancel") })} required>
        {(p) => <TextArea {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>
    </Composer>
  );
}
