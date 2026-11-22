// The tenant list's client-side views, filters, sort and search (the list is unpaged), and the status moves offered.
import type { components } from "@console/api/schema";

type Org = components["schemas"]["PlatformOrg"];
type OrgStatus = Org["status"];
type GroupRole = components["schemas"]["PlatformGroupRole"];

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

export const LIFECYCLES = ["OPENED", "CODE_ISSUED", "ENROLLED", "SETUP", "OPERATING"] as const;
export type TenantLifecycle = (typeof LIFECYCLES)[number];
export type TenantSortField = "name" | "created_at" | "status";

export const PLATFORM_GROUP_ROLE: {
  type: string;
  values: readonly GroupRole[];
  extensible: true;
  message: (v: string) => string;
} = {
  type: "platformGroupRole",
  values: ["GROUP_ADMIN", "GROUP_VIEWER", "GROUP_FINANCE"],
  extensible: true,
  message: (v) => `enum.platformGroupRole.${v}`,
};

export const needsAttention = (o: Pick<Org, "status" | "pending_domain" | "lifecycle">) =>
  Boolean(o.pending_domain) || o.status === "SUSPENDED" || o.lifecycle === "OPENED" || o.lifecycle === "CODE_ISSUED";

export function tenantKpiCounts(orgs: readonly Org[]) {
  return {
    all: orgs.length,
    active: orgs.filter((o) => o.status === "ACTIVE").length,
    suspended: orgs.filter((o) => o.status === "SUSPENDED").length,
    archived: orgs.filter((o) => o.status === "ARCHIVED").length,
    attention: orgs.filter((o) => needsAttention(o)).length,
  };
}

export function filterTenants(
  orgs: readonly Org[],
  options: {
    q: string;
    statuses: ReadonlySet<OrgStatus>;
    lifecycles: ReadonlySet<TenantLifecycle>;
    groupFilter: string | null;
    attentionOnly: boolean;
  },
): Org[] {
  return orgs.filter((o) => {
    if (!matches(o, options.q)) return false;
    if (options.statuses.size > 0 && !options.statuses.has(o.status)) return false;
    if (options.lifecycles.size > 0 && (!o.lifecycle || !options.lifecycles.has(o.lifecycle))) return false;
    if (options.groupFilter === "__none__" && o.group_id !== null) return false;
    if (options.groupFilter && options.groupFilter !== "__none__" && o.group_id !== options.groupFilter) return false;
    if (options.attentionOnly && !needsAttention(o)) return false;
    return true;
  });
}

export function sortTenants(orgs: readonly Org[], field: TenantSortField, direction: "asc" | "desc"): Org[] {
  const dir = direction === "asc" ? 1 : -1;
  return [...orgs].sort((a, b) => {
    const cmp =
      field === "created_at"
        ? a.created_at.localeCompare(b.created_at)
        : field === "status"
          ? a.status.localeCompare(b.status) || a.name.localeCompare(b.name)
          : a.name.localeCompare(b.name);
    return cmp * dir;
  });
}
