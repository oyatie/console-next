// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import type { components } from "@console/api";
import { routeReads } from "../../apps/web/src/routes/route-reads";
import { settingsQuery } from "../../apps/web/src/reference/settings/api";
import { expectAxe, fits } from "../a11y";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";
import { failure, id, screenAccess, user } from "./fixtures";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));
const rows = [
  ["/settings/company-domain", "shell.settings.domain", "account.domain.title"],
  ["/people/numbering", "identifiers.numbering.title", "identifiers.numbering.title"],
  ["/people/job-titles", "shell.settings.titles", "titles.title"],
  ["/people/period-locks", "periodLocks.title", "periodLocks.title"],
] as const;
const states = ["populated", "failed", "refused", "direct", "scheduled", "fixed", "fresh"] as const;
type State = typeof states[number];
const policyKeys = ["org_structure", "people_correction", "identity_merge", "registration_void", "exit", "import_rollback"];
const policy = (state: State, key = policyKeys[0]): components["schemas"]["SettingEntry"] => ({
  key: `approval.policy.${key}`, kind: { type: "code", allowed: ["route", "none"] }, default: "none",
  looser_when: "higher", governance: state === "fixed" ? "fixed" : "tenant", legal_basis: null,
  value: state === "direct" || state === "fresh" || key !== policyKeys[0] ? "none" : "route", version: "code_default", effective_from: null,
  source: { layer: state === "fixed" ? "platform" : state === "fresh" ? "code_default" : "tenant", scope_entity_id: null }, chain: [],
  scheduled: state === "scheduled" && key === policyKeys[0] ? [{ id: id(91), scope_entity_id: null, value: "none", effective_from: "2026-12-01T00:00:00Z" }] : [],
});

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) for (const state of states) {
  test(`settings cards ${state} at ${width}px in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await mockScreen(page, screens[0], "empty");
    const access = screenAccess("/"); access.is_ops = true;
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: access });
    await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: { ...user, sign_in_id: "operator@current.test", is_tenant_ops: true } });
    await mockRoute(page, "get", "/api/v1/tenant/company-domain/request", state === "failed" || state === "refused"
      ? { status: state === "failed" ? 503 : 403, json: failure(state === "failed" ? "service_unavailable" : "forbidden") }
      : { status: 200, json: { pending_domain: state === "fresh" ? null : "example.test" } });
    await mockRoute(page, "get", "/api/v1/employee-number-rules", { status: 200, json: [{ scope_kind: "TENANT", scope_id: id(2), prefix: "E-", width: 4, next_number: "E-0012" }] });
    await mockRoute(page, "get", "/api/v1/job-titles", { status: 200, json: { can_manage: true, items: [
      { id: id(11), kind: "GRADE", label: "대리", grade_rank: 1, active: true },
      { id: id(14), kind: "TITLE", label: "선임", grade_rank: null, active: true },
      { id: id(12), kind: "POSITION", label: "팀장", grade_rank: null, active: true },
      { id: id(15), kind: "GRADE", label: "과장", grade_rank: 2, active: false },
    ] } });
    await mockRoute(page, "get", "/api/v1/period-locks", { status: 200, json: { items: [{ id: id(13), domain: "payroll", periodStart: "2026-09-01", periodEnd: "2026-09-30", reason: "월 마감", lockedAt: "2026-10-01T00:00:00Z", active: true, unlockReviewRequired: false }] } });
    await mockRoute(page, "get", "/api/v1/settings", { status: 200, json: { can_change: state !== "fixed", items: policyKeys.map(key => policy(state, key)) } });
    await mockRoute(page, "get", "/api/v1/reason-codes", { status: 200, json: { domain: "employee_number_change", items: [] } });
    const paths = [...rows.map(([to]) => routeReads[to].reads[0].slice(4)), settingsQuery.queryKey[0]];
    const reads: string[] = [];
    let identityReads = 0;
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (request.method() !== "GET") return;
      if (paths.includes(path)) reads.push(path);
      if (path === "/api/v1/users/me") identityReads++;
    });
    try {
      await page.goto("/settings");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const main = page.getByRole("main");
      await expect(main.getByRole("heading", { level: 1, name: t("shell.link.settings"), exact: true })).toBeVisible();
      for (const [path, label] of rows) {
        const card = main.getByRole("region", { name: t(label), exact: true });
        await expect(card.getByRole("heading", { level: 2 }).getByRole("link")).toHaveAttribute("href", path);
        await expect(card.getByRole("link").locator("svg[aria-hidden=true]")).toHaveCount(1);
      }
      await expect(main.getByRole("region", { name: t("shell.settings.domain"), exact: true })).toContainText(state === "failed" || state === "refused" ? t("settingsHub.unknown") : state === "fresh" ? "current.test" : "current.test · example.test · 신청 중");
      await expect(main.getByRole("region", { name: t("identifiers.numbering.title"), exact: true })).toContainText("E-0012");
      await expect(main.getByRole("region", { name: t("shell.settings.titles"), exact: true })).toContainText("직급 1 · 직위 1 · 직책 1");
      await expect(main.getByRole("region", { name: t("periodLocks.title"), exact: true })).toContainText("2026. 09. 30.");
      const approval = main.getByRole("region", { name: t("settingsHub.approval"), exact: true });
      await expect(approval).toContainText(state === "direct" || state === "fresh" ? t("settingsHub.approval.direct") : t("settingsHub.key.approval.policy.org_structure"));
      await expect(approval.getByRole("link")).toHaveCount(0);
      if (state === "fresh") { await expect(approval.getByRole("list")).toHaveCount(0); await expect(main).not.toContainText("신청 전"); }
      if (state === "scheduled") { await expect(approval).toContainText("2026. 12. 01."); await expect(approval).toContainText(t("settingsHub.code.none")); }
      if (state === "fixed") { await expect(approval.getByRole("listitem")).toHaveCount(2); await expect(approval).toContainText(t("settingsHub.governance.fixed")); await expect(approval).toContainText(t("settingsHub.readOnly")); await expect(approval).toContainText(t("settingsHub.layer.platform")); }
      expect(reads.toSorted()).toEqual(paths.toSorted());
      expect(identityReads).toBe(1);
      await fits(page, `settings/${state}/${width}/${theme}`);
      await expectAxe(page, `settings/${state}/${width}/${theme}`);
      await main.evaluate(el => { el.scrollTop = 0; });
      await page.screenshot({ path: test.info().outputPath(`settings-${state}-${width}-${theme}.png`), fullPage: true });
      if (state === "populated") for (const [path, label, title] of rows) {
        if (!page.url().endsWith("/settings")) await page.goBack();
        await main.getByRole("link", { name: t(label), exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`${path}$`));
        await expect(main.getByRole("heading", { level: 1, name: t(title), exact: true }).first()).toBeVisible();
        // The domain page deliberately revalidates its request; other destinations reuse the hub cache.
        await expect.poll(() => reads.toSorted()).toEqual([...paths, routeReads["/settings/company-domain"].reads[0].slice(4)].toSorted());
      }
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

for (const width of [1440, 390]) for (const profile of ["branch", "none"] as const) {
  test(`settings hub ${profile} at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, screens[0], "empty");
    const access = screenAccess(profile === "branch" ? "/people/job-titles" : "/");
    if (profile === "branch") for (const entry of access.entries) entry.scope.kind = "WORKPLACE";
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: access });
    await mockRoute(page, "get", "/api/v1/job-titles", { status: 200, json: { can_manage: false, items: [] } });
    await mockRoute(page, "get", "/api/v1/settings", { status: 200, json: { can_change: false, items: [policy("direct")] } });
    const paths = [...rows.map(([to]) => routeReads[to].reads[0].slice(4)), settingsQuery.queryKey[0]];
    const reads: string[] = [];
    page.on("request", request => { const path = new URL(request.url()).pathname; if (request.method() === "GET" && paths.includes(path)) reads.push(path); });
    try {
      await page.goto("/settings");
      const main = page.getByRole("main");
      if (profile === "none") {
        await expect(main.getByRole("region", { name: t("common.denied.title.plain"), exact: true })).toHaveCount(1);
        await expect(main.getByRole("heading", { name: t("shell.link.settings"), exact: true })).toHaveCount(0);
        await expect(page.getByRole("navigation", { name: t("shell.nav"), exact: true }).getByRole("link", { name: t("shell.link.settings"), exact: true })).toHaveCount(0);
        expect(reads.filter(path => path !== settingsQuery.queryKey[0])).toEqual([]);
      } else {
        await expect(main.getByRole("region", { name: t("shell.settings.titles"), exact: true })).toContainText(t("settingsHub.titles.empty"));
        await expect(main.getByRole("region", { name: t("settingsHub.approval"), exact: true })).toContainText(t("settingsHub.approval.direct"));
        await expect(main.getByRole("link")).toHaveCount(1);
        expect(reads.toSorted()).toEqual([routeReads["/people/job-titles"].reads[0].slice(4), settingsQuery.queryKey[0]].toSorted());
        await main.getByRole("link", { name: t("shell.settings.titles"), exact: true }).click();
        await expect(main.getByRole("heading", { name: t("titles.title"), exact: true })).toBeVisible();
        expect(reads.toSorted()).toEqual([routeReads["/people/job-titles"].reads[0].slice(4), settingsQuery.queryKey[0]].toSorted());
      }
      await fits(page, `settings/${profile}/${width}`);
      await expectAxe(page, `settings/${profile}/${width}`);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) test(`settings hub gallery at ${width}px in ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
  await page.goto("/_gallery?entry=settings-hub");
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  const demo = page.locator("[data-settings-gallery]");
  await expect(demo.getByRole("heading", { name: t("shell.link.settings"), exact: true })).toBeVisible();
  await expect(demo.getByRole("link")).toHaveCount(4);
  await expect(demo).toContainText("example.test");
  await expect(demo.getByRole("region", { name: t("shell.settings.titles"), exact: true })).toContainText("직급 1 · 직위 1 · 직책 1");
  await expect(demo).toContainText(t("settingsHub.unknown"));
  await expectAxe(page, `settings gallery/${width}/${theme}`, { include: "[data-settings-gallery]" });
});
