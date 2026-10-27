// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { failure, inbox, LONG_NAME } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { homeSetupCases, homeSetupChecklist, homeSetupScreen } from "./home-setup";

test.beforeAll(() => loadCatalog("ko"));
for (const { state, registry } of homeSetupCases) for (const width of [1440, 390]) {
  test(`home setup: ${state} at ${width}px @ui-state`, async ({ page }, info) => {
    info.annotations.push({ type: "registry", description: registry });
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, homeSetupScreen, ["loading", "failed", "refused"].includes(state) ? state as "loading" | "failed" | "refused" : "empty");
    const checklist = homeSetupChecklist(state);
    await mockRoute(page, "get", "/api/v1/onboarding/checklist", { status: 200, json: checklist });
    await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: { tenant_name: state === "long" ? LONG_NAME : "검증법인", phase: "SETUP", unplaced: [], entities: [] } });
    if (!["loading", "failed", "refused"].includes(state)) {
      await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: { ...inbox(0), setup: checklist } });
    }
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.goto("/");
      const main = page.getByRole("main");
      const rail = main.getByRole("region", { name: t("setup.title"), exact: true });
      if (state === "loading") {
        await expect(main.locator('[aria-busy="true"]').last()).toBeVisible({ timeout: 20_000 });
        await expect(rail).toHaveCount(0);
      } else if (state === "failed") {
        await expect(main.getByText("불러오지 못했습니다", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
        await expect(main.getByRole("button", { name: "다시 불러오기", exact: true }).first()).toBeVisible();
        await expect(main.getByText(failure("service_unavailable").error.operation_id!, { exact: true }).first()).toBeVisible();
        await expect(rail).toHaveCount(0);
      } else if (state === "refused") {
        await expect(main.getByRole("region", { name: "이 화면에 접근 권한이 없습니다" })).toBeVisible();
        await expect(rail).toHaveCount(0);
      } else {
        await expect(rail).toBeVisible({ timeout: 20_000 });
        await expect(rail.getByRole("list")).toHaveCount(1);
        await expect(rail.getByRole("heading", { level: 3 })).toHaveCount(0);
        const rows = rail.locator("[data-step]");
        await expect(rows).toHaveCount(checklist.steps.length);
        for (const [index, step] of checklist.steps.entries()) await expect(rows.nth(index)).toContainText(t(`setup.step.${step.key}` as Parameters<typeof t>[0]));
        const progress = rail.getByRole("progressbar", { name: t("setup.title"), exact: true });
        await expect(progress).toHaveAttribute("aria-valuenow", String(checklist.done));
        await expect(progress).toHaveAttribute("aria-valuemax", String(checklist.total));
        await expect(main.locator("progress")).toHaveCount(0);
        await expect(rail.locator(".btn--primary")).toHaveCount(state === "mid" ? 0 : 1);
        if (state !== "mid") await expect(rail.locator('[aria-current="step"] .btn--primary')).toHaveCount(1);
        for (const [index, step] of checklist.steps.entries()) {
          if (step.state === "blocked" && ["create_legal_entity", "create_workplace"].includes(step.remedy ?? "")) {
            await expect(rows.nth(index)).toContainText("대기 ·");
            await expect(rows.nth(index).locator("a,button")).toHaveCount(0);
          }
        }
        await expect(rail.getByRole("link", { name: "설정 단계 기록", exact: true })).toHaveAttribute("href", "/org/history");
        await expect(main.locator('#setup-bulk').locator("..").getByRole("link")).toHaveCount(0);
        if (state === "long") await expect(main.getByText("2,000", { exact: true })).toBeVisible();
        if (state === "passkey") await expect(rail.locator('[aria-current="step"]')).toContainText("패스키 등록");
      }
      await fits(page, `home-setup/${state}/${width}`);
      await expectAxe(page, `home-setup/${state}/${width}`);
      expect(errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    } finally {
      await page.close();
      fixture.release();
    }
  });
}

for (const width of [1440, 390]) test(`setup rail gallery at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await mockScreen(page, homeSetupScreen, "empty");
  await page.goto("/_gallery");
  if (width === 390) {
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
  }
  const rail = page.getByRole("region", { name: "운영 준비", exact: true });
  await rail.scrollIntoViewIfNeeded();
  await expect(rail.getByRole("heading", { level: 3 })).toHaveCount(3);
  await expect(rail.getByRole("progressbar", { name: "운영 준비", exact: true })).toHaveAttribute("aria-valuenow", "2");
  await expect(rail.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "7");
  expect(await rail.evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
  expect(fixture.unexpected).toEqual([]);
  fixture.release();
});
