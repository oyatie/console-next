// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { i18n, loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { id, inbox, screenAccess, user } from "../mock/fixtures";
import { previewData } from "../mock/onboarding";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { homeSetupChecklist, homeSetupScreen } from "./home-setup";

for (const locale of ["ko", "en"] as const) for (const width of [1440, 390]) {
  test(`missing registration: named blocker and server recovery in ${locale} at ${width}px @ui-state`, async ({ page }) => {
    await loadCatalog(locale);
    i18n.set(locale);
    await page.addInitScript(value => localStorage.setItem("console.locale", value), locale);
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, homeSetupScreen, "empty");
    const preview = previewData("ready");
    preview.warnings = [];
    let fixed = false;
    let commands = 0;
    const checklist = homeSetupChecklist("first");
    checklist.steps = [checklist.steps[0]!, checklist.steps.at(-1)!];
    checklist.total = checklist.steps.length;
    checklist.steps[0] = { ...checklist.steps[0]!, state: "todo", action: "add_registration", remedy: "add_registration", count: 1 };
    const setup = () => ({ ...checklist, steps: checklist.steps.map((step, i) => i === 0 && fixed ? { ...step, state: "done" as const, remedy: null } : step) });
    await mockRoute(page, "get", "/api/v1/onboarding/checklist", () => ({ status: 200, json: setup() }));
    await mockRoute(page, "get", "/api/v1/me/action-inbox", () => ({ status: 200, json: { ...inbox(0), setup: setup() } }));
    await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: { ...user, is_tenant_ops: true, tenant: { name: "화면 검증 회사", phase: "SETUP", go_live_at: null } } });
    await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json: { ...screenAccess("/setup/go-live", "SETUP"), is_ops: true } });
    await mockRoute(page, "get", "/api/v1/onboarding/go-live/preview", () => ({ status: 200, json: {
      ...preview, digest: fixed ? "fixed" : "missing", blockers: fixed ? [] : [{
        code: "entity_without_registration", count: 1, remedy: "add_registration",
        records: [{ kind: "legal_entity", id: id(10), legal_entity_id: id(10), name: "미등록 법인" }],
      }],
    } }));
    page.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/onboarding/go-live")) commands++; });
    try {
      await page.goto("/");
      const entity = page.locator('[data-step]').first();
      await expect(entity.locator('[data-step-state]')).toHaveText(t("uiSetupRail.state.todo"));
      await expect(entity.getByRole("link", { name: t("setup.fix.add_registration"), exact: true })).toHaveAttribute("href", "/org/entities");
      await expect(entity).toContainText(t("setup.remedy.add_registration"));
      for (const theme of ["light", "dark"]) {
        await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
        await fits(page, "required registration rail");
        await page.screenshot({ path: test.info().outputPath(`rail-${locale}-${width}-${theme}.png`), fullPage: true });
      }
      await expectAxe(page, `registration rail/${locale}/${width}`);
      await page.goto("/setup/go-live");
      const start = page.getByRole("button", { name: t("setup.golive.start"), exact: true });
      const row = page.locator('[data-blocker-row="entity_without_registration"]');
      await expect(row).toContainText(t("setup.golive.item.entity_without_registration", { count: 1 }));
      const fix = row.getByRole("link");
      await expect(fix).toHaveCount(1);
      await expect(fix).toContainText("미등록 법인");
      await expect(fix).toContainText(t("setup.fix.add_registration"));
      await expect(fix).toHaveAttribute("href", `/org/entities/${id(10)}`);
      await expect(start).toHaveAttribute("aria-disabled", "true");
      for (const theme of ["light", "dark"]) {
        await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
        await fits(page, "missing registration");
        await page.screenshot({ path: test.info().outputPath(`${locale}-${width}-${theme}.png`), fullPage: true });
      }
      await expectAxe(page, `missing registration/${locale}/${width}`);
      fixed = true;
      await page.reload();
      await expect(page.locator('[data-blocker-row="entity_without_registration"]')).toHaveCount(0);
      await expect(start).not.toHaveAttribute("aria-disabled", "true");
      await page.goto("/");
      await expect(entity.locator('[data-step-state]')).toHaveText(t("uiSetupRail.state.done"));
      await expect(entity.getByRole("link", { name: t("setup.fix.add_registration"), exact: true })).toHaveCount(0);
      expect(commands).toBe(0);
    } finally {
      i18n.set("ko");
      fixture.release();
      expect(fixture.unexpected).toEqual([]);
    }
  });
}
