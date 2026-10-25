import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { announce } from "../../../lib/react/announce";
import { Button } from "../../../ui/button/button";
import { Dialog } from "../../../ui/dialog";
import type { Issued } from "../api";

/**
 * A first-admin code, shown exactly once. Only its close button closes it: Esc and an outside click do
 * nothing, so the code is never lost by accident. It claims no delivery, only that it will not show again.
 */
export function CodeDialog({ issued, onClose }: { issued: Issued | null; onClose: () => void }) {
  const copy = (otp: string) => void navigator.clipboard.writeText(otp).then(() => announce(t("common.codeCopied")), () => announce(t("common.copyFailed")));
  return (
    <Dialog open={issued !== null} title={t("tenants.code.title")} onClose={onClose} dismissable={false}>
      {issued && (
        <>
          <p>{t("tenants.code.for", { org: issued.org, at: fmtDateTime(issued.expiresAt) })} {issued.recoveryMinutes ? <>{t("opsRecovery.issued", { minutes: issued.recoveryMinutes })} {t("opsRecovery.codeLost")}</> : t("tenants.next.lost")} {t("tenants.code.closeNote")}</p>
          {issued.signInId && <div role="group" aria-label={t("tenants.code.signInId")}><code>{issued.signInId}</code><Button onClick={() => copy(issued.signInId!)}>{t("tenants.code.copyId")}</Button></div>}
          <div className="secret" role="group" aria-label={t("common.oneTimeCode")}>{issued.otp}</div>
          {/* What happens after the hand-over, so the vendor can tell the admin what to expect. */}
          <section aria-labelledby="tenant-next" className="form">
            <h3 id="tenant-next" className="field__label">{t("tenants.next.title")}</h3>
            <ol className="steps-plain">
              <li>{issued.recoveryMinutes ? t("tenants.next.recovery", { at: fmtDateTime(issued.expiresAt) }) : t("tenants.next.deliver", { at: fmtDateTime(issued.expiresAt) })}</li>
              <li>{t("tenants.next.signIn")}</li>
              <li>{t("tenants.next.setup")}</li>
            </ol>
          </section>
          <div className="form__actions">
            <Button onClick={() => copy(issued.otp)}>{t("common.copyCode")}</Button>
            <Button variant="primary" onClick={onClose}>{t("tenants.code.close")}</Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
