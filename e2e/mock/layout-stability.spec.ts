// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fits } from "../a11y";
import { clearShifts, expectStable, recordShifts } from "../stability";
import { screens } from "../states/registry";
import { attendanceBoardScreens } from "../states/attendance";
import { lifecycleSheetScreens } from "../states/lifecycle-sheets";
import { openGradeFix } from "../helpers/grade-fix";
import { commitLabel } from "../../apps/web/src/ui/composer/actions";
import { AT, checklist, id, screenAccess, structure, user } from "./fixtures";
import { previewData } from "./onboarding";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { moveDetail } from "./lifecycle-sheets";
import { attendancePerson } from "./attendance-board";

test.beforeAll(() => loadCatalog("ko"));
test.beforeEach(async ({ page }) => {
  await page.addInitScript(recordShifts);
  await page.clock.setFixedTime(new Date(AT));
});
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) return;
  for (const theme of ["light", "dark"]) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await fits(page, `${info.title} ${theme}`);
    await page.screenshot({ path: info.outputPath(`${theme}.png`), fullPage: true });
  }
});

for (const width of [1440, 390]) {
  test(`go-live: accepting terms leaves a compact resolved row at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, screens[0], "empty");
    const held = Promise.withResolvers<void>();
    await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: { ...user, is_tenant_ops: true, tenant: { name: "검증 회사", phase: "SETUP", go_live_at: null } } });
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { ...screenAccess("/setup/go-live", "SETUP"), is_ops: true } });
    const preview = previewData("ready");
    preview.blockers = [{ code: "terms_not_accepted", count: null, remedy: "accept_terms", records: [] }];
    let accepted = false;
    await mockRoute(page, "get", "/api/v1/onboarding/go-live/preview", () => ({ status: 200, json: { ...preview, blockers: accepted ? [] : preview.blockers } }));
    await page.route("**/api/v1/onboarding/terms", route => {
      if (route.request().method() !== "POST") return route.fallback();
      accepted = true;
      return route.fulfill({ status: 204 });
    });
    await mockRoute(page, "get", "/api/v1/onboarding/terms", async () => {
      await held.promise;
      const terms = { version: "2026-10-01", sha256: "a".repeat(64), body: t("setup.terms.title").repeat(500) };
      return { status: 200, json: { ...terms, privacy: { ...terms, policy_url: "https://example.test/privacy", review_pending: false } } };
    });
    try {
      await page.goto("/setup/go-live");
      const start = page.getByRole("button", { name: t("setup.golive.start"), exact: true });
      await expect(start).toBeVisible();
      await page.getByRole("button", { name: t("setup.terms.read"), exact: true }).click();
      await page.evaluate(() => document.fonts.ready);
      const warning = page.getByRole("heading", { name: t("setup.golive.warnings"), exact: true });
      await expect(warning).toBeVisible();
      const before = await warning.boundingBox();
      await page.evaluate(clearShifts);
      held.resolve();
      await expect(page.getByRole("button", { name: t("setup.terms.accept"), exact: true })).toBeAttached();
      expect(await warning.boundingBox()).toEqual(before);
      await expectStable(page, "go-live terms read");
      await page.evaluate(clearShifts);
      await page.getByRole("button", { name: t("setup.terms.accept"), exact: true }).click();
      await expect(page.getByRole("main")).toContainText(t("setup.golive.resolved"));
      await expectStable(page, "go-live resolved terms");
      expect(fixture.unexpected).toEqual([]);
    } finally { held.resolve(); fixture.release(); }
  });

  test(`attendance: long-record preview draws before evidence controls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const screen = attendanceBoardScreens[1];
    const fixture = await mockScreen(page, screen, "populated");
    const held = Promise.withResolvers<void>();
    await mockRoute(page, "post", "/api/v1/attendance/entries/preview", async () => {
      await held.promise;
      return { status: 200, json: {
        cells: [{ employee_id: id(100), work_date: "2026-10-04", status: "REFUSED" as const, code: "span_too_long", long_span_minutes: 960 }],
        ok: 0, unchanged: 0, refused: 1, conflicts: 0, closes: { blocking: 0, decision: 0, info: 0 }, opens: { blocking: 0, decision: 0, info: 0 },
      } };
    });
    try {
      await page.goto(`${screen.path}&detail=true`);
      await page.getByRole("textbox", { name: t("attendanceRecords.detail.inputFor", { name: attendancePerson.name }) }).fill("5-23");
      await page.getByRole("button", { name: t("attendanceRecords.toolbar.save"), exact: true }).click();
      const title = t("attendanceRecords.save.title", { count: 1 });
      const dock = page.getByRole("complementary", { name: title }).or(page.getByRole("dialog", { name: title }));
      await expect(dock).toBeVisible();
      await expect(dock.getByRole("radio")).toHaveCount(0);
      await page.evaluate(clearShifts);
      held.resolve();
      await expect(dock.getByRole("checkbox")).toBeVisible();
      await expect(dock.getByRole("radio").first()).toBeVisible();
      await expectStable(page, "long-record preview");
      expect(fixture.unexpected).toEqual([]);
    } finally { held.resolve(); fixture.release(); }
  });

  test(`org: structure loads without moving toolbar controls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, screens[2], "populated");
    const held = Promise.withResolvers<void>();
    await mockRoute(page, "get", "/api/v1/onboarding/checklist", async () => {
      await held.promise;
      return { status: 200, json: checklist };
    });
    await mockRoute(page, "get", "/api/v1/org-structure", async () => {
      await held.promise;
      return { status: 200, json: structure(3) };
    });
    try {
      await page.goto("/org");
      const collapse = page.getByRole("button", { name: t("structure.collapseAll"), exact: true });
      await expect(collapse).toBeVisible();
      await expect(page.getByRole("main")).toContainText(t("structure.phase.operatingChip"));
      await page.evaluate(() => document.fonts.ready);
      const before = await collapse.boundingBox();
      await page.evaluate(clearShifts);
      held.resolve();
      await expect(page.getByRole("tree")).toBeVisible();
      expect(await collapse.boundingBox()).toEqual(before);
      await expectStable(page, "org structure");
      expect(fixture.unexpected).toEqual([]);
    } finally { held.resolve(); fixture.release(); }
  });

  test(`attendance: late phase keeps tabs in place at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, attendanceBoardScreens[0], "populated");
    const held = Promise.withResolvers<void>();
    await mockRoute(page, "get", "/api/v1/org-structure", async () => {
      await held.promise;
      return { status: 200, json: structure(3) };
    });
    try {
      await page.goto(attendanceBoardScreens[0].path);
      const tab = page.getByRole("link", { name: t("attendance.tab.month"), exact: true });
      await expect(tab).toBeVisible();
      await expect(page.getByRole("main")).toContainText(t("attendance.phase.operating"));
      await page.evaluate(() => document.fonts.ready);
      const before = await tab.boundingBox();
      await page.evaluate(clearShifts);
      held.resolve();
      await expect(page.getByRole("main")).toContainText(t("attendance.phase.operating"));
      expect(await tab.boundingBox()).toEqual(before);
      await expectStable(page, "attendance phase");
      expect(fixture.unexpected).toEqual([]);
    } finally { held.resolve(); fixture.release(); }
  });

  test(`grade: department names settle before edit controls appear at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, lifecycleSheetScreens[0], "populated");
    const held = Promise.withResolvers<void>();
    const requested = Promise.withResolvers<void>();
    // Wait for every other card dependency, so absence of edit controls proves the units gate alone.
    const reads = ["employees/" + id(4000), "me/authz", "employment-assignments", "legal-entities",
      "employees/" + id(4000) + "/lifecycle-events", "employees/" + id(4000) + "/contracts",
      "employees/" + id(4000) + "/end-options", "employees/" + id(4000) + "/rrn", "hr/exit-cases"];
    const answered = reads.map(path => page.waitForResponse(response =>
      new URL(response.url()).pathname === `/api/v1/${path}`).then(response => response.finished()));
    await mockRoute(page, "get", "/api/v1/job-titles", { status: 200, json: { items: [{ id: id(4051), kind: "GRADE", label: "G3", grade_rank: 3, active: true }], can_manage: true } });
    await mockRoute(page, "get", "/api/v1/employees/{id}", { status: 200, json: { ...moveDetail, employee: { ...moveDetail.employee, org_unit_id: id(4003) } } });
    await mockRoute(page, "get", "/api/v1/org-units", async () => {
      requested.resolve();
      await held.promise;
      const unit = { status: "ACTIVE" as const, effectiveFrom: "2026-01-01", headcount: 1, updatedAt: AT };
      return { status: 200, json: { items: [
        { ...unit, id: id(4002), name: "본사", kind: "SITE" as const, parentId: null },
        { ...unit, id: id(4003), name: "부서 이름 ".repeat(20), kind: "DEPARTMENT" as const, parentId: id(4002) },
      ] } };
    });
    try {
      await page.goto(`/people/${id(4000)}`);
      await requested.promise;
      await Promise.all(answered);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(page.getByRole("status").filter({ hasText: t("common.loading") })).toHaveAttribute("aria-busy", "true");
      await expect(page.getByRole("button", { name: t("uiRecord.markOf", { field: t("empCard.f.grade"), mark: t("uiRecord.edit") }), exact: true })).toHaveCount(0);
      await page.evaluate(clearShifts);
      held.resolve();
      const sheet = await openGradeFix(page, false);
      const action = sheet.getByRole("button", { name: commitLabel({ kind: "PROMOTE", mode: "apply", count: 1 }), exact: true });
      await expect(action).toBeVisible();
      const grade = sheet.getByRole("radio", { name: "G3", exact: true });
      await expect(grade).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await expect(sheet).toContainText("부서 이름");
      await expectStable(page, "grade department");
      expect(fixture.unexpected).toEqual([]);
    } finally { held.resolve(); fixture.release(); }
  });
}
