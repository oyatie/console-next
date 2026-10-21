import { KeyRound } from "lucide-react";
import { t } from "@console/i18n";
import { PasskeyError } from "../../../lib/react/passkey-error";
import { useCommand } from "../../../lib/react/command";
import { Button } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { conflict, reissueCode, type Issued, type Org } from "../api";
import s from "./tenants.module.css";

/**
 * Replaces the first admin's sign-in code while that admin has no passkey (the previous code stops
 * working). The server refuses for good once any super admin of the tenant ever enrolled a passkey, so
 * that refusal turns the button into a stated block, and the precondition is said before the first press.
 */
export function Reissue({ org, enrolled, onEnrolled, onIssued }: { org: Org; enrolled: boolean; onEnrolled: () => void; onIssued: (r: Issued) => void }) {
  const reissue = useCommand({
    run: async () => {
      try {
        return await reissueCode(org);
      } catch (e) {
        if (conflict(e, "admin_already_enrolled")) onEnrolled();
        throw e;
      }
    },
    onSuccess: onIssued,
    forget: true,
  });
  const label = <><KeyRound size={16} aria-hidden /> {t("tenants.reissue")}</>;
  return (
    <section className={s.section} aria-labelledby="tenant-code">
      <h3 id="tenant-code" className={s.heading}>{t("tenants.section.code")}</h3>
      {enrolled ? (
        <DisabledReason control={(p) => <Button {...p}>{label}</Button>} reason={t("tenants.reissue.enrolled", { org: org.name })} />
      ) : (
        <>
          <p className={s.note}>{t("tenants.reissue.consequence", { org: org.name })}</p>
          {conflict(reissue.error) ? <div className="alert" role="alert">{t("tenants.reissue.inactive", { org: org.name })}</div> : <PasskeyError error={reissue.error} />}
          <Button aria-describedby="tenant-code-pre" disabled={reissue.isPending} onClick={() => reissue.mutate(undefined)}>{label}</Button>
          <p id="tenant-code-pre" className={s.note}>{t("tenants.reissue.precondition")}</p>
        </>
      )}
    </section>
  );
}
