// SPDX-License-Identifier: LicenseRef-Proprietary
import { useMemo, useSyncExternalStore } from "react";
import { i18n, t, type MessageId } from "@console/i18n";
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

const STATIC_ROUTES: Readonly<Record<string, MessageId>> = {
  "/inbox": "shellRoutes.inbox",
  "/leave": "leave.title",
  "/payslips": "shell.title.payslip",
  "/me/attendance": "shell.link.meAttendance",
  "/evaluation": "evaluation.title",
  "/evaluation/new": "evaluation.create",
  "/me/evaluations": "me.evaluation.title",
  "/me/desk": "shell.link.meDesk",
  "/me/dispatch-offers": "shellRoutes.dispatchOffers",
  "/team": "shell.link.team",
  "/account": "shell.profile",
  "/account/location": "shellRoutes.locationConsent",
  "/account/privacy": "shellRoutes.privacy",
  "/requests": "shellRoutes.requests",
  "/approvals": "shell.link.approvals",
  "/approvals/new": "shellRoutes.approvalNew",
  "/org/changes": "shellRoutes.orgChanges",
  "/org/history": "shellRoutes.orgHistory",
  "/org/entities": "shellRoutes.orgEntities",
  "/org/move": "shellRoutes.orgMove",
  "/org/paste": "shellRoutes.orgPaste",
  "/org/import": "shellRoutes.orgImport",
  "/org/workplaces/edit": "shellRoutes.orgWorkplacesEdit",
  "/org/entities/new": "shellRoutes.entityNew",
  "/org/entities/bulk": "shellRoutes.entityBulk",
  "/setup/go-live": "shellRoutes.setupGoLive",
  "/people/new": "shellRoutes.peopleNew",
  "/people/import": "shellRoutes.peopleImport",
  "/people/unplaced": "shellRoutes.peopleUnplaced",
  "/people/data-health": "shellRoutes.peopleDataHealth",
  "/people/grid": "shellRoutes.peopleGrid",
  "/people/bulk": "shellRoutes.peopleBulk",
  "/people/run": "shellRoutes.peopleRun",
  "/people/renew": "shellRoutes.peopleRenew",
  "/people/notices": "shellRoutes.peopleNotices",
  "/people/notices/new": "shellRoutes.peopleNoticeNew",
  "/people/certificates": "shellRoutes.peopleCertificates",
  "/people/exits": "shellRoutes.peopleExits",
  "/people/period-locks": "shellRoutes.peoplePeriodLocks",
  "/people/roster-fields": "shellRoutes.peopleRosterFields",
  "/people/job-titles": "shellRoutes.peopleJobTitles",
  "/people/numbering": "shellRoutes.peopleNumbering",
  "/people/requests": "shell.link.requests",
  "/payroll": "shell.link.payroll",
  "/payroll/runs/new": "shellRoutes.payrollRunNew",
  "/payroll/setup": "shellRoutes.payrollSetup",
  "/payroll/outlook": "payrollOutlook.title",
  "/payroll/reference": "shellRoutes.payrollReference",
  "/access": "shellRoutes.accessRoles",
  "/access/roles": "shellRoutes.accessRoles",
  "/access/roles/new": "shellRoutes.accessRoleNew",
  "/access/grants": "shellRoutes.accessGrants",
  "/access/grants/bulk": "shellRoutes.accessGrantsBulk",
  "/access/ready": "shellRoutes.accessReady",
  "/access/review": "accessReview.title",
  "/audit/restricted": "audit.restricted.title",
  "/audit/location-consents": "audit.consents.title",
  "/calendar": "internalCalendar.title",
  "/benefits": "benefits.title",
  "/audit/findings": "audit.findings.title",
  "/audit/evidence": "audit.vault.title",
  "/audit": "shellRoutes.auditLog",
  "/audit/support-access": "shellRoutes.auditSupport",
  "/audit/access-log": "shellRoutes.auditAccessLog",
  "/settings": "shell.link.settings",
  "/settings/company-domain": "shellRoutes.companyDomain",
  "/platform": "shell.link.tenants",
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
  if (/^\/audit\/lifecycles\/[^/]+\/[^/]+$/.test(path)) return { title: t("audit.lifecycle.title"), isFallback: false, recordSpec: null };
  if (path === "/") {
    return { title: platform ? t("shell.link.tenants") : t("shell.link.todo"), isFallback: false, recordSpec: null };
  }
  const viewTitle = resolveQueryViewTitle(path, searchStr);
  if (viewTitle) return typeof viewTitle === "string" ? { title: viewTitle, isFallback: false, recordSpec: null } : viewTitle;
  const exact = STATIC_ROUTES[path];
  if (exact) return { title: t(exact), isFallback: false, recordSpec: null };
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
