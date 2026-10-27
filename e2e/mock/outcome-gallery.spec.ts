// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { expectAxe } from "../a11y";

for (const width of [1440, 390]) {
  test(`status vocabulary remains readable and accessible at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/_gallery");
    // The gallery's sheet example opens on phones.
    if (width === 390) {
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
    }
    const status = page.locator("[data-outcome-status]");
    await expect(status).toBeVisible();
    await expect(status.locator('[data-enum="orgChangeStatus"] .chip--ok')).toHaveText(["예약됨", "반영됨"]);
    await expect(status.locator('[data-enum="unknown"] .chip--neutral')).toHaveText(["FUTURE_STATUS", "FUTURE_LEAVE"]);
    await expect(status.locator('[data-enum="unknown"] > *')).toHaveCount(3);
    await expect(status.locator('[data-enum="unknown"] > *')).toHaveText(["FUTURE_STATUS", "산재 요양", "확인되지 않은 항목 FUTURE_LEAVE"]);
    await expect(status.locator('[data-enum="unknown"]')).toContainText("산재 요양");
    await expect(status.locator('[data-enum="unknown"]')).toContainText("확인되지 않은 항목");
    await expect(status.locator('[data-enum="supportSessionState"]')).toHaveText("확인되지 않은 항목 FUTURE_SESSION");
    await expect(status.locator('[data-enum="attendanceMark"] .chip--danger')).toHaveCount(3);
    await expect(status.locator('[data-enum="orgBulkPlanStatus"] .chip--danger')).toHaveCount(3);
    await expect(status.locator('[data-enum="identifierCorrectionStatus"] .chip--warn')).toHaveText(["승인 대기", "적용됨 · 사후 검토 대기"]);
    await expectAxe(page, `outcome status gallery ${width}px`, { include: "[data-outcome-status]" });
    const overflow = await status.evaluate(el => el.scrollWidth - el.clientWidth);
    expect(overflow).toBe(0);
  });
}
