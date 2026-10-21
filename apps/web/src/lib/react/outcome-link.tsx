import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
export function OutcomeLink({id}:{id?:string|null}) {
  return id ? <Link to="/requests/$id" params={{id}}>{t("requestOutcome.open")}</Link> : null;
}
