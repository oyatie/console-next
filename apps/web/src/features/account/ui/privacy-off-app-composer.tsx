// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { i18n, t } from "@console/i18n";
import type { PrivacyOffAppReceipt } from "@console/api/pending";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Checks } from "../../../ui/choice/checks";
import { Composer } from "../../../ui/composer/composer";
import { DateField } from "../../../ui/date/date-field";
import { Field, TextInput } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { SelectField } from "../../../ui/select/select-field";
import {
  privacyLifecycleError,
  privacyReasonCodesQuery,
  receiveOffAppPrivacyRequest,
  type PrivacyRightKind,
  type WirePrivacyReceipt,
} from "../api/privacy-intake";

const ALL_KINDS: readonly PrivacyRightKind[] = [
  "ACCESS",
  "CORRECTION",
  "DELETION",
  "SUSPENSION",
  "WITHDRAWAL",
];

type IdentityMethod = PrivacyOffAppReceipt["identity_method"];
type AgentKind = PrivacyOffAppReceipt["agent"];

export function PrivacyOffAppComposer({
  onClose,
  onRecorded,
}: {
  onClose: () => void;
  onRecorded: (receipt: WirePrivacyReceipt) => void;
}) {
  const [subjectUserId, setSubjectUserId] = useState("");
  const [channel, setChannel] = useState<PrivacyOffAppReceipt["channel"]>("PHONE");
  const [agent, setAgent] = useState<AgentKind>("SUBJECT");
  const [mandateConfirmed, setMandateConfirmed] = useState<string[]>([]);
  const [kinds, setKinds] = useState<PrivacyRightKind[]>(["ACCESS"]);
  const [receivedOn, setReceivedOn] = useState(() => todayKst());
  const [identityMethod, setIdentityMethod] = useState<IdentityMethod>("ID_DOCUMENT_SEEN");
  const [detail, setDetail] = useState("");

  const methodsQuery = useQuery(privacyReasonCodesQuery("privacy_identity_method"));
  const methodOptions = (methodsQuery.data?.items ?? [])
    .filter(item => item.active)
    .map(item => ({
      id: item.code,
      label: ((i18n.locale === "en" && item.label_en) || item.label_ko || item.code),
    }));

  const cmd = useCommand<PrivacyOffAppReceipt, WirePrivacyReceipt>({
    run: (input, key) => receiveOffAppPrivacyRequest(input, key),
    invalidates: ["/api/v1/privacy/rights-requests"],
    onSuccess: receipt => {
      onRecorded(receipt);
    },
  });

  const mappedError = privacyLifecycleError(cmd.error);
  const valid = Boolean(subjectUserId.trim() && kinds.length > 0 && receivedOn && identityMethod);

  return (
    <Composer
      open
      title={t("privacy.intake.offAppTitle")}
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
          subject_user_id: subjectUserId.trim(),
          controller: "TENANT",
          channel,
          agent,
          mandate_received: mandateConfirmed.includes("mandate"),
          kinds,
          received_on: receivedOn,
          identity_method: identityMethod,
          detail: detail.trim() || "",
        });
      }}
    >
      <Field label={t("privacy.intake.subjectUserId")} required>
        {p => <TextInput {...p} value={subjectUserId} onChange={e => setSubjectUserId(e.target.value)} />}
      </Field>
      <SelectField
        label={t("privacy.intake.channel")}
        placeholder={t("privacy.intake.channel")}
        value={channel}
        onChange={value => {
          if (value === "PHONE" || value === "LETTER" || value === "EMAIL" || value === "IN_PERSON") {
            setChannel(value);
          }
        }}
        options={[
          { id: "PHONE", label: t("privacy.intake.channel.PHONE") },
          { id: "LETTER", label: t("privacy.intake.channel.LETTER") },
          { id: "EMAIL", label: t("privacy.intake.channel.EMAIL") },
          { id: "IN_PERSON", label: t("privacy.intake.channel.IN_PERSON") },
        ]}
      />
      <SelectField
        label={t("privacy.intake.agent")}
        placeholder={t("privacy.intake.agent")}
        value={agent}
        onChange={value => {
          if (value === "SUBJECT" || value === "LEGAL_REPRESENTATIVE" || value === "AUTHORIZED") {
            setAgent(value);
          }
        }}
        options={[
          { id: "SUBJECT", label: t("privacy.intake.agent.SUBJECT") },
          { id: "LEGAL_REPRESENTATIVE", label: t("privacy.intake.agent.LEGAL_REPRESENTATIVE") },
          { id: "AUTHORIZED", label: t("privacy.intake.agent.AUTHORIZED") },
        ]}
      />
      {agent !== "SUBJECT" && (
        <Checks
          label={t("privacy.intake.mandateReceived")}
          items={[{ id: "mandate", label: t("privacy.intake.mandateReceived") }]}
          value={mandateConfirmed}
          onChange={setMandateConfirmed}
        />
      )}
      <Checks
        label={t("account.privacy.kinds")}
        items={ALL_KINDS.map(code => ({ id: code, label: t(`account.privacy.kind.${code}`) }))}
        value={kinds}
        onChange={next => setKinds(next.filter((k): k is PrivacyRightKind => ALL_KINDS.includes(k as PrivacyRightKind)))}
      />
      <DateField
        label={t("privacy.intake.receivedOn")}
        required
        today={todayKst()}
        value={receivedOn}
        onChange={setReceivedOn}
        max={todayKst()}
      />
      <SelectField
        label={t("privacy.intake.identityMethod")}
        placeholder={t("privacy.intake.identityMethod")}
        value={identityMethod}
        onChange={value => {
          if (
            value === "SIGNED_IN" ||
            value === "PASSKEY" ||
            value === "ID_DOCUMENT_SEEN" ||
            value === "KNOWN_CONTACT" ||
            value === "AGENT_MANDATE"
          ) {
            setIdentityMethod(value);
          }
        }}
        options={
          methodOptions.length
            ? methodOptions
            : [
                { id: "SIGNED_IN", label: "SIGNED_IN" },
                { id: "ID_DOCUMENT_SEEN", label: "ID_DOCUMENT_SEEN" },
                { id: "KNOWN_CONTACT", label: "KNOWN_CONTACT" },
                { id: "AGENT_MANDATE", label: "AGENT_MANDATE" },
              ]
        }
      />
      <Field label={t("account.privacy.detail")} required={false}>
        {p => <TextArea {...p} value={detail} onChange={e => setDetail(e.target.value)} />}
      </Field>
    </Composer>
  );
}
