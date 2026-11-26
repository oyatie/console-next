// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, type Locator, type Page } from "@playwright/test";
import { bootEn, bootKo, type BootMessageId } from "../packages/i18n/src/catalogs/boot";

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

// A bar name in either language, whole: a session may switch the screen to English, and an English bar must not fall
// through to another collapsed button there (Classic's to-do list, Console's module overflow).
const eitherLanguage = (id: BootMessageId) => `(?:${[bootKo[id], bootEn[id]].map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`;
const whole = (id: BootMessageId) => new RegExp(`^${eitherLanguage(id)}$`);
const signOutName = { name: whole("shell.logout") };
// Any name but the module overflow's, which Console's bar also shows collapsed when its modules do not fit.
const notOverflow = new RegExp(`^(?!${eitherLanguage("shell.nav.more")}$)`);

/**
 * The signed-in account control in either style: Classic's bar holds the sign-out command itself; Console's bar
 * holds the account menu, whose trigger is named after the person, so it is the collapsed button of a bar with no
 * sign-out, other than the module overflow. A signed-out page has no bar.
 */
export function accountControl(page: Page) {
  return page.getByRole("banner").getByRole("button", signOutName).or(accountMenuTrigger(page));
}

/** Console's account menu trigger, named after the person: the collapsed button of a bar with no sign-out, other than the module overflow. */
const accountMenuTrigger = (page: Page) =>
  page.getByRole("banner").filter({ hasNot: page.getByRole("button", signOutName) }).getByRole("button", { expanded: false, name: notOverflow });

/** The bar's entry named after the signed-in person: Classic's link to My account, or Console's account menu trigger. */
export const accountEntry = (page: Page) => page.getByRole("banner").locator('a[href="/account"]').or(accountMenuTrigger(page));

/** Opens My account from the bar: Classic's link does it in one press, Console's account menu and its link in two. */
export async function openAccount(page: Page, click: (target: Locator) => Promise<void> = target => target.click()) {
  const onAccount = () => new URL(page.url()).pathname === "/account";
  const menuLink = page.getByRole("banner").getByRole("link", { name: whole("shell.account") });
  await click(accountEntry(page));
  await expect.poll(async () => onAccount() || await menuLink.isVisible()).toBe(true);
  if (!onAccount()) await click(menuLink);
  await expect(page).toHaveURL(/\/account$/);
}

/** A session that ends in use keeps its screen, bar included, under the sign-in-again dialog, which only makes it inert. */
export async function expectSignedIn(page: Page, options?: { timeout?: number }) {
  await expect(accountControl(page)).toBeVisible(options);
  await expect(page.getByRole("dialog", { name: whole("idle.reauth.title") })).toBeHidden();
}

/** A control of the bar in either style: Classic's bar shows it, Console's keeps it in the account menu, opened when it is not shown. */
export async function barControl(page: Page, control: (bar: Locator) => Locator) {
  const target = control(page.getByRole("banner"));
  await expectSignedIn(page);
  if (!(await target.isVisible())) await accountMenuTrigger(page).click();
  return target;
}

/** Signs out from the bar: Classic offers the command there, Console inside the account menu. */
export async function signOut(page: Page) {
  await (await barControl(page, bar => bar.getByRole("button", signOutName))).click();
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

/** Sets the colour theme from the chrome: The toggle is named for the theme it turns to. */
export async function setTheme(page: Page, theme: "light" | "dark") {
  const html = page.locator("html");
  const { words } = await chrome(page);
  if ((await html.getAttribute("data-theme")) !== theme) {
    const name = words[theme === "dark" ? "shell.theme.toDark" : "shell.theme.toLight"];
    await (await barControl(page, bar => bar.getByRole("button", { name, exact: true }))).click();
  }
  await expect(html).toHaveAttribute("data-theme", theme);
}

/** Sets the language from the chrome: Both styles use the language select. */
export async function setLocale(page: Page, locale: "ko" | "en") {
  const html = page.locator("html");
  const { words } = await chrome(page);
  if ((await html.getAttribute("lang")) !== locale) {
    await (await barControl(page, bar => bar.getByRole("combobox", { name: words["shell.locale"], exact: true }))).selectOption(locale);
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
