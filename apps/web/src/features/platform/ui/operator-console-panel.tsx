// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { announce } from "../../../lib/react/announce";
import { useCommand } from "../../../lib/react/command";
import { PasskeyError } from "../../../lib/react/passkey-error";
import { Button, Form } from "../../../ui/button/button";
import { Dialog } from "../../../ui/dialog";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { EnumValue } from "../../../ui/enum-value";
import { Field, TextInput } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { KeyValue } from "../../../ui/key-value/key-value";
import { RecordIdentityBar, RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import {
  inviteOperator,
  reissueOperatorInvite,
  revokeOperator,
  type Issued,
  type OperatorSummary,
  type Recorded,
} from "../api";
import { PLATFORM_OPERATOR_STATUS, canReissueOperator, operatorRevokeReason } from "../domain/operators";
import s from "./platform-console.module.css";

export function OperatorConsolePanel({
  op,
  all,
  currentUserId,
  onIssued,
  onRevoked,
}: {
  op: OperatorSummary;
  all: readonly OperatorSummary[];
  currentUserId?: string;
  onIssued: (i: Issued, receipt: Recorded) => void;
  onRevoked: (receipt: Recorded) => void;
}) {
  const [revoking, setRevoking] = useState(false);

  const reissue = useCommand({
    run: () => reissueOperatorInvite(op.user_id),
    invalidates: ["/api/platform"],
    forget: true,
    onSuccess: (res) => {
      onIssued(
        {
          kind: "operator",
          org: res.operator.display_name,
          otp: res.invite_token,
          expiresAt: res.expires_at,
          signInId: res.operator.sign_in_id,
        },
        { message: t("tenants.operators.reissueDone", { name: op.display_name }) },
      );
    },
  });

  const revokeReason = operatorRevokeReason(op, all, currentUserId);

  return (
    <div className={s.paneStack}>
      <RecordIdentityBar
        name={op.display_name}
        number={op.sign_in_id ? <code>{op.sign_in_id}</code> : undefined}
        badges={<EnumValue e={PLATFORM_OPERATOR_STATUS} value={op.status} />}
      />

      <RecordPaneSection title={t("tenants.operators.details")}>
        <KeyValue
          density="dense"
          items={[
            { key: "login", label: t("tenants.operators.col.login"), value: <code>{op.sign_in_id ?? "—"}</code> },
            {
              key: "passkey",
              label: t("tenants.operators.col.passkey"),
              value: t(
                op.device_bound_passkey
                  ? "tenants.operators.passkey.bound"
                  : op.has_passkey
                    ? "tenants.operators.passkey.enrolled"
                    : "tenants.operators.passkey.none",
              ),
            },
            ...(op.invite_expires_at
              ? [{ key: "expires", label: t("tenants.operators.col.expires"), value: <bdi className="num">{fmtDateTime(op.invite_expires_at)}</bdi> }]
              : []),
            { key: "created", label: t("tenants.panel.created"), value: <bdi className="num">{fmtDateTime(op.created_at)}</bdi> },
          ]}
        />
      </RecordPaneSection>

      <RecordPaneSection title={t("tenants.operators.actions")}>
        <div className={s.paneStack}>
          <PasskeyError error={reissue.error} />
          <div className={s.actionRow}>
            {canReissueOperator(op) ? (
              <Button size="sm" variant="secondary" disabled={reissue.isPending} onClick={() => reissue.mutate(undefined)}>
                {t("tenants.operators.reissue")}
              </Button>
            ) : null}
            {revokeReason ? (
              <DisabledReason
                reason={t(`common.failed.code.${revokeReason}`)}
                control={(p) => (
                  <Button size="sm" {...p}>
                    {t("tenants.operators.revoke")}
                  </Button>
                )}
              />
            ) : (
              <Button size="sm" variant="secondary" onClick={() => setRevoking(true)}>
                {t("tenants.operators.revoke")}
              </Button>
            )}
          </div>
        </div>
      </RecordPaneSection>

      <RevokeOperatorDialog
        open={revoking}
        op={op}
        onClose={() => setRevoking(false)}
        onDone={() => {
          setRevoking(false);
          onRevoked({ message: t("tenants.operators.revokeDone", { name: op.display_name }) });
        }}
      />
    </div>
  );
}

type InviteOperatorProps = {
  open: boolean;
  onClose: () => void;
  onInvited: (res: Awaited<ReturnType<typeof inviteOperator>>) => void;
};

export function InviteOperatorDialog(props: InviteOperatorProps) {
  if (!props.open) return null;
  return <InviteOperatorDialogBody {...props} />;
}

function InviteOperatorDialogBody({ open, onClose, onInvited }: InviteOperatorProps) {
  const [name, setName] = useState("");
  const [login, setLogin] = useState("");
  const [tried, setTried] = useState(false);

  const invite = useCommand({
    run: () => inviteOperator(crypto.randomUUID(), name.trim(), login.trim() || null),
    invalidates: ["/api/platform"],
    forget: true,
    onSuccess: (res) => {
      setName("");
      setLogin("");
      setTried(false);
      onInvited(res);
    },
  });

  const submit = () => {
    setTried(true);
    if (!name.trim()) {
      announce(t("tenants.groups.form.required"));
      return;
    }
    invite.mutate(undefined);
  };

  return (
    <Dialog open={open} title={t("tenants.operators.invite")} onClose={onClose} dismissable={!invite.isPending}>
      <Form className="form" onSubmit={submit} noValidate>
        <Field label={t("tenants.operators.form.name")} required error={tried && !name.trim() ? t("tenants.groups.form.required") : undefined}>
          {(p) => <TextInput {...p} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label={t("tenants.operators.form.login")} required={false}>
          {(p) => <TextInput {...p} value={login} onChange={(e) => setLogin(e.target.value)} />}
        </Field>
        <PasskeyError error={invite.error} />
        <div className="form__actions">
          <Button onClick={onClose} disabled={invite.isPending}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={invite.isPending}>
            {t("tenants.operators.form.submit")}
          </Button>
        </div>
      </Form>
    </Dialog>
  );
}

type RevokeOperatorProps = {
  open: boolean;
  op: OperatorSummary;
  onClose: () => void;
  onDone: () => void;
};

function RevokeOperatorDialog(props: RevokeOperatorProps) {
  if (!props.open) return null;
  return <RevokeOperatorDialogBody {...props} />;
}

function RevokeOperatorDialogBody({ open, op, onClose, onDone }: RevokeOperatorProps) {
  const [note, setNote] = useState("");
  const revoke = useCommand({
    run: () => revokeOperator(op.user_id, note.trim() || null),
    invalidates: ["/api/platform"],
    forget: true,
    onSuccess: () => {
      setNote("");
      onDone();
    },
  });

  return (
    <Dialog open={open} title={t("tenants.operators.revoke")} onClose={onClose} dismissable={!revoke.isPending}>
      <Form className="form" onSubmit={() => revoke.mutate(undefined)} noValidate>
        <bdi className="t-sm">{t("tenants.operators.revokeConsequence", { name: op.display_name })}</bdi>
        <Field label={t("tenants.operators.revokeReason")} required={false}>
          {(p) => <TextArea {...p} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <PasskeyError error={revoke.error} />
        <div className="form__actions">
          <Button onClick={onClose} disabled={revoke.isPending}>{t("common.cancel")}</Button>
          <Button type="submit" variant="danger" disabled={revoke.isPending}>
            {t("tenants.operators.revoke")}
          </Button>
        </div>
      </Form>
    </Dialog>
  );
}
