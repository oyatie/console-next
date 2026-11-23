// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import type { PrivacyObjectionInput } from "@console/api/pending";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Checks } from "../../../ui/choice/checks";
import { Composer } from "../../../ui/composer/composer";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { SelectField } from "../../../ui/select/select-field";
import {
  objectPrivacyRequest,
  privacyLifecycleErrorCode,
  type PrivacyRightKind,
  type WirePrivacyReceipt,
} from "../api/privacy-intake";

export function PrivacyObjectionComposer({
  requestId,
  availableKinds,
  defaultChannel = "IN_APP",
  onClose,
  onSubmitted,
}: {
  requestId: string;
  availableKinds: readonly PrivacyRightKind[];
  defaultChannel?: NonNullable<PrivacyObjectionInput["channel"]>;
  onClose: () => void;
  onSubmitted: (receipt: WirePrivacyReceipt) => void;
}) {
  const [kinds, setKinds] = useState<PrivacyRightKind[]>(availableKinds.slice(0, 1));
  const [channel, setChannel] = useState<NonNullable<PrivacyObjectionInput["channel"]>>(defaultChannel);
  const [detail, setDetail] = useState("");

  const cmd = useCommand<PrivacyObjectionInput, WirePrivacyReceipt>({
    run: (input, key) => objectPrivacyRequest(requestId, input, key),
    invalidates: ["/api/v1/privacy/rights-requests"],
    onSuccess: receipt => {
      onSubmitted(receipt);
    },
  });

  const valid = kinds.length > 0 && detail.trim().length > 0;

  return (
    <Composer
      open
      title={t("privacy.intake.objectionTitle")}
      onClose={onClose}
      action={{ kind: "privacyIntake", mode: "apply" }}
      pending={cmd.isPending}
      error={cmd.error}
      notice={<CommandError error={cmd.error} own={privacyLifecycleErrorCode} />}
      incomplete={!valid}
      onSubmit={() => {
        if (!valid || cmd.isPending) return;
        cmd.mutate({
          kinds,
          detail: detail.trim(),
          channel,
        });
      }}
    >
      <Checks
        label={t("account.privacy.kinds")}
        items={availableKinds.map(code => ({ id: code, label: t(`account.privacy.kind.${code}`) }))}
        value={kinds}
        onChange={next => setKinds(next.filter((k): k is PrivacyRightKind => availableKinds.includes(k as PrivacyRightKind)))}
      />
      <SelectField
        label={t("privacy.intake.channel")}
        placeholder={t("privacy.intake.channel")}
        value={channel}
        onChange={value => {
          if (value === "IN_APP" || value === "PHONE" || value === "LETTER" || value === "EMAIL" || value === "IN_PERSON") {
            setChannel(value);
          }
        }}
        options={[
          { id: "IN_APP", label: t("privacy.intake.channel.IN_APP") },
          { id: "PHONE", label: t("privacy.intake.channel.PHONE") },
          { id: "LETTER", label: t("privacy.intake.channel.LETTER") },
          { id: "EMAIL", label: t("privacy.intake.channel.EMAIL") },
          { id: "IN_PERSON", label: t("privacy.intake.channel.IN_PERSON") },
        ]}
      />
      <Field label={t("privacy.intake.objectionDetail")} required>
        {p => <TextArea {...p} value={detail} onChange={e => setDetail(e.target.value)} />}
      </Field>
    </Composer>
  );
}
