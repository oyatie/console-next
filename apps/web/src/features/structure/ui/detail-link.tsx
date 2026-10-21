import { getRouteApi, Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import type { ChartNode } from "../domain/model";

// The one place a chart node maps to its record screen, so the legal entity / workplace / department panels (S3, S5, S6) can swap in
// their own routes. A department's record is its side panel (S6), opened by selecting it.

const route = getRouteApi("/app/org");

/** The legal entity record, or its workplace tab with the workplace picked. */
export function DetailLink({ n, className }: { n: ChartNode; className?: string }) {
  const q = route.useSearch();
  const search = { as_of: q.compare_b ?? q.as_of, known_at: q.known_at };
  if (n.kind === "entity") return <Link to="/org/entities/$id" params={{ id: n.id }} search={search} className={className}>{t("structure.tools.detail")}</Link>;
  if (n.kind === "site" && n.entityId) return <Link to="/org/entities/$id" params={{ id: n.entityId }} search={{ ...search, wp: n.id }} className={className}>{t("structure.tools.detail")}</Link>;
  if (n.kind === "dept") return <Link to="/org" search={{ ...q, ...search, sel: n.id }} className={className}>{t("structure.tools.detail")}</Link>;
  return null;
}
