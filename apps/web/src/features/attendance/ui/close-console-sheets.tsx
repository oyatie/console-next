// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Banner } from "../../../ui/banner/banner";
import { Checks } from "../../../ui/choice/checks";
import { Composer } from "../../../ui/composer/composer";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { TextInput } from "../../../ui/field/text-input";
import { amendClose, confirmClose, type ClosePreflight } from "../api";

export function CloseConfirmSheet({
  month,
  branchScope,
  scopeLabel,
  preflight,
  onClose,
}: {
  month: string;
  branchScope: string;
  scopeLabel: string;
  preflight: ClosePreflight | null;
  onClose: () => void;
}) {
  const [attest, setAttest] = useState<string[]>([]);
  const blocked = preflight !== null && !preflight.can_close;
  const cmd = useCommand({
    run: () => confirmClose(month, branchScope),
    invalidates: ["/api/v1/attendance", "/api/v1/period-locks"],
    awaitFirstRead: true,
    announce: () => t("attendance.close.closedDone", { month }),
    onSuccess: () => onClose(),
  });

  return (
    <Composer
      open
      title={t("attendance.close.confirmButton")}
      subtitle={`${month} · ${scopeLabel}`}
      action={{ kind: "attendanceClose", mode: "complete" }}
      onClose={onClose}
      pending={cmd.isPending}
      error={cmd.error}
      notice={<CommandError error={cmd.error} />}
      consequence={branchScope === "org" ? t("attendance.close.attestNote") : undefined}
      dirty={attest.length > 0}
      blocked={
        blocked
          ? { reason: t("attendance.close.blockedReason") }
          : !attest.includes("attest")
            ? { reason: t("attendance.close.attestLabel") }
            : undefined
      }
      onSubmit={() => {
        cmd.mutate(undefined);
      }}
    >
      {branchScope === "org" && <Banner tone="info">{t("attendance.close.attestNote")}</Banner>}
      <Checks
        label={t("attendance.close.confirmButton")}
        items={[{ id: "attest", label: t("attendance.close.attestLabel") }]}
        value={attest}
        onChange={setAttest}
      />
    </Composer>
  );
}

export function CloseAmendSheet({
  closeId,
  scopeLabel,
  onClose,
}: {
  closeId: string;
  scopeLabel: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [detail, setDetail] = useState("");
  const [ref, setRef] = useState("");
  const cmd = useCommand({
    run: (_input: void, key) =>
      amendClose(closeId, {
        reason: reason.trim(),
        detail: detail.trim(),
        ref: ref.trim() || null,
      }, key),
    invalidates: ["/api/v1/attendance"],
    awaitFirstRead: true,
    announce: () => t("attendance.close.amendedDone"),
    onSuccess: () => onClose(),
  });

  const blocked = !reason.trim() || !detail.trim();

  return (
    <Composer
      open
      title={t("attendance.close.amendTitle")}
      subtitle={scopeLabel}
      action={{ kind: "attendanceClose", mode: "record" }}
      onClose={onClose}
      pending={cmd.isPending}
      error={cmd.error}
      notice={<CommandError error={cmd.error} />}
      dirty={Boolean(reason || detail || ref)}
      blocked={blocked ? { reason: t("attendance.issues.missingReason") } : undefined}
      onSubmit={() => {
        cmd.mutate(undefined);
      }}
    >
      <Field label={t("attendance.close.amendReason")} required>
        {(props) => <TextInput {...props} value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>
      <Field label={t("attendance.close.amendDetail")} required>
        {(props) => <TextArea {...props} value={detail} onChange={(e) => setDetail(e.target.value)} />}
      </Field>
      <Field label={t("attendance.close.amendRef")} required={false}>
        {(props) => <TextInput {...props} value={ref} onChange={(e) => setRef(e.target.value)} />}
      </Field>
    </Composer>
  );
}
