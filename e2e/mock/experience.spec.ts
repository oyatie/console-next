// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { offeredExperiences, resolveExperience } from "../../apps/web/src/experience/table";
import { EXPERIENCE_SOURCE_KEY } from "../../apps/web/src/experience/store";
import { EXPERIENCE_KEY } from "../../apps/web/src/lib/prefs";
import { mockScreen } from "./screen";
import { mockNavigate } from "./navigation";
import { mockRoute } from "./route";
import { accountReads } from "./account";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));
const optionText = (experience: ReturnType<typeof offeredExperiences>[number]) =>
  experience.listing === "preview" ? t("account.experience.preview", { style: t(experience.label) }) : t(experience.label);
const tenantOptionText = (styleId: string) =>
  t("account.experience.organizationDefault", { style: styleId === "console" ? t("account.experience.console") : t("account.experience.baseline") });
// The style with nothing chosen. public/prefs.js stamps the shipped default ("console") before frame 0.
const shipped = resolveExperience().id;
const painted = (id: string | null | undefined) => id ?? shipped;

// Start on a fresh device to exercise the default before switching styles.
test.use({ storageState: { cookies: [], origins: [] } });

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`screen style switches in place and round-trips across account and device at ${width}px ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
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
      expect(await page.evaluate(key => localStorage.getItem(key), EXPERIENCE_KEY)).toBeNull();
      await expect(chooser).toHaveValue("tenant");
      await expect(chooser.locator("option")).toHaveText([tenantOptionText(shipped), ...offeredExperiences(shipped).map(optionText)]);
      expect(await chooser.locator("option").allTextContents()).not.toContain(
        t("account.experience.preview", { style: t("account.experience.console") }),
      );
      await expect(chooser).toHaveAccessibleDescription(t("account.experience.personal"));

      for (const unknown of ["unavailable", "constructor"]) {
        await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: EXPERIENCE_KEY, value: unknown });
        await page.reload();
        await expect(chooser).toHaveValue("tenant");
        expect(painted(await page.evaluate(() => (window as Window & { experienceAtBoot?: string }).experienceAtBoot))).toBe(shipped);
        await expect(page.getByRole("main")).toHaveCount(1);
      }

      for (const id of ["console", "baseline"]) {
        let loads = 0;
        const onLoad = () => { loads++; };
        page.on("load", onLoad);
        await chooser.selectOption(id);
        await expect(chooser).toHaveValue(id);
        await expect(page.locator("html")).toHaveAttribute("data-experience", id);
        expect(await page.evaluate(key => localStorage.getItem(key), EXPERIENCE_KEY)).toBe(id);
        expect(loads).toBe(0);
        page.off("load", onLoad);

        if (id === "console") {
          await expect(page.locator("[data-console-shell]")).toBeVisible();
          if (width === 1440) {
            await expect(page.getByRole("navigation", { name: t("shell.tabs.label") })).toBeVisible();
            await expect(page.getByRole("contentinfo", { name: t("shell.status.label") })).toBeVisible();
          } else {
            await expect(page.getByRole("navigation", { name: t("shell.nav") })).toBeVisible();
          }
          await fits(page, `console shell ${width} ${theme}`);
          await page.screenshot({ path: info.outputPath("console-shell.png") });
          if (process.env.STRUCT_SHOTS) {
            await page.screenshot({ path: `${process.env.STRUCT_SHOTS}/shell--${width}-${theme}.png` });
          }
          await expectAxe(page, `console shell ${width} ${theme}`);
        } else {
          await expect(page.locator("[data-console-shell]")).toHaveCount(0);
        }

        await page.reload();
        expect(await page.evaluate(() => (window as Window & { experienceAtBoot?: string }).experienceAtBoot)).toBe(id);
        await expect(chooser).toHaveValue(id);
      }

      // Choosing the organization default clears the personal override and follows the tenant setting.
      await chooser.selectOption("tenant");
      await expect(chooser).toHaveValue("tenant");
      expect(await page.evaluate(key => localStorage.getItem(key), EXPERIENCE_KEY)).toBeNull();

      // A style the chooser does not offer still loads from a stored choice when the server workspace is unset, and can be left.
      let workspace: Record<string, unknown> = {};
      await mockRoute(page, "get", "/api/v1/me/workspace", () => ({ status: 200, json: { layout: workspace } }));
      await mockRoute(page, "put", "/api/v1/me/workspace", request => {
        workspace = (request.postDataJSON() as { layout?: Record<string, unknown> })?.layout ?? {};
        return { status: 200, json: { layout: workspace } };
      });
      await page.evaluate(({ key, sourceKey, value }) => {
        localStorage.setItem(key, value);
        localStorage.removeItem(sourceKey);
      }, { key: EXPERIENCE_KEY, sourceKey: EXPERIENCE_SOURCE_KEY, value: "warm-clear" });
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-experience", "warm-clear");
      await expect(chooser).toHaveValue("warm-clear");
      await expect(chooser.locator("option")).toHaveText([tenantOptionText(shipped), ...offeredExperiences("warm-clear").map(optionText)]);

      await chooser.selectOption("baseline");
      await expect(chooser).toHaveValue("baseline");
      await expect(chooser.locator("option")).toHaveText([tenantOptionText(shipped), ...offeredExperiences("baseline").map(optionText)]);

      await fits(page, `screen style ${width} ${theme}`);
      await page.screenshot({ path: info.outputPath("screen-style.png"), fullPage: true });
      await expectAxe(page, `screen style ${width} ${theme}`);
      expect(fixture.unexpected).toEqual([]);
    } finally { fixture.release(); }
  });
}

test("unsaved input on the account page refuses a style switch without losing the edit", async ({ page }) => {
  const fixture = await mockScreen(page, screens[0], "populated");
  await accountReads(page, "save-unchanged");
  try {
    await page.goto("/account");
    const chooser = page.getByRole("combobox", { name: t("account.experience"), exact: true });
    await expect(chooser).toHaveValue("tenant");
    await page.getByRole("button", { name: t("account.name.edit"), exact: true }).click();
    const dialog = page.getByRole("dialog", { name: t("account.name.edit"), exact: true });
    const nameInput = dialog.getByLabel(t("account.field.name"));
    await nameInput.fill("Updated Name");
    await chooser.evaluate((el: HTMLSelectElement) => {
      el.value = "baseline";
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect(chooser).toHaveValue("tenant");
    await expect(nameInput).toHaveValue("Updated Name");
    expect(fixture.unexpected).toEqual([]);
  } finally { fixture.release(); }
});

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

test("the screen style chooser is available for gallery review at phone width", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.addInitScript(() => localStorage.setItem("console.theme", "dark"));
  await mockNavigate(page, "/_gallery?entry=experience-chooser");
  await expect(page.getByRole("heading", { name: t("account.experience"), exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: t("account.experience"), exact: true })).toHaveValue(shipped);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: info.outputPath("screen-style-gallery.png"), fullPage: true });
});
