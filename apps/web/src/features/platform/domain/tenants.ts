// The tenant list's client-side views and search (the list is unpaged), and the status moves offered.
import type { components } from "@console/api/schema";

type Org = components["schemas"]["PlatformOrg"];
type OrgStatus = Org["status"];

export type View = "active" | "suspended" | "archived" | "all";
export const VIEWS: readonly View[] = ["active", "suspended", "archived", "all"];
const STATUS_OF: Record<Exclude<View, "all">, OrgStatus> = { active: "ACTIVE", suspended: "SUSPENDED", archived: "ARCHIVED" };

export const inView = (o: Pick<Org, "status">, v: View) => v === "all" || o.status === STATUS_OF[v];

/** Case-insensitive substring over the name, slug and group name. */
export const matches = (o: Pick<Org, "name" | "slug" | "group_name" | "domain_aliases">, q: string) => {
  const n = q.trim().toLowerCase();
  return !n || [o.name, o.slug, o.group_name ?? "", ...(o.domain_aliases ?? [])].some((s) => s.toLowerCase().includes(n));
};

/** A status change offered from each status: only the moves that make sense. */
export type Move = "suspend" | "archive" | "resume";
export const MOVES: Record<OrgStatus, readonly Move[]> = { ACTIVE: ["suspend", "archive"], SUSPENDED: ["resume", "archive"], ARCHIVED: ["resume"] };
export const TARGET: Record<Move, OrgStatus> = { suspend: "SUSPENDED", archive: "ARCHIVED", resume: "ACTIVE" };
