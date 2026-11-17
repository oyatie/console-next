// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { EXPERIENCE_KEY } from "../../apps/web/src/lib/prefs";
import { mockScreen } from "./screen";
import { accountReads } from "./account";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`screen style round-trips on this device at ${width}px ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("console.theme", value), theme);
    // Observe the classic script before the module entry can execute.
    await page.route("**/prefs.js", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: `${await response.text()}\nwindow.experienceAtBoot = document.documentElement.dataset.experience;` });
    });
    const fixture = await mockScreen(page, screens[0], "populated");
    await accountReads(page, "save-unchanged");
    try {
      await page.goto("/account");
      const chooser = page.getByRole("combobox", { name: t("account.experience"), exact: true });
      expect(await page.evaluate(key => localStorage.getItem(key), EXPERIENCE_KEY)).toBe(process.env.E2E_EXPERIENCE ?? "baseline");
      await expect(chooser).toHaveValue("baseline");
      await expect(chooser.locator("option")).toHaveText([t("account.experience.baseline")]);
      await expect(chooser).toHaveAccessibleDescription(t("account.experience.device"));
      for (const unknown of ["unavailable", "constructor"]) {
        await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: EXPERIENCE_KEY, value: unknown });
        await page.reload();
        await expect(chooser).toHaveValue("baseline");
        expect(await page.evaluate(() => (window as Window & { experienceAtBoot?: string }).experienceAtBoot)).toBeUndefined();
        await expect(page.getByRole("main")).toHaveCount(1);
      }
      await Promise.all([page.waitForEvent("load"), chooser.selectOption("baseline")]);
      await expect(chooser).toHaveValue("baseline");
      await expect(page.locator("html")).toHaveAttribute("data-experience", "baseline");
      expect(await page.evaluate(key => localStorage.getItem(key), EXPERIENCE_KEY)).toBe("baseline");
      expect(await page.evaluate(() => (window as Window & { experienceAtBoot?: string }).experienceAtBoot)).toBe("baseline");
      await fits(page, `screen style ${width} ${theme}`);
      await page.screenshot({ path: info.outputPath("screen-style.png"), fullPage: true });
      await expectAxe(page, `screen style ${width} ${theme}`);
      expect(fixture.unexpected).toEqual([]);
    } finally { fixture.release(); }
  });
}

test("refused device storage keeps the chooser available without reloading", async ({ page }) => {
  const fixture = await mockScreen(page, screens[0], "populated");
  await accountReads(page, "save-unchanged");
  try {
    await page.goto("/account");
    const chooser = page.getByRole("combobox", { name: t("account.experience"), exact: true });
    await expect(chooser).toBeVisible();
    await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error("Storage refused"); }; });
    await chooser.selectOption("baseline");
    await expect(page.getByRole("alert")).toHaveText(t("account.experience.failed"));
    await expect(chooser).toBeEnabled();
    expect(fixture.unexpected).toEqual([]);
  } finally { fixture.release(); }
});
