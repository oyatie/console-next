// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, expect, test } from "vitest";
import { i18n, loadCatalog, t } from "@console/i18n";
import { fmtMonth } from "@console/i18n/format";
import { Home, Users } from "lucide-react";
import { get, read } from "../../lib/query";
import { saeonUniverse } from "../../../../../e2e/mock/saeon";
import type { NavLink } from "../nav";
import { canonicalTabTarget, resolveRouteTabMeta, useResolvedTabTitle } from "./tab-titles";

const SAMPLE_LINKS: readonly NavLink[] = [
  { to: "/", label: "shell.link.home", icon: Home },
  { to: "/people", label: "shell.link.people", icon: Users },
];

beforeAll(async () => {
  await loadCatalog("ko");
  await loadCatalog("en");
});

test("canonicalTabTarget normalizes paths and preserves only view-distinguishing query params", () => {
  expect(canonicalTabTarget("/people/")).toBe("/people");
  expect(canonicalTabTarget("/people//exits/")).toBe("/people/exits");
  expect(canonicalTabTarget("/people", "?sel=emp-1&sort=name&full=1")).toBe("/people");
  expect(canonicalTabTarget("/people", "?view=accounts&sel=acc-1")).toBe("/people?view=accounts");
  expect(canonicalTabTarget("/people", "?placement=unplaced&sort=name")).toBe("/people?placement=unplaced");
  expect(canonicalTabTarget("/people", "?tab=exits&q=park")).toBe("/people?tab=exits");
  expect(canonicalTabTarget("/org", "?tab=entities&sel=ent-1")).toBe("/org?tab=entities");
  expect(canonicalTabTarget("/org", "?tab=changes&filter=history&focus=u1")).toBe("/org?tab=changes&filter=history");
  expect(canonicalTabTarget("/org", "?sel=u1&focus=u1")).toBe("/org");
  expect(canonicalTabTarget("/attendance", "?tab=day&date=2026-11-10")).toBe("/attendance?tab=day");
  expect(canonicalTabTarget("/attendance", "?tab=month&month=2026-11")).toBe("/attendance");
  expect(canonicalTabTarget("/statutory", "?tab=register&site=wp-1")).toBe("/statutory?tab=register");
  expect(canonicalTabTarget("/people/10587", "?tab=events&act=promote")).toBe("/people/10587");
});

test("resolveRouteTabMeta returns distinct sub-route titles in Korean and English", () => {
  for (const locale of ["ko", "en"] as const) {
    i18n.set(locale);
    const cases: Array<[string, string | undefined, string]> = [
      ["/", undefined, t("shell.link.home")],
      ["/inbox", undefined, t("shellRoutes.inbox")],
      ["/people", undefined, t("shellRoutes.peopleRoster")],
      ["/people", "?view=accounts", t("shellRoutes.peopleAccounts")],
      ["/people", "?placement=unplaced", t("shellRoutes.peopleUnplaced")],
      ["/people/exits", undefined, t("shellRoutes.peopleExits")],
      ["/people/certificates", undefined, t("shellRoutes.peopleCertificates")],
      ["/people/grid", undefined, t("shellRoutes.peopleGrid")],
      ["/people/new", undefined, t("shellRoutes.peopleNew")],
      ["/people/data-health", undefined, t("shellRoutes.peopleDataHealth")],
      ["/org", undefined, t("shellRoutes.orgChart")],
      ["/org", "?tab=entities", t("shellRoutes.orgEntities")],
      ["/org", "?tab=changes", t("shellRoutes.orgChanges")],
      ["/org", "?tab=changes&filter=history", t("shellRoutes.orgHistory")],
      ["/attendance", undefined, t("shellRoutes.attendanceMonth")],
      ["/attendance", "?tab=close", t("shellRoutes.attendanceClose")],
      ["/payroll/runs/new", undefined, t("shellRoutes.payrollRunNew")],
      ["/access/roles", undefined, t("shellRoutes.accessRoles")],
      ["/access/grants/bulk", undefined, t("shellRoutes.accessGrantsBulk")],
      ["/audit/access-log", undefined, t("shellRoutes.auditAccessLog")],
      ["/requests/req-1", undefined, t("shellRoutes.requestDetail")],
      ["/setup/go-live", undefined, t("shellRoutes.setupGoLive")],
      ["/account/privacy", undefined, t("shellRoutes.privacy")],
    ];
    for (const [pathname, searchStr, expected] of cases) {
      const meta = resolveRouteTabMeta({ pathname, searchStr, allLinks: SAMPLE_LINKS, platform: false });
      expect(meta.title, `${locale}:${pathname}${searchStr ?? ""}`).toBe(expected);
      expect(meta.isFallback).toBe(false);
    }
  }
  i18n.set("ko");
});

