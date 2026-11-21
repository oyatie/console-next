// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { failure, inbox, user } from "./fixtures";
import { fits, expectAxe } from "../a11y";
import { screens } from "../states/registry";
import { floorOf } from "../../apps/web/src/ui/experience-floors";

test.beforeAll(() => loadCatalog("ko"));
// First-paint cases own their preferences, independently of the selected test pack.
test.use({ storageState: { cookies: [], origins: [] } });

// The built entry chunk: nothing of the app has run until this script does.
const ENTRY = /\/assets\/index-[^/]+\.js$/;

async function expectRenderedFloors(page: Page, floor: { text: number; control: number }) {
  const sizes = await page.evaluate(least => {
    const root = document.documentElement;
    const experience = root.dataset.experience!;
    const controls = [...document.querySelectorAll<HTMLElement>('header button, header .btn, header input, header select, main button, main .btn, main input:not([type="hidden"]), main select, main [role="tab"], [role="dialog"] button, [role="dialog"] .check input')].filter(el => el.checkVisibility());
    const heights = () => controls.map(el => el.getBoundingClientRect().height);
    const actual = heights();
    delete root.dataset.experience;
    const baseline = heights();
    root.dataset.experience = experience;
    return {
      // Existing status chips and inline editors are below the floor on baseline; an experience must never shrink them.
      controls: controls.map((el, i) => ({ name: el.getAttribute("aria-label") || el.textContent?.trim() || el.outerHTML, height: actual[i]!, floor: Math.min(least, baseline[i]!) })),
      // <small> already renders below the floor on baseline; leave its repair to the shared typography.
      text: [...document.querySelectorAll<HTMLElement>('header *, main *, [role="dialog"] *')].filter(el => el.checkVisibility() && !el.closest("small") && [...el.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())).map(el => ({ text: el.textContent?.trim(), size: parseFloat(getComputedStyle(el).fontSize) })),
    };
  }, floor.control);
  expect(sizes.controls.length).toBeGreaterThan(0);
  expect.soft(sizes.controls.filter(control => control.height + 0.01 < control.floor), "rendered control heights").toEqual([]);
  // Icon-only phone controls hide their accessible text at 0px.
  expect.soft(sizes.text.filter(text => text.size > 0 && text.size < floor.text), "rendered text sizes").toEqual([]);
}

/** Records every write of data-theme on <html> from the first script of the page on, same value or not. */
async function themeWrites(page: Page) {
  await page.addInitScript(() => {
    const writes: (string | null)[] = [];
    Object.assign(window, { themeWrites: writes });
    new MutationObserver(records => records.forEach(record => writes.push((record.target as Element).getAttribute("data-theme"))))
      .observe(document, { attributes: true, attributeFilter: ["data-theme"], subtree: true });
  });
  return () => page.evaluate(() => (window as unknown as { themeWrites: (string | null)[] }).themeWrites);
}

async function signIn(page: Page, stored: Record<string, string>) {
  const fixture = await mockScreen(page, screens[0], "populated");
  await mockRoute(page, "post", "/api/v1/auth/passkey/login/start", { status: 403, json: failure("forbidden") });
  await page.addInitScript(values => Object.entries(values).forEach(([key, value]) => localStorage.setItem(key, value)), stored);
  return fixture;
}

// What is stored, what the system prefers, and the theme sign-in begins with: a stored theme wins, anything else follows the system.
const starts = [
  ["a stored dark theme on a light system", { "console.theme": "dark" }, "light", "dark"],
  ["a dark system when no known theme is stored", { "console.theme": "midnight", "console.experience": "calm" }, "dark", "dark"],
  ["a light system when no known theme is stored", { "console.theme": "midnight", "console.experience": "calm" }, "light", "light"],
] as const;

