// BW-13 position catalog: which titles a promotion may pick, the title an employee holds now, and the demotion rule
// the server applies (a lower grade_rank needs the DISCIPLINARY_DEMOTION reason; an unranked side has no verdict).
import type { components } from "@console/api/schema";

type LifecycleEvent = components["schemas"]["EmployeeLifecycleEvent"];
export type JobTitle = { id: string; kind: components["schemas"]["JobTitleKind"]; label: string; grade_rank: number | null; active: boolean };

/** The titles a new promotion may take, most senior first (the server's order). */
export const activeTitles = (items: readonly JobTitle[], kind: JobTitle["kind"]) => items.filter((x) => x.active && x.kind === kind);

/**
 * The catalog title the employee holds now: the one their latest promotion in force named. The server keeps it on
 * the employee but does not return it, so a promotion by free text (which clears it) ends the chain.
 */
export function currentTitle(events: readonly LifecycleEvent[], catalog: readonly JobTitle[]) {
  const last = events
    .filter((x) => x.event_type === "PROMOTE" && x.state === "APPLIED" && !x.voided_by)
    .reduce<LifecycleEvent | undefined>((a, x) => (!a || x.created_at > a.created_at ? x : a), undefined);
  return last?.to_job_title_id ? catalog.find((x) => x.id === last.to_job_title_id) : undefined;
}

/** A move to a lower rank: the server then requires the disciplinary demotion reason. */
export const isDemotion = (from: JobTitle | undefined, to: JobTitle | undefined) =>
  from?.grade_rank != null && to?.grade_rank != null && to.grade_rank < from.grade_rank;

export const DEMOTION_REASON = "DISCIPLINARY_DEMOTION";

/**
 * The promotion a person is offered (spec E6-promote suggestion): the next ranked entry above the one their position
 * names, in the same list; none when their position is not in the list or nothing ranks above it. Never applied
 * until accepted.
 */
export function suggestTitle(position: string | null | undefined, titles: readonly JobTitle[]): JobTitle | undefined {
  const ranked = activeTitles(titles, "TITLE").filter((x) => x.grade_rank != null);
  const now = ranked.find((x) => x.label === position?.trim());
  if (now?.grade_rank == null) return undefined;
  return ranked.filter((x) => x.kind === now.kind && x.grade_rank! > now.grade_rank!).sort((a, b) => a.grade_rank! - b.grade_rank!)[0];
}
