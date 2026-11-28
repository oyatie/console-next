// SPDX-License-Identifier: LicenseRef-Proprietary
import { useMemo, useSyncExternalStore } from "react";
import { i18n, t } from "@console/i18n";
import { todayKst } from "../../lib/pure/today";
import { useCachedRecordData } from "../../lib/react/cached-record";
import { activeLink, type NavLink } from "../nav";
import { canonicalViewTarget, normalizeAppPath } from "./tab-href";
import { formatRecordTitle, monthOnly, resolveDynamicRouteMeta, type RouteTabMeta } from "./tab-record-format";

/** Canonicalizes `pathname` + `searchStr`, keeping only view-distinguishing query params on multi-view routes. */
export function canonicalTabTarget(pathname: string, searchStr = ""): string {
  const path = normalizeAppPath(pathname);
  if (!searchStr) return path;
  const qs = searchStr.startsWith("?") ? searchStr : `?${searchStr}`;
  return canonicalViewTarget(`${path}${qs}`);
}

const STATIC_ROUTES: Readonly<Record<string, () => string>> = {
  "/inbox": () => t("shellRoutes.inbox"),
  "/leave": () => t("leave.title"),
  "/payslips": () => t("shell.title.payslip"),
  "/me/attendance": () => t("shell.link.meAttendance"),
  "/me/desk": () => t("shell.link.meDesk"),
  "/me/dispatch-offers": () => t("shellRoutes.dispatchOffers"),
  "/team": () => t("shell.link.team"),
  "/account": () => t("shell.profile"),
  "/account/location": () => t("shellRoutes.locationConsent"),
  "/account/privacy": () => t("shellRoutes.privacy"),
  "/requests": () => t("shellRoutes.requests"),
  "/approvals": () => t("shell.link.approvals"),
  "/approvals/new": () => t("shellRoutes.approvalNew"),
  "/org/changes": () => t("shellRoutes.orgChanges"),
  "/org/history": () => t("shellRoutes.orgHistory"),
  "/org/entities": () => t("shellRoutes.orgEntities"),
  "/org/move": () => t("shellRoutes.orgMove"),
  "/org/paste": () => t("shellRoutes.orgPaste"),
  "/org/import": () => t("shellRoutes.orgImport"),
  "/org/workplaces/edit": () => t("shellRoutes.orgWorkplacesEdit"),
  "/org/entities/new": () => t("shellRoutes.entityNew"),
  "/org/entities/bulk": () => t("shellRoutes.entityBulk"),
  "/setup/go-live": () => t("shellRoutes.setupGoLive"),
  "/people/new": () => t("shellRoutes.peopleNew"),
  "/people/import": () => t("shellRoutes.peopleImport"),
  "/people/unplaced": () => t("shellRoutes.peopleUnplaced"),
  "/people/data-health": () => t("shellRoutes.peopleDataHealth"),
  "/people/grid": () => t("shellRoutes.peopleGrid"),
  "/people/bulk": () => t("shellRoutes.peopleBulk"),
  "/people/run": () => t("shellRoutes.peopleRun"),
  "/people/renew": () => t("shellRoutes.peopleRenew"),
  "/people/notices": () => t("shellRoutes.peopleNotices"),
  "/people/notices/new": () => t("shellRoutes.peopleNoticeNew"),
  "/people/certificates": () => t("shellRoutes.peopleCertificates"),
  "/people/exits": () => t("shellRoutes.peopleExits"),
  "/people/period-locks": () => t("shellRoutes.peoplePeriodLocks"),
  "/people/roster-fields": () => t("shellRoutes.peopleRosterFields"),
  "/people/job-titles": () => t("shellRoutes.peopleJobTitles"),
  "/people/numbering": () => t("shellRoutes.peopleNumbering"),
  "/people/requests": () => t("shell.link.requests"),
  "/payroll": () => t("shell.link.payroll"),
  "/payroll/runs/new": () => t("shellRoutes.payrollRunNew"),
  "/payroll/setup": () => t("shellRoutes.payrollSetup"),
  "/payroll/reference": () => t("shellRoutes.payrollReference"),
  "/access": () => t("shellRoutes.accessRoles"),
  "/access/roles": () => t("shellRoutes.accessRoles"),
  "/access/roles/new": () => t("shellRoutes.accessRoleNew"),
  "/access/grants": () => t("shellRoutes.accessGrants"),
  "/access/grants/bulk": () => t("shellRoutes.accessGrantsBulk"),
  "/access/ready": () => t("shellRoutes.accessReady"),
  "/access/review": () => t("accessReview.title"),
  "/audit/evidence": () => t("audit.vault.title"),
  "/audit": () => t("shellRoutes.auditLog"),
  "/audit/support-access": () => t("shellRoutes.auditSupport"),
  "/audit/access-log": () => t("shellRoutes.auditAccessLog"),
  "/settings": () => t("shell.link.settings"),
  "/settings/company-domain": () => t("shellRoutes.companyDomain"),
  "/platform": () => t("shell.link.tenants"),
};

