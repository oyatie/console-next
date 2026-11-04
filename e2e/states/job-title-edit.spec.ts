// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 390]) {
  test(`job title inline edit opens and stays open at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, screens.find(s => s.key === "people")!, "populated");
    await mockRoute(page, "get", "/api/v1/job-titles", { status: 200, json: { can_manage: true, items: [
      { id: "00000000-0000-4000-8000-000000000101", kind: "TITLE", label: "팀장", grade_rank: null, active: true },
    ] } });
    try {
      await page.goto("/people/job-titles");
      const edit = page.getByRole("button", { name: t("titles.edit", { label: "팀장" }), exact: true });
      await edit.click();
      const form = page.getByRole("form", { name: t("titles.edit.title", { label: "팀장" }), exact: true });
      await expect(form).toBeVisible();
      const label = form.getByRole("textbox", { name: t("titles.col.label") });
      await label.fill("본부장");
      await expect(label).toBeFocused();
      await expect(label).toHaveValue("본부장");
      await fits(page, `job title editing/${width}`);
      await expectAxe(page, `job title editing/${width}`);
      await form.getByRole("button", { name: t("composer.dismiss"), exact: true }).click();
      await expect(form).toHaveCount(0);
      await edit.click();
      await expect(form).toBeVisible();
      await expect(form.getByRole("textbox", { name: t("titles.col.label") })).toHaveValue("팀장");
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}
