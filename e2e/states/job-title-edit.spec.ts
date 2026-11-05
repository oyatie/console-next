// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";
import { failure, id } from "../mock/fixtures";

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

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  for (const code of ["job_title_label_invalid", "job_title_label_taken"] as const) {
    test(`job title refusal ${code} ${width} ${theme} @ui-state`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
      const fixture = await mockScreen(page, screens.find(s => s.key === "people")!, "populated");
      const entry = { id: id(101), kind: "JOB" as const, label: "개발자", grade_rank: null, active: true };
      const invalid = code === "job_title_label_invalid";
      let writes = 0;
      await mockRoute(page, "get", "/api/v1/job-titles", { status: 200, json: { can_manage: true, items: [entry] } });
      const body = failure(code);
      body.error.message = "internal basis";
      if (invalid) body.error.errors = [{ field: "label", code }];
      if (invalid) await mockRoute(page, "post", "/api/v1/job-titles", () => {
        writes++;
        return writes === 1 ? { status: 422, json: body } : { status: 201, json: entry };
      });
      else await mockRoute(page, "patch", "/api/v1/job-titles/{id}", () => {
        writes++;
        return writes === 1 ? { status: 409, json: body } : { status: 200, json: entry };
      });
      try {
        await page.goto("/people/job-titles");
        if (invalid) await page.getByRole("radio", { name: t("enum.jobTitleKind.JOB"), exact: true }).press("Space");
        else await page.getByRole("button", { name: t("titles.edit", { label: entry.label }), exact: true }).click();
        const form = invalid
          ? page.locator("form").filter({ has: page.getByRole("heading", { name: t("titles.add"), exact: true }) })
          : page.getByRole("form", { name: t("titles.edit.title", { label: entry.label }), exact: true });
        const input = form.getByRole("textbox", { name: t("titles.col.label") });
        const commit = form.getByRole("button", { name: t(invalid ? "titles.add.commit" : "titles.edit.commit"), exact: true });
        await input.fill("다른 직무");
        await commit.click();
        const refusal = form.getByRole("alert");
        await expect(refusal).toBeVisible();
        await expect(refusal).toContainText(t(`common.failed.code.${code}`));
        await expect(refusal).not.toContainText("internal");
        await expect(refusal.locator('code[translate="no"]')).toHaveText(code);
        await expect(refusal).toContainText(id(99));
        await expect(input).toHaveValue("다른 직무");
        await fits(page, `job-title-refusal/${code}/${width}/${theme}`);
        await expectAxe(page, `job-title-refusal/${code}/${width}/${theme}`);
        const box = await refusal.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        if (!invalid) await expect(form.locator("..")).toHaveAttribute("data-card", "action");
        await page.screenshot({ path: info.outputPath("refusal.png"), fullPage: true });
        await input.fill("새 직무");
        await commit.click();
        await expect(refusal).toHaveCount(0);
        expect(writes).toBe(2);
        expect(fixture.unexpected).toEqual([]);
      } finally { await page.close(); fixture.release(); }
    });
  }
}
