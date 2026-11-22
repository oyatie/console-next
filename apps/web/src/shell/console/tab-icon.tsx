// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { Banknote, CalendarDays, FileText, ListChecks, Settings } from "lucide-react";
import { activeLink, type NavLink } from "../nav";
import { normalizeAppPath } from "./tab-href";

export function tabIconForHref(href: string, allLinks: readonly NavLink[]): ReactNode {
  const cut = href.search(/[?#]/);
  const path = normalizeAppPath((cut === -1 ? href : href.slice(0, cut)) || "/");
  if (path === "/leave") return <CalendarDays size={14} aria-hidden="true" />;
  if (path === "/payslips") return <Banknote size={14} aria-hidden="true" />;
  if (path === "/account" || path.startsWith("/account/")) return <Settings size={14} aria-hidden="true" />;
  if (path === "/requests" || path.startsWith("/requests/")) return <ListChecks size={14} aria-hidden="true" />;
  if (path === "/audit" || path.startsWith("/audit/")) return <FileText size={14} aria-hidden="true" />;
  if (path === "/setup" || path.startsWith("/setup/")) return <Settings size={14} aria-hidden="true" />;
  const matchedHref = path === "/" || path === "/inbox" ? "/" : activeLink(path, allLinks);
  const Icon =
    (matchedHref ? allLinks.find(link => link.to === matchedHref)?.icon : undefined) ??
    allLinks[0]?.icon;
  return Icon ? <Icon size={14} aria-hidden="true" /> : null;
}
