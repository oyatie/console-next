import { Building, Building2, Clock, Home, Inbox, KeyRound, Landmark, Lock, UserMinus, Users } from "lucide-react";
import type { StaticDataRouteOption } from "@tanstack/react-router";
import type { AccessEffective } from "../reference/authz/api";
import { accessRefusal } from "../reference/authz/domain/access";

// Five hubs (plan D3); a module is listed only once it is built. Labels are catalog ids,
// resolved at render so a locale switch re-labels the menu. Visibility uses the destination route's requirement.
const NAV = [
  { hub: "shell.hub.work", links: [{ to: "/", label: "shell.link.home", icon: Home }, { to: "/requests", label: "requestOutcome.title", icon: Inbox }] },
  {
    hub: "shell.hub.people",
    links: [
      { to: "/org", label: "shell.link.org", icon: Building2 },
      { to: "/org/entities", label: "shell.link.entities", icon: Landmark },
      { to: "/people", label: "shell.link.people", icon: Users },
      { to: "/statutory", label: "shell.link.statutory", icon: Landmark },
      { to: "/attendance", label: "shell.link.attendance", icon: Clock },
      // Change requests (BW-17): HR works them, any other reader follows the ones they filed.
      { to: "/people/requests", label: "shell.link.requests", icon: Inbox },
      { to: "/people/exits", label: "shell.link.exits", icon: UserMinus },
      { to: "/people/period-locks", label: "shell.link.periodLocks", icon: Lock },
    ],
  },
  { hub: "shell.hub.admin", links: [{to:"/audit/support-access",label:"supportAccess.title",icon:Lock, supportApproval: true},{ to: "/access", label: "shell.link.access", icon: KeyRound }] },
] as const;
export const PLATFORM_NAV = [{ hub: "shell.hub.platform", links: [{ to: "/platform", label: "shell.link.tenants", icon: Building }] }] as const;

/** Navigation and the shell use the same server-checked entries and destination requirement. */
export function tenantNav(access: AccessEffective | undefined, routes: Readonly<Record<string, { options: { staticData?: StaticDataRouteOption } }>>, supportApproval = false) {
  // Only the first hub is stable before both decisions settle; later links must never be pushed down.
  if (!access) return NAV.slice(0, 1);
  const shown = (link: (typeof NAV)[number]["links"][number]) => {
    if ("supportApproval" in link) return supportApproval;
    const need = routes[link.to]?.options.staticData?.access;
    return need === "signed-in" || !!need && !!access && accessRefusal(access, need) === null;
  };
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
