// SPDX-License-Identifier: LicenseRef-Proprietary
import { Building, Building2, Clock, FileText, Home, KeyRound, ListChecks, ScrollText, Settings, Users, type LucideIcon } from "lucide-react";
import type { StaticDataRouteOption } from "@tanstack/react-router";
import type { MessageId } from "@console/i18n";
import type { AllPaths } from "@console/api/pending";
import type { AccessEffective } from "../reference/authz/api";
import { accessRefusal } from "../reference/authz/domain/access";
import { SETTINGS_VIEWS } from "./settings-views";

type Modules = AllPaths["/api/v1/onboarding/modules"]["get"]["responses"][200]["content"]["application/json"];
type NavLink = { to: string; label: MessageId; icon: LucideIcon; module?: Modules[number]["key"]; supportApproval?: boolean; views?: readonly { to: string }[] };
export type NavHub = { hub: MessageId; links: readonly NavLink[] };
type Routes = Readonly<Record<string, { options: { staticData?: StaticDataRouteOption } }>>;
type NavContext = { pathname: string; phase?: string; setupTargets?: readonly string[]; modules?: Modules };

const REQUESTS: NavLink = { to: "/people/requests", label: "shell.link.requests", icon: ListChecks };
// One entry table; future destinations appear only when their route is served.
export const TENANT_NAV: readonly NavHub[] = [
  { hub: "shell.hub.work", links: [
    { to: "/", label: "shell.link.home", icon: Home },
    // Keep own requests reachable until the inbox page includes the requester's tab.
    REQUESTS,
  ] },
  { hub: "shell.hub.people", links: [
    { to: "/org", label: "shell.link.org", icon: Building2, module: "org" },
    { to: "/people", label: "shell.link.people", icon: Users, module: "people" },
    { to: "/attendance", label: "shell.link.attendance", icon: Clock, module: "attendance" },
    { to: "/payroll", label: "shell.link.payroll", icon: FileText, module: "payroll" },
    { to: "/statutory", label: "shell.link.statutory", icon: ScrollText, module: "statutory" },
  ] },
  { hub: "shell.hub.admin", links: [
    { to: "/access", label: "shell.link.access", icon: KeyRound, module: "access" },
    { to: "/audit/support-access", label: "shell.link.audit", icon: FileText, supportApproval: true },
    { to: "/settings", label: "shell.link.settings", icon: Settings, views: SETTINGS_VIEWS },
  ] },
];
export const PLATFORM_NAV: readonly NavHub[] = [{ hub: "shell.hub.platform", links: [{ to: "/platform", label: "shell.link.tenants", icon: Building }] }];

/** Served destinations use their own requirement; readiness remains a server fact. */
export function tenantNav(access: AccessEffective | undefined, routes: Routes, supportApproval = false,
  { phase, setupTargets, modules }: NavContext = { pathname: "/" }) {
  const shown = (link: NavLink) => {
    if (!routes[link.to]) return false;
    if (link.to === "/") return true;
    if (!access) return false;
    if (link.module === "payroll" && !modules?.some(m => m.key === "payroll" && m.ready)) return false;
    if (modules && link.module && !modules.some(m => m.key === link.module && m.ready)) return false;
    if (phase === "SETUP") {
      // Keep S1's safe destinations if the checklist is unavailable; readiness can narrow them further.
      const targets = setupTargets ?? ["/org", "/people", "/access"];
      if (!targets.some(to => to === link.to || to.startsWith(link.to + "/"))) return false;
    }
    if (link.supportApproval) return supportApproval;
    const need = routes[link.to]?.options.staticData?.access;
    return need === "signed-in" || !!need && accessRefusal(access, need) === null;
  };
  return TENANT_NAV.map(g => ({ ...g, links: g.links.filter(shown) })).filter(g => g.links.length);
}

type RailAnswer = { access: AccessEffective; supportApproval: boolean; context: NavContext };

/** Only presentation is remembered: RouteGuard always reads the current server decision. */
export function rememberedRail(key: string | null): RailAnswer | undefined {
  try {
    const data: RailAnswer | null = JSON.parse(key ? localStorage.getItem(key) ?? "null" : "null");
    return data && typeof data.access?.is_ops === "boolean" && Array.isArray(data.access.entries) &&
      data.access.entries.every(e => e && typeof e.domain === "string" && typeof e.level === "string" && typeof e.scope?.kind === "string") &&
      typeof data.supportApproval === "boolean" && data.context && typeof data.context.pathname === "string" &&
      (data.context.setupTargets === undefined || Array.isArray(data.context.setupTargets) && data.context.setupTargets.every(to => typeof to === "string")) &&
      (data.context.modules === undefined || Array.isArray(data.context.modules) && data.context.modules.every(m => m && typeof m.key === "string" && typeof m.ready === "boolean")) ? data : undefined;
  } catch { return undefined; }
}

/**
 * The one link to light up for `pathname`: the deepest link the path sits under.
 * Views use their entry's destination even while their URLs remain under another module.
 */
export function activeLink(pathname: string, links: readonly Pick<NavLink, "to" | "views">[]): string | undefined {
  const owner = links.find(link => link.views?.some(view => pathname === view.to || pathname.startsWith(view.to + "/")));
  if (owner) return owner.to;
  const under = links.filter((l) => l.to !== "/" && (pathname === l.to || pathname.startsWith(l.to + "/")));
  return under.sort((a, b) => b.to.length - a.to.length)[0]?.to;
}
