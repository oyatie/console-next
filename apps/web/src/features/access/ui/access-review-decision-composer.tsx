// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { isMessageId, t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { ReasonCodeField } from "../../../reference/reason/ui/reason-code-field";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Composer } from "../../../ui/composer/composer";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { KeyValue } from "../../../ui/key-value/key-value";
import { RecordIdentityBar } from "../../../ui/patterns/list-record-parts";
import {
  ACCESS_REVIEW_READS,
  recordAccessReviewDecision,
  type AccessReviewItem,
} from "../policy-api";
import s from "./access.module.css";

const ownError = (code: string) => {
  const id = `accessReview.error.${code}`;
  return isMessageId(id) ? t(id) : undefined;
};

export function AccessReviewDecisionComposer({
  period,
  item,
  onClose,
}: {
  period: string;
  item: AccessReviewItem;
  onClose: () => void;
}) {
  const [decision, setDecision] = useState<string | null>(item.decision ?? null);
  const [reasonCode, setReasonCode] = useState<string | null>(item.reason_code ?? null);
  const [note, setNote] = useState(item.reason_note ?? "");

  const decideCmd = useCommand({
    run: (_: undefined, key: string) =>
      recordAccessReviewDecision(
        period,
        {
          item_id: item.id,
          decision: (decision ?? "KEEP") as "KEEP" | "REVOKE",
          reason_code: decision === "REVOKE" ? reasonCode : null,
          reason_note: note.trim() || null,
        },
        key,
      ),
    invalidates: ACCESS_REVIEW_READS,
    announce: () => t("accessReview.decision.saved"),
  });

  const incomplete = !decision || (decision === "REVOKE" && !reasonCode);

  return (
    <Composer
      layout="inline"
      headingLevel={3}
      title={t("accessReview.decision.section")}
      action={{ kind: "accessReview", mode: "record" }}
      error={decideCmd.error}
      notice={<CommandError error={decideCmd.error} own={ownError} />}
      pending={decideCmd.isPending}
      incomplete={incomplete}
      consequence={decision === "REVOKE" ? t("accessReview.decision.consequenceRevoke") : undefined}
      onClose={onClose}
      onSubmit={() => {
        if (!incomplete) decideCmd.mutate(undefined);
      }}
    >
      <div className={s.stack}>
        <RecordIdentityBar
          name={item.account_name}
          number={item.employee_number ?? undefined}
          roleLine={item.unit_name ?? item.role_name_ko}
        />
        <KeyValue
          density="dense"
          items={[
            { key: "role", label: t("accessReview.role"), value: item.role_name_ko },
            { key: "scope", label: t("accessReview.scope"), value: item.scope_label },
          ]}
        />
        <ChoiceField
          label={t("accessReview.decision.section")}
          required
          value={decision}
          onChange={setDecision}
          options={[
            { value: "KEEP", label: t("accessReview.decision.KEEP") },
            { value: "REVOKE", label: t("accessReview.decision.REVOKE") },
          ]}
        />
        {decision === "REVOKE" && (
          <ReasonCodeField
            domain="role_change"
            label={t("accessReview.decision.reasonLabel")}
            value={reasonCode}
            onChange={setReasonCode}
          />
        )}
        <Field label={t("accessReview.decision.noteLabel")} required={false}>
          {(p) => <TextArea {...p} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </div>
    </Composer>
  );
}
