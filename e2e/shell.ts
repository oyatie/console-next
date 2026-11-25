// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, type Page } from "@playwright/test";
import { bootEn, bootKo } from "../packages/i18n/src/catalogs/boot";

type ShellSelectors = Record<"banner" | "account" | "accountText" | "search" | "searchText" | "spacer", string>;
// Console's classes are hashed, so its chrome is found by ids and attributes: the bar is the header that draws the
// chrome (desk and phone), the account the menu trigger, the search the desk bar's shortcut button. It has no spacer.
const consoleSearch = 'header[data-surface="chrome"] button[aria-keyshortcuts~="Meta+K"]';
const shells: Record<"baseline" | "console", Partial<ShellSelectors>> = {
  baseline: { banner: ".top", account: ".top__name", accountText: ".top__name span", search: ".top__jump", searchText: ".top__jumpText", spacer: ".top__spacer" },
  console: { banner: 'header[data-surface="chrome"]', account: "#console-top-account, #console-phone-account", accountText: "#console-top-account > bdi", search: consoleSearch, searchText: `${consoleSearch} > bdi` },
};

/**
 * Each selector is `:is()` over every style's, so it finds the chrome in force whenever it is queried and composes
 * (`${banner} button`). It is read before any page loads (init scripts, axe scopes), when no style can be asked.
 */
export function shellSelectors(): ShellSelectors {
  const keys = Object.keys(shells.baseline) as (keyof ShellSelectors)[];
  return Object.fromEntries(keys.map(key => [key, `:is(${Object.values(shells).flatMap(entry => entry[key] ?? []).join(", ")})`])) as ShellSelectors;
}

/** Look-specific selectors stay here; shared landmarks and command names stay in the specs. */
export function shell(page: Page) {
  const selectors = shellSelectors();
  return {
    banner: page.getByRole("banner"), navigation: page.getByRole("navigation", { name: bootKo["shell.nav"], exact: true }),
    account: page.locator(selectors.account), accountText: page.locator(selectors.accountText),
    search: page.locator(selectors.search), searchText: page.locator(selectors.searchText), spacer: page.locator(selectors.spacer),
  };
}

const signOutName = { name: bootKo["shell.logout"], exact: true };
// Any name but the module overflow's, which Console's bar also shows collapsed when its modules do not fit.
const notOverflow = new RegExp(`^(?!${bootKo["shell.nav.more"].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$)`);

/**
 * The signed-in account control in either style: Classic's bar holds the sign-out command itself; Console's bar
 * holds the account menu, whose trigger is named after the person, so it is the collapsed button of a bar with no
 * sign-out, other than the module overflow. A signed-out page has no bar.
 */
export function accountControl(page: Page) {
  const banner = page.getByRole("banner");
  return banner.getByRole("button", signOutName).or(banner.filter({ hasNot: page.getByRole("button", signOutName) }).getByRole("button", { expanded: false, name: notOverflow }));
}

/** A session that ends in use keeps its screen, bar included, under the sign-in-again dialog, which only makes it inert. */
export async function expectSignedIn(page: Page, options?: { timeout?: number }) {
  await expect(accountControl(page)).toBeVisible(options);
  await expect(page.getByRole("dialog", { name: bootKo["idle.reauth.title"], exact: true })).toBeHidden();
}

/** Signs out from the bar: Classic offers the command there, Console inside the account menu. */
export async function signOut(page: Page) {
  const command = page.getByRole("banner").getByRole("button", signOutName);
  await expectSignedIn(page);
  if (!(await command.isVisible())) await accountControl(page).click();
  await command.click();
}

/**
 * Once the bar is drawn (public/prefs.js has named the style by then), whether Console's chrome is in force (every
 * other style draws Classic's) and the words of the page's language.
 */
async function chrome(page: Page) {
  await expect(page.locator(shellSelectors().banner)).toBeVisible();
  const html = page.locator("html");
  return { console: (await html.getAttribute("data-experience")) === "console", words: (await html.getAttribute("lang")) === "en" ? bootEn : bootKo };
}

