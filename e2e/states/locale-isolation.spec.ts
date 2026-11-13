// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test as base } from "@playwright/test";
import { i18n, loadCatalog, t } from "@console/i18n";
import { test } from "../locale-fixture";
import { mockScreen } from "../mock/screen";
import { orgChangeScreens } from "./registry";

test.describe("catalog isolation in one worker", () => {
  test.describe.configure({ mode: "default" });
  let workerIndex: number;

  test.beforeAll(() => loadCatalog("ko"));

  test("English screen starts with the configured catalog @ui-state", async ({ page }, info) => {
    workerIndex = info.workerIndex;
    expect(i18n.locale).toBe("ko");
    await loadCatalog("en");
    i18n.set("en");
    await page.addInitScript(() => localStorage.setItem("console.locale", "en"));
    const fixture = await mockScreen(page, orgChangeScreens[1], "approval");
    try {
      await page.goto(orgChangeScreens[1].path);
      await expect(page.getByRole("heading", { name: t("orgChange.title.create", { name: "검증부서 1" }), exact: true })).toBeVisible();
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });

  // Use the unextended test so setup cannot hide a missing teardown from the English test.
  base("Korean screen inherits the restored catalog @ui-state", async ({ page }, info) => {
    expect(info.workerIndex).toBe(workerIndex);
    expect(i18n.locale).toBe("ko");
    const fixture = await mockScreen(page, orgChangeScreens[1], "approval");
    try {
      await page.goto(orgChangeScreens[1].path);
      await expect(page.getByRole("heading", { name: t("orgChange.title.create", { name: "검증부서 1" }), exact: true })).toBeVisible();
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
});

test.describe("catalog setup", () => {
  test.beforeAll(() => { i18n.set("en"); });

  test("setup resets a catalog changed outside the fixture", async () => {
    expect(i18n.locale).toBe("ko");
  });
});
