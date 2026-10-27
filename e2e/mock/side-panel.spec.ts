// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

test.beforeEach(async ({ page }) => {
  await page.route(url => url.pathname.startsWith("/api/"), route => route.fulfill({ status: 503, json: { error: { code: "service_unavailable", message: "unavailable" } } }));
});

async function closeGalleryDock(page: Page) {
  // This unrelated gallery demo starts open and takes focus on mount, including after reload.
  const dock = page.getByRole("complementary", { name: "26칸 저장", exact: true }).or(page.getByRole("dialog", { name: "26칸 저장", exact: true }));
  await dock.getByRole("button", { name: "돌아가기", exact: true }).click();
  await expect(dock).toHaveCount(0);
}

test("API mocks leave Vite module paths untouched", async ({ page }) => {
  const response = await page.goto("/packages/api/src/index.ts");
  expect(response?.status()).toBe(200);
  const status = await page.evaluate(async () => (await fetch("/api/v1/me")).status);
  expect(status).toBe(503);
});

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    test(`SidePanel contract at ${width}px in ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/_gallery");
      await closeGalleryDock(page);
      const section = page.locator("[data-side-panel-gallery]");
      for (const state of ["loading", "empty", "failed", "refused", "populated", "long", "large"]) {
        const trigger = section.locator(`[data-panel-trigger="${state}"]`);
        await trigger.press("Space");
        const panel = section.getByRole("complementary");
        await expect(panel).toBeVisible();
        await expect(panel.getByRole("heading").first()).toBeFocused();
        await expect(page).toHaveURL(new RegExp(`sel=${state}`));
        expect(await panel.getAttribute("aria-modal")).toBeNull();
        const box = (await panel.boundingBox())!;
        expect(Math.round(box.width)).toBe(width === 390 ? width : state === "large" ? 640 : 440);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(await panel.evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
        if (state === "loading") await expect(panel.getByRole("status")).toHaveAttribute("aria-busy", "true");
        if (state === "empty") await expect(panel.getByRole("heading", { name: "표시할 항목이 없습니다" })).toBeVisible();
        if (state === "failed") await expect(panel.getByRole("alert")).toContainText("불러오지 못했습니다");
        if (state === "refused") await expect(panel).toContainText("접근 권한이 없습니다");
        if (state === "long") expect(await panel.locator('[tabindex="0"]').evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);
        const axe = await new AxeBuilder({ page }).include("[data-side-panel]").analyze();
        expect(axe.violations).toEqual([]);
        if (state === "long" || state === "large") await test.info().attach(`panel-${state}-${width}-${theme}`, { body: await panel.screenshot(), contentType: "image/png" });
        if (width === 390 && state === "long") await panel.getByRole("button", { name: "돌아가기", exact: true }).click();
        else await panel.press("Escape");
        await expect(panel).toHaveCount(0);
        await expect(trigger).toBeFocused();
      }
    });
  }
}

test("selection survives reload and Back/Forward, and close restores the selected row", async ({ page }) => {
  await page.goto("/_gallery?keep=scope");
  await closeGalleryDock(page);
  const section = page.locator("[data-side-panel-gallery]");
  const trigger = section.locator('[data-panel-trigger="populated"]');
  await trigger.press("Enter");
  await expect(page).toHaveURL(/keep=scope.*sel=populated/);
  await page.goBack();
  await expect(section.getByRole("complementary")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.goForward();
  await expect(section.getByRole("complementary").getByRole("heading").first()).toBeFocused();
  await page.reload();
  await closeGalleryDock(page);
  await expect(section.getByRole("complementary").getByRole("heading").first()).toBeFocused();
  await section.getByRole("button", { name: "상세 패널 닫기" }).click();
  await expect(trigger).toBeFocused();
  await expect(page).toHaveURL(/keep=scope$/);
});
