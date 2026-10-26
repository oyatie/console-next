// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { orgWorkReads } from "../mock/org-work";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";
import { orgWorkScreens, type OrgWorkState } from "./org-work";

test.beforeAll(() => loadCatalog("ko"));

for (const screen of orgWorkScreens) for (const state of Object.keys(screen.states) as OrgWorkState[]) for (const width of [1440, 390]) {
  test(`${screen.key}: ${state} at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const shell = await mockScreen(page, screens[2], state === "operating" ? "populated" : state);
    const fixture = { ...shell, ...await orgWorkReads(page, state) };
    try {
      await page.goto(screen.path);
      const main = page.getByRole("main");
      const heading = main.getByRole("heading", { level: 1 });
      await expect(heading).toHaveCount(1);
      await expect(heading).toBeVisible();
      if (screen.key !== "org-move") await expect(heading).toHaveText(t(screen.title));
      if (state === "loading") {
        await expect(main.locator("[data-read-layout]")).toBeVisible();
      } else if (state === "failed") {
        await expect(main.getByText(t("common.loadFailed.title"), { exact: true })).toHaveCount(1, { timeout: 20_000 });
        await expect(main.getByText(fixture.operationId, { exact: true })).toBeVisible();
        await expect(main.getByRole("button", { name: t("common.retry"), exact: true })).toBeEnabled();
      } else if (state === "refused") {
        await expect(main.getByRole("region", { name: t("common.denied.title.plain") })).toBeVisible();
        await expect(main.locator("textarea, input[type=file]")).toHaveCount(0);
      } else if (screen.key === "org-paste") {
        if (state === "operating") {
          await expect(main.locator("textarea")).toHaveCount(0);
          await expect(main.locator("#plan-title, #paste-foot")).toHaveCount(0);
          await expect(main.getByRole("link", { name: t("orgBulk.operating.action") })).toHaveAttribute("href", `/org?sel=${fixture.workplaceId}&act=dept-add`);
        } else if (state === "empty") {
          await expect(main.getByRole("link", { name: t("entity.empty.action"), exact: true })).toHaveAttribute("href", "/org/entities/new");
        } else {
          await expect(main.getByRole("textbox", { name: t("orgBulk.paste.input") })).toBeVisible();
        }
      } else if (screen.key === "org-import") {
        await expect(main.getByRole("button", { name: t("uiFileDrop.pick"), exact: true })).toBeVisible();
      } else if (state === "empty") {
        await expect(main.getByText(t("bulkMove.nothing"), { exact: true })).toBeVisible();
      } else {
        await expect(heading).toHaveText(t("bulkMove.titleOne", { name: "검증부서 1" }));
        await expect(main.getByRole("heading", { name: t("bulkMove.what"), exact: true })).toBeVisible();
      }
      await fits(page, `${screen.key}/${state}/${width}`);
      await expectAxe(page, `${screen.key}/${state}/${width}`);
      expect(errors).toEqual([]);
      expect(fixture.unexpected, "register every supporting read").toEqual([]);
    } finally {
      await page.close();
      fixture.release();
    }
  });
}
