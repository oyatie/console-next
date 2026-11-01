import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { t } from "@console/i18n";
import { EmptyState } from "../../../ui/empty-state";

// The account is not an entity, so the chart begins at the first legal entity.
export function FirstRun() {
  return (
    <EmptyState title={t("structure.first.title")} reason={t("structure.first.oneBody")}
      actions={<Link to="/org/entities/new" className="btn btn--primary"><Plus size={16} aria-hidden />{t("structure.first.addEntity")}</Link>} />
  );
}
