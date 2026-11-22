// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { Banknote, Briefcase, CalendarDays, Clock, Settings } from "lucide-react";
import { t } from "@console/i18n";
import { activeLink, type NavLink } from "../nav";

const PHONE_QUERY = "(max-width: 767px)";

export function subscribePhoneQuery(onStoreChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mql = window.matchMedia(PHONE_QUERY);
  mql.addEventListener("change", onStoreChange);
  return () => mql.removeEventListener("change", onStoreChange);
}

export function getPhoneSnapshot() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(PHONE_QUERY).matches;
}

export function tabIconForHref(href: string, allLinks: readonly NavLink[]): ReactNode {
  const cut = href.search(/[?#]/);
  const path = (cut === -1 ? href : href.slice(0, cut)) || "/";
  if (path === "/leave") return <CalendarDays size={14} aria-hidden="true" />;
  if (path === "/payslips") return <Banknote size={14} aria-hidden="true" />;
  if (path === "/me/attendance") return <Clock size={14} aria-hidden="true" />;
  if (path === "/me/desk") return <Briefcase size={14} aria-hidden="true" />;
  if (path === "/account" || path.startsWith("/account/")) return <Settings size={14} aria-hidden="true" />;
  const matchedHref = path === "/" || path === "/inbox" ? "/" : activeLink(path, allLinks);
  const Icon =
    (matchedHref ? allLinks.find(link => link.to === matchedHref)?.icon : undefined) ??
    allLinks[0]?.icon;
  return Icon ? <Icon size={14} aria-hidden="true" /> : null;
}

export function consolePathTitle(
  pathname: string,
  allLinks: readonly NavLink[],
  currentModuleTo: string | undefined,
  platform: boolean,
): string {
  if (pathname === "/leave") return t("leave.title");
  if (pathname === "/payslips") return t("shell.title.payslip");
  if (pathname === "/me/attendance") return t("shell.link.meAttendance");
  if (pathname === "/me/desk") return t("shell.link.meDesk");
  if (pathname === "/account" || pathname.startsWith("/account/")) return t("shell.profile");
  if (pathname === "/payroll/setup") return t("payroll.setup.page");
  if (pathname === "/payroll/runs/new") return t("payroll.create.title");
  if (pathname === "/payroll/reference") return t("payroll.reference.title");
  if (pathname.startsWith("/payroll/employees/")) return t("payroll.employee.title");
  const matched = allLinks.find(link => link.to === currentModuleTo);
  if (matched) return t(matched.label);
  return platform ? t("shell.link.tenants") : t("shell.link.home");
}