for (const [from, stored, system, theme] of starts) test(`sign-in is ${theme} from ${from} before the app's bundle runs, and stays ${theme} when it has`, async ({ page }) => {
  await page.emulateMedia({ colorScheme: system });
  const fixture = await signIn(page, stored);
  const writes = await themeWrites(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(ENTRY, async route => { await held; await route.continue(); });
  const entry = page.waitForRequest(ENTRY);
  await page.goto("/login", { waitUntil: "commit" });
  await entry;
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", theme);
  await expect(page.locator("#root")).toBeEmpty();

  release();
  await expect(page.getByRole("heading", { name: t("auth.login.title"), exact: true })).toBeVisible();
  await expect(html).toHaveAttribute("data-theme", theme);
  // An unknown experience never applies.
  await expect(html).not.toHaveAttribute("data-experience");
  expect(await writes()).toEqual([theme]);
  expect(fixture.unexpected).toEqual([]);
});

for (const from of ["a stored theme", "the system"] as const) test(`the shell keeps the theme the page began with from ${from}, writes it only on a change, and stores the change`, async ({ page }) => {
  const fixture = await mockScreen(page, screens[1], "populated");
  if (from === "the system") await page.emulateMedia({ colorScheme: "dark" });
  else await page.addInitScript(() => localStorage.setItem("console.theme", "dark"));
  const writes = await themeWrites(page);
  await page.goto("/people");
  // The shell's own switch: it has mounted, and it holds the theme the page began with.
  const toLight = page.getByRole("button", { name: t("shell.theme.toLight"), exact: true });
  await expect(toLight).toBeVisible();
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "dark");
  expect(await writes()).toEqual(["dark"]);

  await toLight.click();
  await expect(html).toHaveAttribute("data-theme", "light");
  expect(await writes()).toEqual(["dark", "light"]);
  expect(await page.evaluate(() => localStorage.getItem("console.theme"))).toBe("light");
  expect(fixture.unexpected).toEqual([]);
});

// Pin the role values so the browser proves both boot registration and entry CSS delivery.
const experiences = [
  ["warm-clear", "#f6f1e9", "#1d1914", "#17694f", "#82d6b4"],
  ["console", "#e9edf1", "#101820", "#0b6672", "#6fd3df"],
] as const;

