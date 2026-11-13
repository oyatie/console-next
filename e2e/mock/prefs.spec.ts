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
  // No experience is known, so a stored id is never applied.
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
