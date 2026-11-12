// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
import { failure } from "./fixtures";
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

test("sign-in is dark from a stored dark theme before the app's bundle runs, and stays dark when it has", async ({ page }) => {
  const fixture = await signIn(page, { "console.theme": "dark" });
  const writes = await themeWrites(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(ENTRY, async route => { await held; await route.continue(); });
  const entry = page.waitForRequest(ENTRY);
  await page.goto("/login", { waitUntil: "commit" });
  await entry;
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("#root")).toBeEmpty();

  release();
  await expect(page.getByRole("heading", { name: t("auth.login.title"), exact: true })).toBeVisible();
  await expect(html).toHaveAttribute("data-theme", "dark");
  expect(await writes()).toEqual(["dark"]);
  expect(fixture.unexpected).toEqual([]);
});

test("a stored value that is no known theme or experience sets nothing on sign-in", async ({ page }) => {
  const fixture = await signIn(page, { "console.theme": "midnight", "console.experience": "calm" });
  const writes = await themeWrites(page);
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: t("auth.login.title"), exact: true })).toBeVisible();
  const html = page.locator("html");
  await expect(html).not.toHaveAttribute("data-theme");
  await expect(html).not.toHaveAttribute("data-experience");
  expect(await writes()).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("the shell keeps the theme the page began with, writes it only on a change, and stores the change", async ({ page }) => {
  const fixture = await mockScreen(page, screens[1], "populated");
  await page.addInitScript(() => localStorage.setItem("console.theme", "dark"));
  const writes = await themeWrites(page);
  await page.goto("/people");
  // The shell's own switch: it has mounted, and it holds the stored theme.
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