for (const [experience, light, dark, primaryLight, primaryDark] of experiences) for (const theme of ["light", "dark"] as const) {
  for (const width of [390, 360]) test(`${experience} ${theme} phone toolbar fits a four-digit task count at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(values => {
      localStorage.setItem("console.experience", values.experience);
      localStorage.setItem("console.theme", values.theme);
    }, { experience, theme });
    const fixture = await mockScreen(page, screens.find(screen => screen.key === "people")!, "populated");
    const queue = { ...inbox(1), counts: { turn: { total: 9999, total_is_exact: true } } };
    await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: queue });
    await page.goto("/people");
    if (experience === "console") {
      const phoneNav = page.getByRole("navigation", { name: t("shell.nav"), exact: true });
      await expect(phoneNav.locator('data[value="9999"]')).toHaveText(fmtNumber(9999), { timeout: 20_000 });
      await expect(page.getByRole("banner")).toBeVisible();
      const bannerControls = await page.getByRole("banner").locator("button, a, select").evaluateAll(els => els.filter(el => el.checkVisibility()).map(el => ({ name: el.getAttribute("aria-label") || el.textContent, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right })));
      const navControls = await phoneNav.locator("button, a, select").evaluateAll(els => els.filter(el => el.checkVisibility()).map(el => ({ name: el.getAttribute("aria-label") || el.textContent, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right })));
      expect([...bannerControls, ...navControls].filter(control => control.left < 0 || control.right > width)).toEqual([]);
    } else {
      await expect(page.locator("header [data-count]")).toHaveText("9999", { timeout: 20_000 });
      const controls = await page.getByRole("banner").locator("button, a, select").evaluateAll(els => els.filter(el => el.checkVisibility()).map(el => ({ name: el.getAttribute("aria-label") || el.textContent, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right })));
      expect(controls.filter(control => control.left < 0 || control.right > width)).toEqual([]);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(fixture.unexpected).toEqual([]);
  });

  test(`${experience} ${theme} tokens arrive before the bundle`, async ({ page }) => {
    const fixture = await signIn(page, { "console.experience": experience, "console.theme": theme });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route(ENTRY, async route => { await held; await route.continue(); });
    const entry = page.waitForRequest(ENTRY);
    await page.goto("/login", { waitUntil: "commit" });
    await entry;
    try {
      await expect(page.locator("html")).toHaveAttribute("data-experience", experience);
      await expect(page.locator("#root")).toBeEmpty();
      await expect.poll(() => page.locator("html").evaluate(el => getComputedStyle(el).getPropertyValue("--canvas").trim())).toBe(theme === "light" ? light : dark);
    } finally {
      release();
    }
    await expect(page.getByRole("heading", { name: t("auth.login.title"), exact: true })).toBeVisible();
    expect(fixture.unexpected).toEqual([]);
  });

  for (const screen of screens.slice(0, 2)) for (const width of [1440, 390]) {
    test(`${experience} ${theme} ${screen.key} at ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(values => {
        localStorage.setItem("console.experience", values.experience);
        localStorage.setItem("console.theme", values.theme);
      }, { experience, theme });
      const fixture = await mockScreen(page, screen, "populated");
      await page.goto(screen.path);
      const main = page.getByRole("main");
      await expect(main.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 20_000 });
      await expect(main.locator('[aria-busy="true"]')).toHaveCount(0);
      await expect(main.getByText(screen.key === "people" ? "UI-0001" : inbox(1).items[0]!.title, { exact: screen.key === "people" }).first()).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-experience", experience);
      const tokens = await page.locator("html").evaluate(el => {
        const css = getComputedStyle(el);
        return ["--canvas", "--primary"].map(name => css.getPropertyValue(name).trim());
      });
      expect(tokens).toEqual(theme === "light" ? [light, primaryLight] : [dark, primaryDark]);
      await expectRenderedFloors(page, floorOf(experience, width === 390 ? "phone" : "desk"));
      const banner = await page.getByRole("banner").boundingBox();
      if (experience === "console") {
        const accountBtn = page.getByRole("banner").getByRole("button", { name: user.display_name, exact: true });
        await expect(accountBtn).toBeVisible();
        const accountBox = await accountBtn.boundingBox();
        expect(accountBox!.y).toBeGreaterThanOrEqual(banner!.y);
        expect(accountBox!.y + accountBox!.height).toBeLessThanOrEqual(banner!.y + banner!.height);
        await accountBtn.click();
        const accountMenu = page.getByRole("group", { name: t("shell.account"), exact: true });
        await expect(accountMenu).toBeVisible();
        for (const key of ["shell.locale.ko", "shell.locale.en", "shell.theme.light", "shell.theme.dark", "shell.logout"] as const) {
          await expect(accountMenu.getByRole("button", { name: t(key), exact: true })).toBeVisible();
        }
        await page.keyboard.press("Escape");
        await expect(accountMenu).toBeHidden();
      } else {
        const locale = await page.getByRole("combobox", { name: t("shell.locale"), exact: true }).boundingBox();
        expect(locale!.y).toBeGreaterThanOrEqual(banner!.y);
        expect(locale!.y + locale!.height).toBeLessThanOrEqual(banner!.y + banner!.height);
      }
      if (screen.key === "people") {
        const find = await main.getByRole("searchbox", { name: t("people.find.placeholder"), exact: true }).boundingBox();
        expect(find!.x).toBeGreaterThanOrEqual(0);
        expect(find!.x + find!.width).toBeLessThanOrEqual(width);
      }
      await fits(page, `${experience}/${theme}/${screen.key}/${width}`);
      await expectAxe(page, `${experience}/${theme}/${screen.key}/${width}`);
      await info.attach(`${experience}-${theme}-${screen.key}-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      if (screen.key === "people") {
        await page.getByRole("button", { name: t("people.tools.columns"), exact: true }).click();
        await expect(page.getByRole("dialog", { name: t("roster.columns.title"), exact: true }).locator(".check input").first()).toBeVisible();
        await expectRenderedFloors(page, floorOf(experience, width === 390 ? "phone" : "desk"));
      }
      expect(fixture.unexpected).toEqual([]);
    });
  }
}
