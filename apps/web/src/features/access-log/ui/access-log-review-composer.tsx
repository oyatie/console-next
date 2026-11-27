// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { CommandError } from "../../../lib/react/command-error";
import { useCommand } from "../../../lib/react/command";
import { Composer } from "../../../ui/composer/composer";
import { Field, TextInput } from "../../../ui/field/field";
import { SelectField } from "../../../ui/select/select-field";
import {
  completeAccessLogReview,
  recordAccessLogFinding,
  startAccessLogReview,
  type AccessLogReview,
} from "../api";

export type ReviewComposerMode = "start" | "record" | "complete";

const ownReviewError = (code: string) => {
  if (code === "review_incomplete") return t("accessLog.review.error.incomplete");
  if (code === "scope_tenant_wide_only") return t("accessLog.review.error.tenantOnly");
  if (code === "self_review_forbidden") return t("accessLog.review.error.selfReview");
  return undefined;
};

export function AccessLogReviewComposer({
  period,
  mode,
  initialEventId,
  onClose,
  onDone,
}: {
  period: string;
  mode: ReviewComposerMode;
  initialEventId?: string | null;
  onClose: () => void;
  onDone: (review: AccessLogReview, message: string) => void;
}) {
  const [disposition, setDisposition] = useState<"confirmed" | "action_required">("confirmed");
  const [eventId, setEventId] = useState(initialEventId ?? "");
  const [outcome, setOutcome] = useState("");
  const [note, setNote] = useState("");
  const cmd = useCommand<undefined, AccessLogReview>({
    run: async (_input, idempotencyKey) => {
      if (mode === "start") {
        return startAccessLogReview(period, idempotencyKey);
      }
      if (mode === "record") {
        return recordAccessLogFinding(period, idempotencyKey, {
          event_id: eventId.trim() || null,
          disposition,
          outcome: outcome.trim() || null,
          note: note.trim() || null,
        });
      }
      return completeAccessLogReview(period, idempotencyKey);
    },
    invalidates: ["/api/v1/access/access-log"],
    onSuccess: (review) => {
      const msg =
        mode === "start"
          ? t("accessLog.review.startedReceipt")
          : mode === "record"
            ? t("accessLog.review.findingReceipt")
            : t("accessLog.review.completedReceipt");
      onDone(review, msg);
    },
  });

  const actionMode = mode === "start" ? "apply" : mode === "record" ? "record" : "complete";

  return (
    <Composer
      open
      title={t("accessLog.review.title", { period })}
      onClose={onClose}
      action={{ kind: "accessLogReview", mode: actionMode }}
      pending={cmd.isPending}
      error={cmd.error}
      notice={<CommandError error={cmd.error} own={ownReviewError} />}
      onSubmit={() => {
        if (cmd.isPending) return;
        cmd.mutate(undefined);
      }}
    >
      {mode === "record" && (
        <>
          <SelectField
            label={t("accessLog.review.disposition")}
            placeholder={t("accessLog.review.disposition")}
            value={disposition}
            onChange={key => {
              if (key === "confirmed" || key === "action_required") setDisposition(key);
            }}
            options={[
              { id: "confirmed", label: t("accessLog.review.disposition.confirmed") },
              { id: "action_required", label: t("accessLog.review.disposition.action_required") },
            ]}
          />
          <Field label={t("accessLog.review.eventId")} required={null}>
            {p => <TextInput {...p} value={eventId} onChange={e => setEventId(e.target.value)} />}
          </Field>
          <Field label={t("accessLog.review.outcomeInput")} required={null}>
            {p => <TextInput {...p} value={outcome} onChange={e => setOutcome(e.target.value)} />}
          </Field>
          <Field label={t("accessLog.review.noteInput")} required={null}>
            {p => <TextInput {...p} value={note} onChange={e => setNote(e.target.value)} />}
          </Field>
        </>
      )}
    </Composer>
  );
}
