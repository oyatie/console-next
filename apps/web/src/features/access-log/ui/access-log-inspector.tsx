// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { fmtDateTime, fmtNumber } from "@console/i18n/format";
import { codeText } from "../../../lib/labels";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { Field, TextInput } from "../../../ui/field/field";
import { KeyValue } from "../../../ui/key-value/key-value";
import { RecordIdentityBar, RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import { Receipt } from "../../../ui/receipt/receipt";
import { SelectField } from "../../../ui/select/select-field";
import { recordAccessLogFinding, type AccessLogEvent, type AccessLogFlag } from "../api";
import s from "./access-log.module.css";

const flagText = (flag: AccessLogFlag) => t(`accessLog.flag.${flag}`);
const ownFindingError = (code: string) => {
  if (code === "review_incomplete") return t("accessLog.review.error.incomplete");
  if (code === "scope_tenant_wide_only") return t("accessLog.review.error.tenantOnly");
  return undefined;
};

export function AccessLogInspector({
  event,
  period,
}: {
  event: AccessLogEvent;
  period: string;
}) {
  const [disposition, setDisposition] = useState<"confirmed" | "action_required">("confirmed");
  const [outcome, setOutcome] = useState("");
  const [note, setNote] = useState("");
  const [receiptMsg, setReceiptMsg] = useState<string | null>(null);

  const findingCmd = useCommand({
    run: (_input: void, idempotencyKey) =>
      recordAccessLogFinding(period, idempotencyKey, {
        event_id: event.event_id,
        disposition,
        outcome: outcome.trim() || null,
        note: note.trim() || null,
      }),
    invalidates: ["/api/v1/access/access-log"],
    onSuccess: () => {
      setOutcome("");
      setNote("");
      setReceiptMsg(t("accessLog.review.findingReceipt"));
    },
  });

  const actionLabel = codeText(`accessLog.action.${event.action}`, event.action);
  const targetLabel = event.target_type
    ? codeText(`accessLog.target.${event.target_type}`, event.target_type)
    : "—";

  return (
    <div className={s.paneDetail}>
      <RecordIdentityBar
        name={event.actor_name}
        badges={
          <>
            <Chip tone={event.outcome === "DENIED" ? "danger" : "ok"}>
              {t(`accessLog.outcome.${event.outcome}`)}
            </Chip>
            {event.flags.map((flag) => (
              <Chip key={flag} tone="warn">
                {flagText(flag)}
              </Chip>
            ))}
          </>
        }
        roleLine={actionLabel}
        path={<code className="mono t-xs muted">{event.action}</code>}
      />

      <RecordPaneSection title={t("accessLog.review.inspectorTitle")}>
        <KeyValue
          density="dense"
          items={[
            { key: "actor", label: t("accessLog.actor"), value: event.actor_name },
            { key: "target", label: t("accessLog.targetType"), value: targetLabel },
            { key: "subjects", label: t("accessLog.subjects"), value: fmtNumber(event.subject_count) },
            { key: "at", label: t("accessLog.at"), value: fmtDateTime(event.occurred_at) },
            { key: "ip", label: t("accessLog.ip"), value: event.ip ?? "—" },
            { key: "purpose", label: t("accessLog.purpose"), value: event.export_purpose ?? "—" },
            {
              key: "flags",
              label: t("accessLog.flags"),
              value: event.flags.length ? event.flags.map(flagText).join(" · ") : "—",
            },
          ]}
        />
      </RecordPaneSection>

      {Boolean(period) && (
        <RecordPaneSection title={t("accessLog.review.recordForEvent")}>
          <div className={s.paneDetail}>
            {receiptMsg && <Receipt state="recorded" message={receiptMsg} />}
            <CommandError error={findingCmd.error} own={ownFindingError} />
            <SelectField
              label={t("accessLog.review.disposition")}
              placeholder={t("accessLog.review.disposition")}
              value={disposition}
              onChange={(key) => {
                if (key === "confirmed" || key === "action_required") setDisposition(key);
              }}
              options={[
                { id: "confirmed", label: t("accessLog.review.disposition.confirmed") },
                { id: "action_required", label: t("accessLog.review.disposition.action_required") },
              ]}
            />
            <Field label={t("accessLog.review.outcomeInput")} required={null}>
              {(p) => <TextInput {...p} value={outcome} onChange={(e) => setOutcome(e.target.value)} />}
            </Field>
            <Field label={t("accessLog.review.noteInput")} required={null}>
              {(p) => <TextInput {...p} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
            <div className={s.footActions}>
              <Button
                size="sm"
                variant="primary"
                disabled={findingCmd.isPending}
                onClick={() => findingCmd.mutate(undefined)}
              >
                {t("accessLog.review.recordFinding")}
              </Button>
            </div>
          </div>
        </RecordPaneSection>
      )}
    </div>
  );
}
