// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { expectAccessible } from "../a11y";

for (const width of [1440, 390]) {
  for (const { title, commit, drawer, routed } of [
    { title: "부서 이름 변경", commit: "부서 이름 변경 적용", drawer: true, routed: false },
    { title: "전보", commit: "전보 결재 요청", drawer: true, routed: true },
    { title: "직원 등록", commit: "직원 등록 적용", drawer: false, routed: false },
    { title: "휴직", commit: "휴직 결재 요청", drawer: false, routed: true },
  ]) {
    test(`${title} routing at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/_gallery?entry=composer");
      await page.getByRole("button", { name: commit, exact: true }).click();
      const composer = drawer ? page.getByRole("dialog") : page.locator("[data-composer-root]");
      await expect(composer.getByRole("heading", { name: title, exact: true })).toBeVisible();
      await expect(composer.getByRole("button", { name: commit, exact: true })).toBeVisible();
      await expect(composer.locator("[data-composer-section]")).toHaveCount(routed ? 3 : 2);
      const immediate = composer.getByText("이 변경은 승인 없이 즉시 적용됩니다", { exact: true });
      if (routed) {
        await expect(immediate).toHaveCount(0);
        await expect(composer.locator('[data-composer-section="approvals"]').getByRole("list")).toBeVisible();
        await expect(composer.locator('[data-composer-section="approvals"] > :first-child')).toHaveText("결재선");
      } else {
        await expect(immediate).toBeVisible();
        const commitBox = await composer.getByRole("button", { name: commit, exact: true }).boundingBox();
        const routingBox = await immediate.boundingBox();
        expect(routingBox!.y + routingBox!.height).toBeLessThanOrEqual(commitBox!.y);
        const reason = composer.locator("details");
        await expect(reason).not.toHaveAttribute("open", "");
        await reason.getByText("이유 보기", { exact: true }).click();
        await expect(reason).toContainText("전결 규정에서 이 변경을 즉시 적용하도록 정했습니다");
      }
      await expectAccessible(page, `${title} composer ${width}`);
      await composer.getByRole("button", { name: "닫기", exact: true }).click();
      await expect(composer).toHaveCount(0);
    });
  }
}