/**
 * Shows the module navigation and returns it with every module link in it: Classic's phone menu is opened; Console's
 * bars are always drawn, and the modules that do not fit are opened from the overflow trigger.
 */
export async function openNav(page: Page) {
  const { console, words } = await chrome(page);
  const nav = page.getByRole("navigation", { name: words["shell.nav"], exact: true });
  if (!console) {
    // Desk widths show the rail and hide the menu button.
    const menu = page.getByRole("banner").getByRole("button", { name: words["shell.menu"], exact: true });
    await expect(nav.or(menu).filter({ visible: true }).first()).toBeVisible();
    if (await menu.isVisible() && (await menu.getAttribute("aria-expanded")) !== "true") await menu.click();
  } else {
    await expect(nav.getByRole("link").first()).toBeVisible();
    // The overflow trigger loads on its own. Until it has, the desk bar keeps an empty slot for it, and the phone bar a
    // stand-in of the same name, straight in its list item, that does nothing.
    if (await nav.locator(":scope > div:not([aria-hidden]), li:has(button)").count()) {
      const more = nav.getByRole("button", { name: words["shell.nav.more"], exact: true }).and(nav.locator("div > button"));
      if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
      await expect(more).toHaveAttribute("aria-expanded", "true");
    }
  }
  await expect(nav).toBeVisible();
  return nav;
}

/** The account controls: Classic draws them in the bar, which is returned; Console's account menu is opened and returned. */
export async function accountMenu(page: Page) {
  const { console, words } = await chrome(page);
  const banner = page.getByRole("banner");
  if (!console) return banner;
  // By id: until its code loads, the trigger is a link of the same name to the account page.
  const trigger = banner.locator("#console-top-account, #console-phone-account");
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  const menu = banner.getByRole("group", { name: words["shell.account"], exact: true });
  await expect(menu).toBeVisible();
  return menu;
}

/** Sets the colour theme from the chrome: Classic's toggle, named for the theme it turns to; Console's account menu. */
export async function setTheme(page: Page, theme: "light" | "dark") {
  const html = page.locator("html");
  const { console, words } = await chrome(page);
  if ((await html.getAttribute("data-theme")) !== theme) {
    await (console
      ? (await accountMenu(page)).getByRole("button", { name: words[`shell.theme.${theme}`], exact: true })
      : page.getByRole("banner").getByRole("button", { name: words[theme === "dark" ? "shell.theme.toDark" : "shell.theme.toLight"], exact: true })).click();
  }
  await expect(html).toHaveAttribute("data-theme", theme);
}

/** Sets the language from the chrome: Classic's select; Console's account menu. */
export async function setLocale(page: Page, locale: "ko" | "en") {
  const html = page.locator("html");
  const { console, words } = await chrome(page);
  if ((await html.getAttribute("lang")) !== locale) {
    if (console) await (await accountMenu(page)).getByRole("button", { name: words[`shell.locale.${locale}`], exact: true }).click();
    else await page.getByRole("banner").getByRole("combobox", { name: words["shell.locale"], exact: true }).selectOption(locale);
  }
  await expect(html).toHaveAttribute("lang", locale);
}

/**
 * The bar's to-do entry, in either style as it is queried: Classic's task button; Console's module link to the to-do
 * list, its count in the link's badge. Named in Korean.
 */
export function needsMe(page: Page) {
  return page.locator("#top-needs-me")
    .or(page.locator('html[data-experience="console"]').getByRole("navigation", { name: bootKo["shell.nav"], exact: true }).locator('a[href="/"]'));
}

/**
 * The element that scrolls the page's content: #main, except in Console's phone layout (PHONE_QUERY in
 * shell/console/shell.tsx), where the page itself scrolls so the browser can fold its bars.
 */
export async function scroller(page: Page) {
  const { console } = await chrome(page);
  return console && await page.evaluate(() => matchMedia("(max-width: 767px)").matches) ? page.locator("html") : page.locator("#main");
}
