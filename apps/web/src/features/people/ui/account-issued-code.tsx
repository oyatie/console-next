// SPDX-License-Identifier: LicenseRef-Proprietary
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
 * A one-time code, shown once: Esc and outside clicks do nothing, only the explicit acknowledgement closes it.
 * Peer ops-holder resets deliver the code to the target's registered recovery contact and never render the secret on screen.
 */
export function IssuedCode({ issued, onDone }: { issued: Issued | null; onDone: () => void }) {
  const peerDelivered = Boolean(issued?.delivered_to_recovery_contact);
  const inviteUrl = issued && !peerDelivered && issued.otp && typeof window !== "undefined" ? buildInviteUrl(window.location.origin, issued.otp) : null;
  const copy = () => issued && !peerDelivered && void navigator.clipboard.writeText(issued.otp).then(() => announce(t("common.codeCopied")), () => announce(t("common.copyFailed")));
  const copyLink = () => inviteUrl && void navigator.clipboard.writeText(inviteUrl).then(() => announce(t("common.inviteLinkCopied")), () => announce(t("common.copyFailed")));
  const intro = issued
    ? peerDelivered
      ? t("accounts.reset.peerDelivered", { name: issued.name, masked: issued.masked_contact ?? "—" })
      : [
          t(issued.reset ? "accounts.resetIssued" : "accounts.issued", { name: issued.name }),
          issued.grantedCount ? t("accounts.issued.granted", { count: issued.grantedCount }) : "",
        ].filter(Boolean).join(" ")
    : "";
  return (
    <Dialog open={issued !== null} title={t(issued?.reset ? "accounts.resetCode.title" : "accounts.firstCode.title")} onClose={onDone} dismissable={false}>
      {issued && (
        <>
          <Muted>{intro}</Muted>
          {/* The sign-in ID goes with the code: the person signs in with both (decisions #33). */}
          {issued.signInId && <KeyValue items={[{ key: "signInId", label: t("accounts.issued.signInId"), value: <span className="code">{issued.signInId}</span> }]} />}
          {!peerDelivered && <div className="secret" aria-label={t("common.oneTimeCode")}>{issued.otp}</div>}
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
            {!peerDelivered && <Button onClick={copy}>{t("common.copyCode")}</Button>}
            {inviteUrl && <Button onClick={copyLink}>{t("common.copyInviteLink")}</Button>}
            {!peerDelivered && !issued.reset && (
              issued.grantedCount ? (
                <Link to="/access/people/$accountId" params={{ accountId: issued.userId }} className="btn" onClick={onDone}>
                  {t("accounts.access.view")}
                </Link>
              ) : (
                <Link to="/access/people/$accountId" params={{ accountId: issued.userId }} search={{ grant: true }} className="btn" onClick={onDone}>
                  {t("accounts.issued.grant")}
                </Link>
              )
            )}
            <Button variant="primary" onClick={onDone}>{t(peerDelivered ? "uiSheet.close" : "common.codeDelivered")}</Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
