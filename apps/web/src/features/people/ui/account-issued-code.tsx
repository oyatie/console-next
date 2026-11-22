import { lazy, Suspense } from "react";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { chunk } from "../../../lib/chunk-guard";
import { buildInviteUrl } from "../../../lib/pure/invite-link";
import { Dialog } from "../../../ui/dialog";
import { Button } from "../../../ui/button/button";
import { KeyValue } from "../../../ui/key-value/key-value";
import { announce } from "../../../lib/react/announce";
import type { Issued } from "./use-issue-code";
import { Muted } from "../../../ui/muted/muted";

const QrCode = lazy(() => chunk(import("../../../ui/qr-code/qr-code")));

/**
 * A one-time code, shown once: Esc and outside clicks do nothing, only "code delivered" closes it. An invited account
 * holds no access (governance-01), so the invite's code also offers to continue into granting access for that account.
 */
export function IssuedCode({ issued, onDone }: { issued: Issued | null; onDone: () => void }) {
  const inviteUrl = issued && typeof window !== "undefined" ? buildInviteUrl(window.location.origin, issued.otp) : null;
  const copy = () => issued && void navigator.clipboard.writeText(issued.otp).then(() => announce(t("common.codeCopied")), () => announce(t("common.copyFailed")));
  const copyLink = () => inviteUrl && void navigator.clipboard.writeText(inviteUrl).then(() => announce(t("common.inviteLinkCopied")), () => announce(t("common.copyFailed")));
  return (
    <Dialog open={issued !== null} title={t(issued?.reset ? "accounts.resetCode.title" : "accounts.firstCode.title")} onClose={onDone} dismissable={false}>
      {issued && (
        <>
          <Muted>{t(issued.reset ? "accounts.resetIssued" : "accounts.issued", { name: issued.name })}</Muted>
          {/* The sign-in ID goes with the code: the person signs in with both (decisions #33). */}
          {issued.signInId && <KeyValue items={[{ key: "signInId", label: t("accounts.issued.signInId"), value: <span className="code">{issued.signInId}</span> }]} />}
          <div className="secret" aria-label={t("common.oneTimeCode")}>{issued.otp}</div>
          <span className="muted num">{t("common.expiresAt", { at: fmtDateTime(issued.expires_at) })}</span>
          {inviteUrl && (
            <div className="qr-group" role="group" aria-label={t("common.inviteLink")}>
              <code className="code">{inviteUrl}</code>
              <Suspense fallback={<span className="qr-slot" aria-hidden="true" />}>
                <QrCode value={inviteUrl} label={t("common.inviteQrLabel")} />
              </Suspense>
            </div>
          )}
          <div className="form__actions">
            <Button onClick={copy}>{t("common.copyCode")}</Button>
            {inviteUrl && <Button onClick={copyLink}>{t("common.copyInviteLink")}</Button>}
            {!issued.reset && (
              <Link to="/access/people/$accountId" params={{ accountId: issued.userId }} search={{ grant: true }} className="btn" onClick={onDone}>
                {t("accounts.issued.grant")}
              </Link>
            )}
            <Button variant="primary" onClick={onDone}>{t("common.codeDelivered")}</Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
