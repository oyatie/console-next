// SPDX-License-Identifier: LicenseRef-Proprietary
import {
  Activity,
  Bell,
  BookOpen,
  CheckSquare,
  Database,
  Flame,
  GitBranch,
  HardDrive,
  HeartPulse,
  Home,
  PhoneCall,
  Rocket,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { COPY } from "../copy";
import type { OpsMe } from "../lib/api";
import { hasOpsAction, type OpsAction } from "../lib/auth";

export type OpsNavItem = {
  id: "now" | "alerts" | "incidents" | "running" | "obligations" | "recovery" | "sources";
  to: "/" | "/alerts" | "/incidents" | "/running" | "/obligations" | "/recovery" | "/sources";
  label: string;
  action: OpsAction;
  icon: LucideIcon;
};

export type OpsQuickLink = {
  id: string;
  to: string;
  label: string;
  action: OpsAction;
  icon: LucideIcon;
};

export const OPS_NAV_ITEMS: readonly OpsNavItem[] = [
  { id: "now", to: "/", label: COPY.nav.now, action: "read.home", icon: Home },
  { id: "alerts", to: "/alerts", label: COPY.nav.alerts, action: "read.alerts", icon: Bell },
  { id: "incidents", to: "/incidents", label: COPY.nav.incidents, action: "read.home", icon: Flame },
  { id: "running", to: "/running", label: COPY.nav.running, action: "read.running", icon: Activity },
  { id: "obligations", to: "/obligations", label: COPY.nav.obligations, action: "obligation.read", icon: CheckSquare },
  { id: "recovery", to: "/recovery", label: COPY.nav.recovery, action: "recovery.read", icon: HardDrive },
  { id: "sources", to: "/sources", label: COPY.nav.sources, action: "read.sources", icon: Database },
];

export const OPS_SUB_LINKS: readonly OpsQuickLink[] = [
  { id: "health", to: "/health", label: COPY.health.tabTitle, action: "read.home", icon: HeartPulse },
  { id: "oncall", to: "/oncall", label: COPY.alerts.oncallTab, action: "read.alerts", icon: PhoneCall },
  { id: "silences", to: "/alerts/silences", label: COPY.alerts.silencesTab, action: "read.alerts", icon: Bell },
  { id: "jobs", to: "/running/jobs", label: COPY.running.jobsTab, action: "read.running", icon: Activity },
  { id: "changes", to: "/changes", label: COPY.running.changesTab, action: "read.running", icon: GitBranch },
  { id: "promote", to: "/promote", label: COPY.running.promoteTab, action: "read.running", icon: Rocket },
  { id: "actions", to: "/actions", label: COPY.running.actionsTab, action: "read.running", icon: Terminal },
  { id: "runbooks", to: "/runbooks", label: COPY.running.runbooksTab, action: "read.running", icon: BookOpen },
];

export function filterOpsNav(me: OpsMe | undefined): readonly OpsNavItem[] {
  return OPS_NAV_ITEMS.filter((item) => hasOpsAction(me, item.action));
}

export function filterOpsSubLinks(me: OpsMe | undefined): readonly OpsQuickLink[] {
  return OPS_SUB_LINKS.filter((item) => hasOpsAction(me, item.action));
}

export function isNavActive(pathname: string, to: OpsNavItem["to"]): boolean {
  if (to === "/") return pathname === "/" || pathname === "/health";
  if (to === "/alerts") return pathname === "/alerts" || pathname.startsWith("/alerts/") || pathname === "/oncall";
  if (to === "/running") {
    return (
      pathname === "/running" ||
      pathname.startsWith("/running/") ||
      pathname === "/changes" ||
      pathname === "/promote" ||
      pathname === "/actions" ||
      pathname === "/runbooks"
    );
  }
  return pathname === to || pathname.startsWith(`${to}/`);
}

export function resolveActiveSurfaceTitle(pathname: string, navItems: readonly OpsNavItem[]): string {
  if (pathname === "/health") return COPY.health.title;
  if (pathname === "/oncall") return COPY.oncall.title;
  if (pathname === "/changes") return COPY.changes.title;
  if (pathname === "/promote") return COPY.promote.title;
  if (pathname === "/actions") return COPY.actions.title;
  if (pathname === "/runbooks") return COPY.runbooks.title;
  if (pathname === "/running/jobs") return COPY.running.jobsTab;
  if (pathname === "/alerts/silences" || pathname === "/alerts/silence") return COPY.alerts.silencesTab;
  const active = navItems.find((item) => isNavActive(pathname, item.to));
  return active?.label ?? COPY.now.title;
}