function Probe({ pathname, searchStr = "" }: { pathname: string; searchStr?: string }) {
  const resolved = useResolvedTabTitle({ pathname, searchStr, allLinks: SAMPLE_LINKS, platform: false });
  return <output data-fallback={String(resolved.isFallback)}>{resolved.title}</output>;
}

test("useResolvedTabTitle enriches record routes from passive QueryClient cache without fetching", async () => {
  i18n.set("ko");
  const qc = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  const heroName = saeonUniverse.hero.name;
  const heroNo = saeonUniverse.hero.employeeNumber;
  const peerName = saeonUniverse.rosterWindow[1]!.name;
  const entityName = saeonUniverse.entities[0]!.name;
  const adminName = saeonUniverse.adminActor.name;
  const orgChangeTitle = t("shellRoutes.orgChanges");
  const noticeTitle = "AN-2026-009 Appointment Notice";
  const roleKo = "HR Admin Role";
  try {
    const fallbackHtml = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <Probe pathname="/people/emp-1" />
      </QueryClientProvider>,
    );
    expect(fallbackHtml).toContain(`data-fallback="true">${t("shellRoutes.peopleCard")}</output>`);

    await qc.fetchQuery({
      ...get("/api/v1/employees/{id}", { params: { path: { id: "emp-1" } } }),
      queryFn: async () => ({ employee: { id: "emp-1", name: heroName, employee_number: heroNo } }) as never,
    });
    await qc.fetchQuery({
      ...get("/api/v1/hr/exit-cases/{id}", { params: { path: { id: "exit-1" } } }),
      queryFn: async () => ({ id: "exit-1", employee_name: peerName }) as never,
    });
    await qc.fetchQuery({
      ...get("/api/v1/org-changes/{id}", { params: { path: { id: "chg-1" } } }),
      queryFn: async () => ({ id: "chg-1", code: "OC-2026-0418" }) as never,
    });
    await qc.fetchQuery(
      read("/api/v1/approvals/{id}", async () => ({ id: "ap-1", document_no: "OC-2026-0418", title: orgChangeTitle }), { id: "ap-1" }),
    );
    await qc.fetchQuery({
      ...get("/api/v1/payroll/runs/{id}", { params: { path: { id: "run-1" } } }),
      queryFn: async () => ({ run: { id: "run-1", attribution_month: "2026-10" } }) as never,
    });
    await qc.fetchQuery({
      ...get("/api/v1/legal-entities/{entityId}", { params: { path: { entityId: "ent-1" } } }),
      queryFn: async () => ({ current: { display_name: entityName, name: entityName } }) as never,
    });
    await qc.fetchQuery({
      ...get("/api/v1/hr/certificates/{id}", { params: { path: { id: "cert-1" } } }),
      queryFn: async () => ({ certificate_no: "HR-2026-0119", snapshot: { name: heroName } }) as never,
    });
    await qc.fetchQuery({
      ...get("/api/v1/appointment-notices/{id}", { params: { path: { id: "not-1" } } }),
      queryFn: async () => ({ notice_no: "AN-2026-009", title: noticeTitle }) as never,
    });
    await qc.fetchQuery({
      ...get("/api/v1/access/roles/{roleId}/versions", { params: { path: { roleId: "role-1" } } }),
      queryFn: async () => [{ version: 2, name_ko: roleKo, name_en: "HR Admin" }] as never,
    });
    await qc.fetchQuery({
      ...get("/api/v1/access/people/{id}", { params: { path: { id: "acc-1" } } }),
      queryFn: async () => ({ employee_name: adminName, display_name: adminName }) as never,
    });

    const expectations: Array<[string, string]> = [
      ["/people/emp-1", t("shellRoutes.pair", { primary: heroName, secondary: heroNo })],
      ["/people/emp-1/identifiers", t("shellRoutes.identifiers", { name: heroName })],
      ["/payroll/employees/emp-1", t("shellRoutes.employeePay", { name: heroName })],
      ["/people/exits/exit-1", t("shellRoutes.exitCase", { name: peerName })],
      ["/org/changes/chg-1", t("shellRoutes.orgChange", { code: "OC-2026-0418" })],
      ["/approvals/ap-1", `OC-2026-0418 ${orgChangeTitle}`],
      ["/payroll/runs/run-1", t("shellRoutes.payrollRunMonth", { month: fmtMonth("2026-10") })],
      ["/org/entities/ent-1", entityName],
      ["/people/certificates/cert-1", t("shellRoutes.pair", { primary: "HR-2026-0119", secondary: heroName })],
      ["/people/notices/not-1", noticeTitle],
      ["/access/roles/role-1", roleKo],
      ["/access/people/acc-1", adminName],
    ];

    for (const [pathname, expectedTitle] of expectations) {
      const html = renderToStaticMarkup(
        <QueryClientProvider client={qc}>
          <Probe pathname={pathname} />
        </QueryClientProvider>,
      );
      expect(html, pathname).toContain(`data-fallback="false">${expectedTitle}</output>`);
    }
  } finally {
    qc.clear();
  }
});
