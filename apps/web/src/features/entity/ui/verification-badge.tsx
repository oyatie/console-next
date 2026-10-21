import { CheckCircle2, CircleAlert, CircleHelp } from "lucide-react";
import type { BusinessRegistration } from "@console/api/pending";
import { t } from "@console/i18n";
import { label, labeled, UNVERIFIED_REASON, VERIFICATION } from "../../../lib/labels";
import { Chip } from "../../../ui/chip";
import { Muted } from "../../../ui/muted/muted";

const ICON = { NONE: CircleHelp, T1: CircleAlert, T2: CheckCircle2 } as const;

/**
 * The registration's authenticity check as the server records it. The MVP checks nothing with the NTS
 * (decisions #16), so a registration honestly reads "not done"; a reason shows only when it says more than that.
 */
export function VerificationBadge({ r }: { r: BusinessRegistration }) {
  const tier = labeled(VERIFICATION, r.verification_tier);
  const Icon = ICON[r.verification_tier];
  return (
    <div className="row" role="group" aria-label={t("entity.verify.label")}>
      <Icon size={16} aria-hidden />
      <Chip tone={tier.tone}>{tier.label}</Chip>
      {r.verification_tier === "NONE" && r.unverified_reason && r.unverified_reason !== "NOT_CHECKED" && <Muted>{t("entity.verify.reason", { reason: label(UNVERIFIED_REASON, r.unverified_reason) })}</Muted>}
    </div>
  );
}
