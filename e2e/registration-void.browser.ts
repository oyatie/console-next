// SPDX-License-Identifier: LicenseRef-Proprietary
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, type Browser, type BrowserContext, type Page, type Request } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { fixtureUrl } from "./registration-void.fixture";

export const previewPath = "/api/v1/business-registrations/reg-1/end-options";
export const voidPath = "/api/v1/business-registrations/reg-1/void";
export const options = (over = {}) => ({
  id: "reg-1", phase: "SETUP", delete: { allowed: true, refusal: null },
  can_manage: true, revisions: 7, linked_workplaces: [], ...over,
});
export type Reply = { status?: number; json: unknown };

export function registrationVoidBrowser() {
  // Real React/React Aria controls in Chromium; only HTTP responses are substituted.
  let server: ViteDevServer;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let origin: string;
  let errors: string[];
  let unexpected: string[];
  let writes: Request[];
  let reads: string[];
  let preview: () => Promise<Reply>;
  let catalog: unknown[];
  let submit: () => Promise<Reply | { status: 204 }>;

  beforeAll(async () => {
    server = await createServer({
      root: resolve("apps/web"), configFile: resolve("apps/web/vite.config.ts"),
      cacheDir: resolve(".cache/vite-registration-void-test"),
      server: { host: "127.0.0.1", port: 0, strictPort: false, watch: null, hmr: false },
      plugins: [{
        name: "registration-void-test",
        configureServer(vite) {
          vite.middlewares.use("/__registration-void", (_req, res, next) => {
            void vite.transformIndexHtml("/__registration-void", `<!doctype html><html lang="ko"><body><div id="root"></div><script type="module" src="/@fs${fileURLToPath(fixtureUrl)}"></script></body></html>`)
              .then((html) => { res.setHeader("Content-Type", "text/html"); res.end(html); }, next);
          });
        },
      }],
    });
    await server.listen();
    origin = server.resolvedUrls!.local[0]!;
    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === "GET" && path === previewPath) {
        reads.push(path);
        await route.fulfill(await preview());
      } else if (request.method() === "GET" && path === "/api/v1/reason-codes") {
        expect(new URL(request.url()).searchParams.get("domain")).toBe("business_registration_end");
        await route.fulfill({ json: { items: catalog } });
      } else if (request.method() === "POST" && path === voidPath) {
        writes.push(request);
        await route.fulfill(await submit());
      } else {
        unexpected.push(`${request.method()} ${path}`);
        await route.fulfill({ status: 404 });
      }
    });
    // Pay cold transforms before the first test's 5 s interaction budget.
    reset();
    await mount();
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });
  function reset() {
    errors = []; unexpected = []; writes = []; reads = [];
    catalog = ["DUPLICATE", "TEST_ENTRY", "WRONG_DOCUMENT"].map((code) => ({ code, system: true, active: true, requires_note: false, involuntary: false, notice_required: false, label_ko: null, label_en: null }));
    preview = async () => ({ json: options() });
    submit = async () => ({ status: 204 });
  }
  beforeEach(async () => {
    await context.setOffline(false);
    await page.setViewportSize({ width: 1280, height: 720 });
    reset();
  }, 60_000);
  afterEach(async () => {
    // Unmount observers before the next test changes its response fixtures.
    await page.goto("about:blank");
    expect(errors).toEqual([]);
    expect(unexpected).toEqual([]);
  });

  const dialog = () => page.getByRole("dialog", { name: "사업자등록증 삭제", exact: true });
  const confirm = () => dialog().getByRole("button", { name: "사업자등록증 삭제", exact: true });
  async function open() {
    const more = page.getByRole("button", { name: /^사업자등록증(?: · 본점)? .+ 더보기$/ });
    expect(await more.count()).toBe(1);
    await more.click();
    await page.getByRole("menuitem", { name: "삭제", exact: true }).click();
    await expect(dialog()).toBeVisible();
  }
  async function choose(label = "중복 등록") {
    await page.getByRole("radiogroup", { name: /삭제 사유/ }).getByText(label, { exact: true }).click();
    await expect(page.getByRole("radio", { name: label, exact: true })).toBeChecked();
  }
  async function mount(query = "") {
    await page.goto(`${origin}__registration-void${query ? `?${query}` : ""}`);
    await expect(page.getByRole("heading", { name: "사업자등록증", exact: true }).first()).toBeVisible();
  }

  return {
    dialog, confirm, open, choose, mount,
    get page() { return page; },
    get context() { return context; },
    get writes() { return writes; },
    get reads() { return reads; },
    set preview(value: () => Promise<Reply>) { preview = value; },
    set submit(value: () => Promise<Reply | { status: 204 }>) { submit = value; },
    set catalog(value: unknown[]) { catalog = value; },
  };
}
