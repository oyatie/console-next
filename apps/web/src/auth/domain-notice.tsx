import { lastSignInId, lastSignInProfile, session } from "@console/api";
import { t } from "@console/i18n";
import { Banner } from "../ui/banner/banner";

/** Alias sign-in is proved before any hint is shown, preserving pre-auth enumeration parity. */
export function DomainNotice() {
  const old = lastSignInId()?.split("@")[1];
  const profile = lastSignInProfile();
  const current = profile?.name.split("@")[1];
  if (!old || !current || old === current || profile?.user_id !== session.claims?.sub) return null;
  return <Banner live="polite">{t("account.domain.aliasNotice", { from: old, to: current, id: profile.name })}</Banner>;
}
