// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { failure, inbox } from "./fixtures";
import { fits, expectAxe } from "../a11y";
import { screens } from "../states/registry";

test.beforeAll(() => loadCatalog("ko"));

// The built entry chunk: nothing of the app has run until this script does.
const ENTRY = /\/assets\/index-[^/]+\.js$/;

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
  ["calm-ledger", "#faf9f6", "#14161a", "#1f2f5c", "#afc0f2"],
  ["quick-keys", "#fff", "#0e1013", "#2f45e8", "#a1adff"],
  ["warm-clear", "#f6f1e9", "#1d1914", "#17694f", "#82d6b4"],
  ["control-room", "#e9edf1", "#101820", "#0b6672", "#6fd3df"],
] as const;

for (const [experience, light, dark, primaryLight, primaryDark] of experiences) for (const theme of ["light", "dark"] as const) {
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
        return ["--canvas", "--primary", "--text-xs", "--text-sm", "--text-body", "--target", "--row-h-compact", "--control-h-sm"].map(name => css.getPropertyValue(name).trim());
      });
      expect(tokens.slice(0, 2)).toEqual(theme === "light" ? [light, primaryLight] : [dark, primaryDark]);
      for (const value of tokens.slice(2, 5)) expect(parseFloat(value)).toBeGreaterThanOrEqual(14);
      for (const value of tokens.slice(5)) expect(parseFloat(value)).toBeGreaterThanOrEqual(32);
      const locale = await page.getByRole("combobox", { name: t("shell.locale"), exact: true }).boundingBox();
      const banner = await page.getByRole("banner").boundingBox();
      expect(locale!.y).toBeGreaterThanOrEqual(banner!.y);
      expect(locale!.y + locale!.height).toBeLessThanOrEqual(banner!.y + banner!.height);
      await fits(page, `${experience}/${theme}/${screen.key}/${width}`);
      await expectAxe(page, `${experience}/${theme}/${screen.key}/${width}`);
      await info.attach(`${experience}-${theme}-${screen.key}-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      expect(fixture.unexpected).toEqual([]);
    });
  }
}
