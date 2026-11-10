// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { jobTitleSchemas } from "@console/api";
import { i18n, loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";
import { failure, id } from "../mock/fixtures";

const { minimum, maximum } = jobTitleSchemas.update.properties.grade_rank;
const labelMax = jobTitleSchemas.update.properties.label.maxLength;

test.beforeEach(async () => { await loadCatalog("ko"); i18n.set("ko"); });

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
  for (const code of ["job_title_label_invalid", "job_title_label_taken", "job_title_rank_invalid"] as const) {
    test(`job title refusal ${code} ${width} ${theme} @ui-state`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
      const fixture = await mockScreen(page, screens.find(s => s.key === "people")!, "populated");
      const entry = { id: id(101), kind: "JOB" as const, label: "개발자", grade_rank: null, active: true };
      const invalid = code !== "job_title_label_taken";
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
        const row = page.getByRole("row").filter({ hasText: entry.label });
        await expect(row.getByRole("cell", { name: entry.label, exact: true })).toBeVisible();
        if (width === 390) await expect(row.locator('[data-card="title"]')).toHaveText(entry.label);
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
        expect(await refusal.evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0);
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

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`job title edit refuses ranks outside the contract ${width} ${theme} @ui-state`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await mockScreen(page, screens.find(s => s.key === "people")!, "populated");
    const entry = { id: id(101), kind: "TITLE" as const, label: "팀장", grade_rank: 10, active: true };
    const writes: unknown[] = [];
    await mockRoute(page, "get", "/api/v1/job-titles", { status: 200, json: { can_manage: true, items: [entry] } });
    await mockRoute(page, "patch", "/api/v1/job-titles/{id}", request => {
      writes.push(request.postDataJSON());
      return { status: 200, json: entry };
    });
    try {
      await page.goto("/people/job-titles");
      const edit = page.getByRole("button", { name: t("titles.edit", { label: entry.label }), exact: true });
      await edit.click();
      const form = page.getByRole("form", { name: t("titles.edit.title", { label: entry.label }), exact: true });
      const rank = form.getByRole("textbox", { name: t("titles.col.rank") });
      const commit = form.getByRole("button", { name: t("titles.edit.commit"), exact: true });
      await expect(form.getByRole("textbox", { name: t("titles.col.label") })).toHaveAttribute("maxlength", String(labelMax));
      for (const value of [String(minimum - 1), String(maximum + 1), "1.5", "", " ", "0x10", "1e2", "Infinity"]) {
        await rank.fill(value);
        await expect(commit).toHaveAttribute("aria-disabled", "true");
        await expect(rank).toHaveAttribute("aria-invalid", "true");
        await expect(form).toContainText(t("titles.rank.bad", { min: minimum, max: maximum }));
        await rank.press("Enter");
        // TextInput consumes Enter; exercise the submit guard independently of the disabled button too.
        await form.evaluate(element => (element as HTMLFormElement).requestSubmit());
        await expect(form).toBeVisible();
        expect(writes).toEqual([]);
      }
      await fits(page, `job-title-rank/${width}/${theme}`);
      await expectAxe(page, `job-title-rank/${width}/${theme}`);
      await page.screenshot({ path: info.outputPath("rank-refused.png"), fullPage: true });
      for (const value of [minimum, maximum]) {
        await rank.fill(String(value));
        await expect(commit).not.toHaveAttribute("aria-disabled", "true");
        await commit.click();
        await expect(form).toHaveCount(0);
        expect(writes.at(-1)).toEqual({ grade_rank: value });
        if (value === minimum) await edit.click();
      }
      expect(writes).toHaveLength(2);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });

  test(`job title add refuses rank above the contract ${width} ${theme} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await mockScreen(page, screens.find(s => s.key === "people")!, "populated");
    const entry = { id: id(101), kind: "GRADE" as const, label: "사원", grade_rank: maximum, active: true };
    const writes: unknown[] = [];
    await mockRoute(page, "get", "/api/v1/job-titles", { status: 200, json: { can_manage: true, items: [] } });
    await mockRoute(page, "post", "/api/v1/job-titles", request => {
      writes.push(request.postDataJSON());
      return { status: 201, json: entry };
    });
    try {
      await page.goto("/people/job-titles");
      await page.getByRole("radio", { name: t("enum.jobTitleKind.GRADE"), exact: true }).press("Space");
      const form = page.locator("form").filter({ has: page.getByRole("heading", { name: t("titles.add"), exact: true }) });
      await form.getByRole("textbox", { name: t("titles.col.label") }).fill(entry.label);
      const rank = form.getByRole("textbox", { name: t("titles.col.rank") });
      await rank.fill(String(jobTitleSchemas.create.properties.grade_rank.maximum + 1));
      await form.getByRole("button", { name: t("titles.add.commit"), exact: true }).click();
      await expect(rank).toHaveAttribute("aria-invalid", "true");
      await fits(page, `job-title-add/${width}/${theme}`);
      await expectAxe(page, `job-title-add/${width}/${theme}`);
      expect(writes).toEqual([]);
      await rank.fill(String(maximum));
      await form.getByRole("button", { name: t("titles.add.commit"), exact: true }).click();
      await expect(form.getByRole("textbox", { name: t("titles.col.label") })).toHaveValue("");
      expect(writes).toEqual([{ kind: "GRADE", label: entry.label, grade_rank: maximum }]);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });

  test(`full length job title actions fit ${width} ${theme} @ui-state`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    const fixture = await mockScreen(page, screens.find(s => s.key === "people")!, "populated");
    for (const character of ["가", "W"]) {
      const entry = { id: id(101), kind: "TITLE" as const, label: character.repeat(labelMax), grade_rank: 10, active: true };
      await mockRoute(page, "get", "/api/v1/job-titles", { status: 200, json: { can_manage: true, items: [entry] } });
      await page.goto("/people/job-titles");
      const edit = page.getByRole("button", { name: t("titles.edit", { label: entry.label }), exact: true });
      await expect(edit).toBeVisible();
      if (width === 1440) for (const column of ["kind", "rank", "state"] as const) {
        const header = page.getByRole("columnheader", { name: t(`titles.col.${column}`), exact: true });
        await expect(header).toBeVisible();
        expect((await header.boundingBox())!.width).toBeGreaterThan(100);
      }
      if (width === 1440) {
        const labelHeader = page.getByRole("columnheader", { name: t("titles.col.label"), exact: true });
        const actionHeader = page.getByRole("columnheader", { name: t("titles.col.actions"), exact: true });
        // Repeated-label actions need more room than the display-only label.
        expect((await actionHeader.boundingBox())!.width - (await labelHeader.boundingBox())!.width).toBeGreaterThan(1);
      }
      const toggle = page.getByRole("button", { name: t("titles.deactivate", { label: entry.label }), exact: true });
      for (const action of [edit, toggle]) {
        expect(await action.evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
        const box = await action.boundingBox();
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      }
      await fits(page, `job-title-label/${character}/${width}/${theme}`);
      await edit.click();
      const form = page.getByRole("form", { name: t("titles.edit.title", { label: entry.label }), exact: true });
      await expect(form.getByRole("textbox", { name: t("titles.col.label") })).toHaveValue(entry.label);
      await fits(page, `job-title-label-edit/${character}/${width}/${theme}`);
      await expectAxe(page, `job-title-label/${character}/${width}/${theme}`);
      await page.screenshot({ path: info.outputPath(`label-${character}.png`), fullPage: true });
    }
    expect(fixture.unexpected).toEqual([]);
    await page.close();
    fixture.release();
  });
}
