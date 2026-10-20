// SPDX-License-Identifier: LicenseRef-Proprietary
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, expect } from "vitest";
import { chromium, type Browser, type Locator, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import type { ComposerCase } from "./composer.fixture";

/** Real Sheets and DOM events; only the API transport uses synthetic fixtures. */
export function composerBrowser() {
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  let cache: string | undefined;
  let page: Page;
  const writes: string[] = [];
  const errors: string[] = [];
  beforeAll(async () => {
    cache = await mkdtemp(join(tmpdir(), "composer-vite-"));
    server = await createServer({
      configFile: false, cacheDir: cache,
      // Browser dependencies must use their DOM implementation, not Vitest's Node environment.
      define: { "process.env.NODE_ENV": '"development"' },
      optimizeDeps: { include: ["react", "react-dom", "react-dom/client", "react/jsx-dev-runtime", "@tanstack/react-query", "@tanstack/react-router", "intl-messageformat", "lucide-react", "openapi-fetch", "react-aria-components"] },
      server: { host: "127.0.0.1", port: 0 },
      plugins: [{ name: "composer-fixture", configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== "/") return next();
          res.setHeader("Content-Type", "text/html");
          void vite.transformIndexHtml("/", '<div id="root"></div><script type="module" src="/apps/web/src/test/composer.fixture.tsx"></script>').then((html) => res.end(html)).catch(next);
        });
      } }],
    });
    await server.listen();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (!path.startsWith("/api/")) return route.continue();
      if (request.method() !== "GET") {
        writes.push(`${request.method()} ${path}`);
        return route.fulfill({ status: 422, json: { code: "validation_failed" } });
      }
      let body: unknown = { items: [], total: 0 };
      if (path === "/api/v1/users/me") body = { id: "test-admin", sign_in_id: "admin@example.test" };
      if (path === "/api/v1/employees") body = { items: [{ id: "test-person", name: "Test Person", employee_number: "TEST-1", status: "ACTIVE" }], total: 1 };
      if (path === "/api/v1/org/structure") body = { entities: [] };
      if (path === "/api/v1/reason-codes") body = { items: [{ code: "OTHER", active: true, system: true, requires_note: true }] };
      await route.fulfill({ json: body });
    });
    await page.goto(server.resolvedUrls!.local[0]!);
    await page.waitForFunction(() => typeof window.mountComposer === "function");
    page.setDefaultTimeout(1000);
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
    if (cache) await rm(cache, { recursive: true, force: true });
  });
  return {
    get page() { return page; },
    writes,
    async mount(value: ComposerCase) {
      writes.length = 0;
      await page.evaluate((next) => window.mountComposer(next), value);
      await page.locator(`[data-composer='${JSON.stringify(value)}']`).waitFor({ state: "attached" });
    },
    async blocked(button: Locator, reason?: string) {
      await button.waitFor();
      expect(await button.getAttribute("aria-disabled")).toBe("true");
      expect(await button.getAttribute("class")).toContain("btn--primary");
      expect(await button.getAttribute("disabled")).toBeNull();
      const id = await button.getAttribute("aria-describedby");
      expect(id).toBeTruthy();
      // DisabledReason places the visible explanation with the control, beyond the Sheet's consequence.
      const explanation = button.locator("..").locator(`[id="${id}"]`);
      expect(await explanation.count()).toBe(1);
      expect(await explanation.isVisible()).toBe(true);
      expect((await explanation.innerText()).trim()).not.toBe("");
      if (reason) expect(await explanation.innerText()).toBe(reason);
      await button.click({ force: true });
      await button.focus();
      await button.press("Enter");
      await button.focus();
      await button.press("Space");
      expect(await page.evaluate(() => window.composerCommits)).toBe(0);
      expect(writes).toEqual([]);
      expect(errors).toEqual([]);
    },
  };
}
