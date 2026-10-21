import { Link } from "@tanstack/react-router";
import { ClipboardPaste, FileSpreadsheet, History, Rows3 } from "lucide-react";
import { t } from "@console/i18n";

/**
 * The bulk paths at the same weight as the one-by-one ones (spec D8): import, paste, edit together, and the history.
 * The company structure head and the empty structure mount it; `entity` / `workplace` aim the paste at that place
 * so it asks nothing. Links only, so it lives in the shared reference layer and no slice imports another.
 */
export function BulkLinks({ entity, workplace }: { entity?: string; workplace?: string }) {
  return (
    <nav aria-label={t("orgBulk.links.label")} className="row">
      <Link to="/org/import" className="btn"><FileSpreadsheet size={16} aria-hidden /> {t("orgBulk.links.import")}</Link>
      <Link to="/org/paste" search={entity ? { entity } : workplace ? { workplace } : {}} className="btn"><ClipboardPaste size={16} aria-hidden /> {t("orgBulk.links.paste")}</Link>
      <Link to="/org/workplaces/edit" className="btn"><Rows3 size={16} aria-hidden /> {t("orgBulk.links.edit")}</Link>
      <Link to="/org/history" className="btn btn--ghost"><History size={16} aria-hidden /> {t("orgBulk.links.history")}</Link>
    </nav>
  );
}
