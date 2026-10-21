import { Building, Building2, Clock, Home, Inbox, KeyRound, Landmark, Lock, UserMinus, Users } from "lucide-react";
import type { components } from "@console/api";
import { EXIT_FEATURES, granted, type Feature } from "../reference/authz/api";

type Capability = components["schemas"]["MeAuthzCapability"];
/** A grant that lists a link: a feature, and "all" when its screen sits behind the server's org-wide gate. */
type Grant = readonly [Feature, ("all" | "branch")?];

// Five hubs (plan D3); a module is listed only once it is built. Labels are catalog ids,
// resolved at render so a locale switch re-labels the menu. Any of `anyOf` names the /me/authz grant
// that lists a link; the server still enforces and screens render their 403 state.
const NAV = [
  { hub: "shell.hub.work", links: [{ to: "/", label: "shell.link.home", icon: Home }, { to: "/requests", label: "requestOutcome.title", icon: Inbox }] },
  {
    hub: "shell.hub.people",
    links: [
      { to: "/org", label: "shell.link.org", icon: Building2, anyOf: [["org_change_read"]] as readonly Grant[] },
      // listed with the org grant until /me/authz projects legal_entity_manage; the server decides each read and write.
      { to: "/org/entities", label: "shell.link.entities", icon: Landmark, anyOf: [["org_change_read"]] as readonly Grant[] },
      // The employee directory reads by branch (BW-22: a branch-tier allow lists its branches' people); the
      // accounts view on the same page is for user managers.
      { to: "/people", label: "shell.link.people", icon: Users, anyOf: [["employee_directory_read", "branch"], ["user_manage"]] as readonly Grant[] },
      { to: "/statutory", label: "shell.link.statutory", icon: Landmark, anyOf: [["employee_directory_manage", "branch"]] as readonly Grant[] },
      // attendance (decision #22): HR who record attendance, or read the people it is about; the server decides each read and write.
      { to: "/attendance", label: "shell.link.attendance", icon: Clock, anyOf: [["attendance_exception_manage", "branch"], ["employee_directory_read", "branch"]] as readonly Grant[] },
      // Change requests (BW-17): HR works them, any other reader follows the ones they filed.
      { to: "/people/requests", label: "shell.link.requests", icon: Inbox, anyOf: [["employee_directory_read", "branch"]] as readonly Grant[] },
      { to: "/people/exits", label: "shell.link.exits", icon: UserMinus, anyOf: EXIT_FEATURES.map((f) => [f] as const) as readonly Grant[] },
      // Period locks are org-wide: the server refuses a holder its org-wide gate does not pass.
      { to: "/people/period-locks", label: "shell.link.periodLocks", icon: Lock, anyOf: [["period_lock_manage", "all"]] as readonly Grant[] },
    ],
  },
  // Tenant roles and grants (decision #26). listed with the account-management grant until /me/authz
  // projects the access domain; the access API decides every read and write.
  { hub: "shell.hub.admin", links: [{ to: "/access", label: "shell.link.access", icon: KeyRound, anyOf: [["user_manage"]] as readonly Grant[] }] },
] as const;
export const PLATFORM_NAV = [{ hub: "shell.hub.platform", links: [{ to: "/platform", label: "shell.link.tenants", icon: Building }] }] as const;

/**
 * Tenant nav from the advisory /me/authz grants. `caps` undefined = still loading: gated links
 * stay hidden (no flash of a wrong menu). `failed` = the projection is unavailable: list every
 * link and let the server decide. A hub with no visible links is dropped.
 */
export function tenantNav(caps: readonly Capability[] | undefined, failed = false) {
  const can = granted(caps, failed);
  const shown = (l: (typeof NAV)[number]["links"][number]) => !("anyOf" in l) || l.anyOf.some(([f, scope]) => can(f, scope));
  return NAV.map((g) => ({ ...g, links: g.links.filter(shown) })).filter((g) => g.links.length);
}

/**
 * The one link to light up for `pathname`: the deepest link the path sits under, so /people/period-locks
 * lights only the period-locks link while /people/<id> still lights the people link. Every other link
 * then matches its own path exactly only.
 */
export function activeLink(pathname: string, links: readonly { to: string }[]): string | undefined {
  const under = links.filter((l) => l.to !== "/" && (pathname === l.to || pathname.startsWith(l.to + "/")));
  return under.sort((a, b) => b.to.length - a.to.length)[0]?.to;
}
