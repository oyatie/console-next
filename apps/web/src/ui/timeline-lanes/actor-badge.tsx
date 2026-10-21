import { t } from "@console/i18n";
import { Chip } from "../chip";
export function ActorBadge({kind}:{kind?:string|null}) {
  return kind==="OPS_ACCOUNT" ? <Chip tone="warn">{t("timeline.state.emergency")}</Chip>
    : kind==="SUPPORT_OPERATOR" ? <Chip>{t("timeline.state.operator")}</Chip> : null;
}
