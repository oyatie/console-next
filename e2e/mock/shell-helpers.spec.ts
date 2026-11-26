// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { bootEn, bootKo } from "../../packages/i18n/src/catalogs/boot";
import { experienceState } from "../experience";
import { barControl, needsMe, openNav, scroller, setLocale, setTheme, shellSelectors } from "../shell";
import { screens } from "../states/registry";
import { mockScreen } from "./screen";

// One spec drives the chrome helpers in both styles, whichever one ships as the default.
for (const style of ["baseline", "console"] as const) test.describe(`${style} chrome`, () => {
  test.use({ storageState: experienceState(style) });
  for (const width of [1440, 390]) test(`shell helpers reach every control at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockScreen(page, screens[1], "populated");
    await page.goto(screens[1].path);
    await expect(page.locator("html")).toHaveAttribute("data-experience", style);
    const selectors = shellSelectors();
    await expect(page.locator(selectors.banner)).toBeVisible();
    await expect(page.locator(selectors.account)).toBeVisible();
    if (width === 1440) await expect(page.locator(selectors.searchText)).toBeVisible();
    await expect(needsMe(page)).toBeVisible();

    const nav = await openNav(page);
    const links = nav.getByRole("link");
    expect(await links.count()).toBeGreaterThan(5);
    for (const link of await links.all()) await expect(link).toBeVisible();
    await page.keyboard.press("Escape");

    for (const theme of ["dark", "light"] as const) await setTheme(page, theme);
    await expect(await barControl(page, bar => bar.getByRole("button", { name: bootKo["shell.logout"], exact: true }))).toBeVisible();
    await page.keyboard.press("Escape");
    await setLocale(page, "en");
    await expect(await openNav(page)).toHaveAccessibleName(bootEn["shell.nav"]);
    await page.keyboard.press("Escape");
    await setLocale(page, "ko");

    // Filler that cannot shrink, so the content outgrows the view in every layout.
    await page.addStyleTag({ content: "#main::after { content: ''; display: block; flex: none; height: 1800px; }" });
    const scrolled = await scroller(page);
    await scrolled.evaluate(element => { element.scrollTop = 700; });
    expect(await scrolled.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    expect(fixture.unexpected).toEqual([]);
    fixture.release();
  });
});