/** The attendance month tab names its month (the current one without ?month, as the screen shows), and its cached scope. */
function attendanceMonthMeta(params: URLSearchParams): RouteTabMeta {
  const month = monthOnly(params.get("month") ?? todayKst().slice(0, 7));
  const node = params.get("unit") ?? params.get("wp");
  return {
    title: month ? t("shellRoutes.attendanceMonthOf", { month }) : t("shellRoutes.attendanceMonth"),
    isFallback: false,
    recordSpec: node ? { kind: "attendanceScope", path: "/api/v1/attendance/schedule/tree", match: () => true, node } : null,
  };
}

function resolveQueryViewTitle(path: string, searchStr: string): string | RouteTabMeta | null {
  const params = new URLSearchParams(searchStr.startsWith("?") ? searchStr.slice(1) : searchStr);
  if (path === "/org") {
    const tab = params.get("tab");
    if (tab === "entities") return t("shellRoutes.orgEntities");
    if (tab === "changes") {
      return params.get("filter") === "history" ? t("shellRoutes.orgHistory") : t("shellRoutes.orgChanges");
    }
    return t("shellRoutes.orgChart");
  }
  if (path === "/people") {
    if (params.get("view") === "accounts") return t("shellRoutes.peopleAccounts");
    if (params.get("placement") === "unplaced") return t("shellRoutes.peopleUnplaced");
    const tab = params.get("tab");
    if (tab === "exits") return t("shellRoutes.peopleExits");
    if (tab === "appointments") return t("shellRoutes.peopleBulk");
    return t("shellRoutes.peopleRoster");
  }
  if (path === "/attendance") {
    const tab = params.get("tab");
    if (tab === "day") return t("shellRoutes.attendanceDay");
    if (tab === "schedule") return t("shellRoutes.attendanceSchedule");
    if (tab === "overtime" || tab === "week") return t("shellRoutes.attendanceOvertime");
    if (tab === "issues") return t("shellRoutes.attendanceIssues");
    if (tab === "close") return t("shellRoutes.attendanceClose");
    if (tab === "import") return t("shellRoutes.attendanceImport");
    return attendanceMonthMeta(params);
  }
  if (path === "/statutory") {
    return t("shell.link.statutory");
  }
  return null;
}

export function resolveRouteTabMeta({
  pathname,
  searchStr = "",
  allLinks,
  platform,
  locale: _locale,
}: {
  pathname: string;
  searchStr?: string;
  allLinks: readonly NavLink[];
  platform: boolean;
  locale?: string;
}): RouteTabMeta {
  const path = normalizeAppPath(pathname);
  if (path === "/") {
    return { title: platform ? t("shell.link.tenants") : t("shell.link.todo"), isFallback: false, recordSpec: null };
  }
  const viewTitle = resolveQueryViewTitle(path, searchStr);
  if (viewTitle) return typeof viewTitle === "string" ? { title: viewTitle, isFallback: false, recordSpec: null } : viewTitle;
  const exact = STATIC_ROUTES[path];
  if (exact) return { title: exact(), isFallback: false, recordSpec: null };
  const dynamic = resolveDynamicRouteMeta(path);
  if (dynamic) return dynamic;
  const matchedTo = activeLink(path, allLinks);
  const matched = matchedTo ? allLinks.find(link => link.to === matchedTo) : undefined;
  if (matched) return { title: t(matched.label), isFallback: false, recordSpec: null };
  return { title: platform ? t("shell.link.tenants") : t("shell.link.home"), isFallback: false, recordSpec: null };
}

export function useResolvedTabTitle({
  pathname,
  searchStr = "",
  allLinks,
  platform,
}: {
  pathname: string;
  searchStr?: string;
  allLinks: readonly NavLink[];
  platform: boolean;
}): { title: string; isFallback: boolean; tabTarget: string } {
  const locale = useSyncExternalStore(i18n.subscribe, () => i18n.locale, () => i18n.locale);
  const tabTarget = useMemo(() => canonicalTabTarget(pathname, searchStr), [pathname, searchStr]);
  const meta = useMemo(
    () => resolveRouteTabMeta({ pathname, searchStr, allLinks, platform, locale }),
    [pathname, searchStr, allLinks, platform, locale],
  );
  const cached = useCachedRecordData<unknown>(meta.recordSpec);
  const named = meta.recordSpec && cached !== undefined ? formatRecordTitle(meta.recordSpec, cached, locale) : null;
  const recordTitle = named && meta.recordSpec?.node ? t("shellRoutes.pair", { primary: meta.title, secondary: named }) : named;
  return {
    title: recordTitle ?? meta.title,
    isFallback: recordTitle ? false : meta.isFallback,
    tabTarget,
  };
}
