import { verificationState } from "../present-verification";
import { CheckCircle2, CircleAlert, CircleHelp } from "lucide-react";
import type { BusinessRegistration } from "@console/api/pending";
import { t } from "@console/i18n";
import { label, UNVERIFIED_REASON } from "../../../lib/labels";
import { Chip } from "../../../ui/chip";
import { Muted } from "../../../ui/muted/muted";

const ICON = { NONE: CircleHelp, T1: CircleAlert, T2: CheckCircle2 } as const;

/** State derived from current-number authority evidence. */
export function VerificationBadge({ r }: { r: BusinessRegistration }) {
  const tier = verificationState(r);
  const Icon = ICON[r.verification_tier];
  return (
    <div className="row" role="group" aria-label={t("entity.verify.label")}>
      <Icon size={16} aria-hidden />
      <Chip tone={tier.tone}>{tier.label}</Chip>
      {r.verification_tier === "NONE" && r.unverified_reason && r.unverified_reason !== "NOT_CHECKED" && <Muted>{t("entity.verify.reason", { reason: label(UNVERIFIED_REASON, r.unverified_reason) })}</Muted>}
    </div>
  );
}
