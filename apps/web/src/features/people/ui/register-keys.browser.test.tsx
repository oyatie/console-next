// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { expect as element } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { loadCatalog, t } from "@console/i18n";
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
    if (platform) Object.defineProperty(Navigator.prototype, "platform", { get: () => platform });
  });
  await page.route("**/register-keys-test*", route => route.fulfill({ contentType: "text/html", body: `<html lang="ko"><title>Register keys</title><div id="root"></div><script type="module" src="${fixture}"></script></html>` }));
  // The hints are drawn before any read lands; every read answers with nothing registered.
  await page.route("**/api/v1/**", route => route.fulfill({ json: { items: [], entities: [], total: 0, limit: 100, offset: 0, next_cursor: null } }));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

// Both chords take Command or Control; each hint names the key this system's keyboard has.
const SYSTEMS = [{ platform: "Win32", next: "Ctrl+↵", close: "Ctrl+Shift+↵" }, { platform: "MacIntel", next: "⌘↵", close: "⌘⇧↵" }];

test.each(SYSTEMS)("on $platform the registration sheet shows $next to register and go on, and $close to register and close", async ({ platform, next, close }) => {
  await page.goto(`${server.resolvedUrls!.local[0]}register-keys-test?case=sheet&platform=${platform}`);
  const sheet = page.getByRole("dialog", { name: t("register.title"), exact: true });
  await element(sheet.getByRole("button", { name: commitLabel({ kind: "ONBOARD", mode: "apply", count: 1, continuation: "next" }), exact: true }).locator("kbd")).toHaveText(next);
  await element(sheet.getByRole("button", { name: commitLabel({ kind: "ONBOARD", mode: "apply", count: 1 }), exact: true }).locator("kbd")).toHaveText(close);
});

test.each(SYSTEMS)("on $platform the run's entry row shows $next to save the row", async ({ platform, next }) => {
  await page.goto(`${server.resolvedUrls!.local[0]}register-keys-test?case=table&platform=${platform}`);
  await element(page.getByRole("button", { name: t("register.run.save"), exact: true }).locator("kbd")).toHaveText(next);
});
