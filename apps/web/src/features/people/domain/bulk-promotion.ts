import { activeTitles, isDemotion, type JobTitle } from "./titles";

/** Paste accepts an exact catalog label; pickers keep the catalog ID. Unknown entries never clear an existing title. */
export function bulkPromotion(target: string, catalog: readonly JobTitle[]) {
  const titles = activeTitles(catalog, "TITLE");
  if (!titles.length) return { to_position: target.trim() };
  const matches = titles.filter((x) => x.id === target || x.label === target.trim());
  return matches.length === 1 ? { to_position: matches[0]!.label, to_job_title_id: matches[0]!.id } : null;
}

/** Advisory rank check; the server validates the current catalog IDs again at commit. */
export function bulkDemotion(current: string | null | undefined, target: string, catalog: readonly JobTitle[]) {
  const to = bulkPromotion(target, catalog);
  return isDemotion(catalog.find((x) => x.kind === "TITLE" && x.label === current), catalog.find((x) => x.id === to?.to_job_title_id));
}
