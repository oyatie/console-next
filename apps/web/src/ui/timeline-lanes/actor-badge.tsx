import { t } from "@console/i18n";
import { Chip } from "../chip";

export function ActorBadge({ kind, breakGlass }: { kind?: string | null; breakGlass?: boolean | null }) {
  if (kind === "OPS_ACCOUNT") {
    return breakGlass ? <Chip tone="warn">{t("timeline.state.emergency")}</Chip> : <Chip>{t("accounts.ops")}</Chip>;
  }
  if (kind === "SUPPORT_OPERATOR") {
    return <Chip>{t("timeline.state.operator")}</Chip>;
  }
  return null;
}
