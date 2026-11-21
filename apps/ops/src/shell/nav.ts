// SPDX-License-Identifier: LicenseRef-Proprietary
import { Activity, Bell, Database, Home, type LucideIcon } from "lucide-react";
import { COPY } from "../copy";
import type { OpsMe } from "../lib/api";
import { hasOpsAction, type OpsAction } from "../lib/auth";

export type OpsNavItem = {
  id: "now" | "alerts" | "running" | "sources";
  to: "/" | "/alerts" | "/running" | "/sources";
  label: string;
  action: OpsAction;
  icon: LucideIcon;
};

export const OPS_NAV_ITEMS: readonly OpsNavItem[] = [
  { id: "now", to: "/", label: COPY.nav.now, action: "read.home", icon: Home },
  { id: "alerts", to: "/alerts", label: COPY.nav.alerts, action: "read.alerts", icon: Bell },
  { id: "running", to: "/running", label: COPY.nav.running, action: "read.running", icon: Activity },
  { id: "sources", to: "/sources", label: COPY.nav.sources, action: "read.sources", icon: Database },
];

export function filterOpsNav(me: OpsMe | undefined): readonly OpsNavItem[] {
  return OPS_NAV_ITEMS.filter((item) => hasOpsAction(me, item.action));
}

export function isNavActive(pathname: string, to: OpsNavItem["to"]): boolean {
  if (to === "/") return pathname === "/";
  return pathname === to || pathname.startsWith(`${to}/`);
}
