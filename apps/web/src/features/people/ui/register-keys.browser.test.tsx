// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { i18n, loadCatalog, t } from "@console/i18n";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../../lib/browser-test";
import { commitLabel } from "../../../ui/composer/actions";

const [fixture] = Object.values(import.meta.glob<string>("./register-keys.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
let server: ViteDevServer;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  await loadCatalog("ko");
  server = await createServer({ configFile: false, cacheDir: ".cache/vite-register-keys-test", logLevel: "error",
    optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/features/people/ui/register-keys.browser-fixture.tsx"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [process.cwd(), dirname(realpathSync("node_modules/pretendard"))] } },
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  // A test names a system in the address, and the page then reports it as a browser on that system would.
  await page.addInitScript(() => {
    const platform = new URLSearchParams(location.search).get("platform");
    if (!platform) return;
    Object.defineProperty(navigator, "platform", { value: platform });
    // Chromium reports its own system here first, so the named one has to be the only one.
    Object.defineProperty(navigator, "userAgentData", { value: undefined });
  });
  await page.route("**/register-keys-test*", route => route.fulfill({ contentType: "text/html", body: `<html lang="ko"><title>Register keys</title><div id="root"></div><script type="module" src="${fixture}"></script></html>` }));
  // The hints are drawn before any read lands; every read answers with nothing registered.
  await page.route("**/api/v1/**", route => route.fulfill({ json: { items: [], entities: [], total: 0, limit: 100, offset: 0, next_cursor: null } }));
  // A registration is taken as sent.
  await page.route("**/api/v1/employees", route => route.request().method() === "POST"
    ? route.fulfill({ status: 201, json: { employee: { id: "e1", name: route.request().postDataJSON().name, employee_number: "1", updated_at: "2026-11-19T00:00:00Z" }, warnings: [] } })
    : route.fallback());
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

// Both chords take Command or Control; each hint names the key this system's keyboard has.
const SYSTEMS = [{ platform: "Win32", next: "Ctrl+↵", close: "Ctrl+⇧↵" }, { platform: "MacIntel", next: "⌘↵", close: "⌘⇧↵" }];

test.each(SYSTEMS)("on $platform the registration sheet shows $next to register and go on, and $close to register and close", async ({ platform, next, close }) => {
  await page.goto(`${server.resolvedUrls!.local[0]}register-keys-test?case=sheet&platform=${platform}`);
  const sheet = page.getByRole("dialog", { name: t("register.title"), exact: true });
  await element(sheet.getByRole("button", { name: commitLabel({ kind: "ONBOARD", mode: "apply", count: 1, continuation: "next" }), exact: true }).locator("kbd")).toHaveText(next);
  await element(sheet.getByRole("button", { name: commitLabel({ kind: "ONBOARD", mode: "apply", count: 1 }), exact: true }).locator("kbd")).toHaveText(close);
});

// The row's save column has no room for the wider cap: with it the table scrolls sideways at 1440 px. It keeps the cap it had.
test.each(SYSTEMS)("on $platform the run's entry row keeps the ⌘↵ cap and is named with the word it shows", async ({ platform }) => {
  await page.goto(`${server.resolvedUrls!.local[0]}register-keys-test?case=table&platform=${platform}`);
  const save = page.getByRole("button", { name: t("register.run.save"), exact: true });
  await element(save.locator("kbd")).toHaveText("⌘↵");
  // Speech input presses a control by the word on it; the test below checks the name holds this word in both catalogs.
  await element(save).toContainText(t("register.run.submit"));
});

test("in both catalogs the row save's name holds the word it shows", async () => {
  for (const lang of ["en", "ko"] as const) {
    await loadCatalog(lang);
    i18n.set(lang);
    expect(t("register.run.save"), lang).toContain(t("register.run.submit"));
  }
});

// The finish button shows once a person is in the run.
test.each(SYSTEMS)("on $platform the run page's finish button shows $close once a person is registered", async ({ platform, close }) => {
  await page.goto(`${server.resolvedUrls!.local[0]}register-keys-test?case=run&platform=${platform}`);
  await page.locator('[data-run="name"]').fill("Hong Gildong");
  await page.getByLabel(t("register.run.cell", { n: 1, field: t("register.run.col.hire") }), { exact: true }).fill("2026-11-19");
  await page.keyboard.press("Control+Enter");
  await element(page.getByRole("button", { name: t("register.run.finish"), exact: true }).locator("kbd")).toHaveText(close);
});

// The Console look draws its own register buttons; each names the key this system's keyboard has.
test.each(SYSTEMS)("Console look: on $platform the registration sheet's register button shows $next", async ({ platform, next }) => {
  await page.goto(`${server.resolvedUrls!.local[0]}register-keys-test?case=sheet&look=console&platform=${platform}`);
  const sheet = page.getByRole("dialog", { name: t("register.title"), exact: true });
  await element(sheet.getByRole("button", { name: t("register.run.submit"), exact: true }).locator("kbd")).toHaveText(next);
});

test.each(SYSTEMS)("Console look: on $platform the run page shows $next to register and $close to finish", async ({ platform, next, close }) => {
  await page.goto(`${server.resolvedUrls!.local[0]}register-keys-test?case=run&look=console&platform=${platform}`);
  await element(page.getByRole("button", { name: t("register.run.submit"), exact: true }).locator("kbd")).toHaveText(next);
  await page.locator('[data-run="name"]').fill("Hong Gildong");
  await page.getByLabel(t("register.run.cell", { n: 1, field: t("register.run.col.hire") }), { exact: true }).fill("2026-11-19");
  await page.keyboard.press("Control+Enter");
  const finish = page.getByRole("button", { name: t("register.run.finish"), exact: true });
  await element(finish).toHaveCount(2);
  for (const button of await finish.all()) await element(button.locator("kbd")).toHaveText(close);
});

// The Control caps are wider than the Command ones; each stays inside its button and the page does not scroll sideways.
test.each([390, 1440])("the wider caps fit their buttons at %ipx", async width => {
  await page.setViewportSize({ width, height: 900 });
  for (const at of ["case=sheet", "case=sheet&look=console", "case=run", "case=run&look=console"]) {
    await page.goto(`${server.resolvedUrls!.local[0]}register-keys-test?${at}&platform=Win32`);
    await page.locator('[data-run="name"], [role="dialog"] input').first().waitFor();
    if (at.startsWith("case=run")) {
      await page.locator('[data-run="name"]').fill("Hong Gildong");
      await page.getByLabel(t("register.run.cell", { n: 1, field: t("register.run.col.hire") }), { exact: true }).fill("2026-11-19");
      await page.keyboard.press("Control+Enter");
      await page.getByRole("button", { name: t("register.run.finish"), exact: true }).first().waitFor();
    }
    await page.locator("button kbd", { hasText: /^Ctrl/ }).first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    const caps = await page.locator("button:not([aria-label]) kbd").evaluateAll(kbds => kbds.filter(k => k.textContent!.startsWith("Ctrl")).map(k => {
      const cap = k.getBoundingClientRect();
      const button = k.closest("button")!.getBoundingClientRect();
      return cap.left >= button.left && cap.right <= button.right && cap.top >= button.top && cap.bottom <= button.bottom;
    }));
    expect(caps, at).not.toContain(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), at).toBe(true);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
});
