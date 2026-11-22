// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { i18n, t } from "@console/i18n";
import type { PrivacyDecisionInput, PrivacyPostponeInput } from "@console/api/pending";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { Composer } from "../../../ui/composer/composer";
import { DateField } from "../../../ui/date/date-field";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { SelectField } from "../../../ui/select/select-field";
import {
  decidePrivacyRequest,
  postponePrivacyRequest,
  privacyLifecycleError,
  privacyOutcomeSupported,
  privacyReasonCodesQuery,
  privacyRefusalReasonDomain,
  type PrivacyOutcome,
  type PrivacyRightKind,
  type WirePrivacyReceipt,
} from "../api/privacy-intake";

export function DecisionComposer({
  requestId,
  kind,
  onClose,
  onDone,
}: {
  requestId: string;
  kind: PrivacyRightKind;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [outcome, setOutcome] = useState<PrivacyOutcome>("GRANTED");
  const [reason, setReason] = useState<string>("");
  const [note, setNote] = useState("");
  const [decidedOn, setDecidedOn] = useState(() => todayKst());

  const domain = outcome === "GRANTED" ? null : privacyRefusalReasonDomain(kind);
  const reasonsQuery = useQuery({
    ...privacyReasonCodesQuery(domain ?? "privacy_refusal_access"),
    enabled: Boolean(domain),
  });
  const reasonOptions = (reasonsQuery.data?.items ?? [])
    .filter(item => item.active)
    .map(item => ({
      id: item.code,
      label: (i18n.locale === "en" && item.label_en) || item.label_ko || item.code,
    }));

  const cmd = useCommand<PrivacyDecisionInput, WirePrivacyReceipt>({
    run: (input, key) => decidePrivacyRequest(requestId, input, key),
    invalidates: ["/api/v1/privacy/rights-requests"],
    onSuccess: () => onDone(t("privacy.intake.decideReceipt")),
  });

  const mappedError = privacyLifecycleError(cmd.error);
  const requiresReason = outcome !== "GRANTED" && Boolean(domain);
  const requiresNote = outcome !== "GRANTED";
  const valid =
    privacyOutcomeSupported(kind, outcome) &&
    (!requiresReason || Boolean(reason)) &&
    (!requiresNote || Boolean(note.trim()));

  return (
    <Composer
      open
      title={t("privacy.intake.decideTitle", { kind: t(`account.privacy.kind.${kind}`) })}
      onClose={onClose}
      action={{ kind: "privacyIntake", mode: "apply" }}
      pending={cmd.isPending}
      error={cmd.error}
      blocked={mappedError ? { reason: mappedError } : undefined}
      notice={!mappedError && cmd.error ? <CommandError error={cmd.error} /> : undefined}
      incomplete={!valid}
      onSubmit={() => {
        if (!valid || cmd.isPending) return;
        cmd.mutate({
          kind,
          outcome,
          reason: outcome === "GRANTED" ? null : reason || null,
          note: note.trim() || null,
          decided_on: decidedOn || null,
        });
      }}
    >
      <SelectField
        label={t("privacy.intake.outcome")}
        placeholder={t("privacy.intake.outcome")}
        value={outcome}
        onChange={value => {
          if ((value === "GRANTED" || value === "PARTIAL" || value === "REFUSED") && privacyOutcomeSupported(kind, value)) {
            setOutcome(value);
            if (value === "GRANTED") setReason("");
          }
        }}
        options={[
          { id: "GRANTED", label: t("account.privacy.outcome.GRANTED") },
          ...(privacyOutcomeSupported(kind, "PARTIAL")
            ? [{ id: "PARTIAL", label: t("account.privacy.outcome.PARTIAL") }]
            : []),
          ...(privacyOutcomeSupported(kind, "REFUSED")
            ? [{ id: "REFUSED", label: t("account.privacy.outcome.REFUSED") }]
            : []),
        ]}
      />
      {kind === "CORRECTION" && (
        <DisabledReason
          control={p => <Button {...p}>{t("account.privacy.outcome.REFUSED")}</Button>}
          reason={t("privacy.intake.correctionOnlyGranted")}
        />
      )}
      {requiresReason && (
        <SelectField
          label={t("privacy.intake.reasonCode")}
          placeholder={t("privacy.intake.reasonPlaceholder")}
          value={reason || null}
          onChange={setReason}
          options={reasonOptions}
        />
      )}
      <DateField
        label={t("privacy.intake.decidedOn")}
        required={false}
        today={todayKst()}
        value={decidedOn}
        onChange={setDecidedOn}
        max={todayKst()}
      />
      <Field label={t("privacy.intake.decideNote")} required={requiresNote}>
        {p => <TextArea {...p} value={note} onChange={e => setNote(e.target.value)} />}
      </Field>
    </Composer>
  );
}

export function PostponeComposer({
  requestId,
  kind,
  onClose,
  onDone,
}: {
  requestId: string;
  kind: PrivacyRightKind;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [reason, setReason] = useState("JUSTIFIED_REASON");
  const [note, setNote] = useState("");
  const [decidedOn, setDecidedOn] = useState(() => todayKst());

  const reasonsQuery = useQuery(privacyReasonCodesQuery("privacy_postpone_access"));
  const reasonOptions = (reasonsQuery.data?.items ?? [])
    .filter(item => item.active)
    .map(item => ({
      id: item.code,
      label: (i18n.locale === "en" && item.label_en) || item.label_ko || item.code,
    }));

  const cmd = useCommand<PrivacyPostponeInput, WirePrivacyReceipt>({
    run: (input, key) => postponePrivacyRequest(requestId, input, key),
    invalidates: ["/api/v1/privacy/rights-requests"],
    onSuccess: () => onDone(t("privacy.intake.postponeReceipt")),
  });

  const mappedError = privacyLifecycleError(cmd.error);
  const valid = Boolean(reason && note.trim());

  return (
    <Composer
      open
      title={t("privacy.intake.postponeTitle", { kind: t(`account.privacy.kind.${kind}`) })}
      onClose={onClose}
      action={{ kind: "privacyIntake", mode: "record" }}
      pending={cmd.isPending}
      error={cmd.error}
      blocked={mappedError ? { reason: mappedError } : undefined}
      notice={!mappedError && cmd.error ? <CommandError error={cmd.error} /> : undefined}
      incomplete={!valid}
      onSubmit={() => {
        if (!valid || cmd.isPending) return;
        cmd.mutate({
          kind,
          reason,
          note: note.trim(),
          decided_on: decidedOn || null,
        });
      }}
    >
      <SelectField
        label={t("privacy.intake.reasonCode")}
        placeholder={t("privacy.intake.reasonPlaceholder")}
        value={reason}
        onChange={setReason}
        options={reasonOptions.length ? reasonOptions : [{ id: "JUSTIFIED_REASON", label: "JUSTIFIED_REASON" }]}
      />
      <DateField
        label={t("privacy.intake.decidedOn")}
        required={false}
        today={todayKst()}
        value={decidedOn}
        onChange={setDecidedOn}
        max={todayKst()}
      />
      <Field label={t("privacy.intake.decideNote")} required>
        {p => <TextArea {...p} value={note} onChange={e => setNote(e.target.value)} />}
      </Field>
    </Composer>
  );
}
