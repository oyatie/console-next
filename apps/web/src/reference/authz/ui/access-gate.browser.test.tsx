// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expect as browserExpect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps, chromium, type Browser, type Page } from "../../../lib/browser-test";

const [fixture] = Object.values(import.meta.glob<string>("../../../lib/react/access-gate.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
let server: ViteDevServer;
let browser: Browser;
const pages = new Map<string, Page>();
beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/vite-access-gate-test",
    optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/lib/react/access-gate.browser-fixture.tsx"] },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [process.cwd(), dirname(realpathSync("node_modules/pretendard"))] } },
  });
  await server.listen();
  browser = await chromium.launch();
  for (const path of ["/guarded", "/signed-in", "/tenant"]) pages.set(path, await browser.newPage());
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test.each(["/guarded", "/signed-in", "/tenant"])("%s: delayed access and page code keep the shell mounted", async path => {
  const page = pages.get(path)!;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  let releaseAccess!: () => void;
  let releasePage!: () => void;
  const accessWait = new Promise<void>(done => { releaseAccess = done; });
  const pageWait = new Promise<void>(done => { releasePage = done; });
  let accessReads = 0;
  let pageReads = 0;
  await page.route("**/guard-test**", route => route.fulfill({ contentType: "text/html", body: `<div id="root"></div><script type="module" src="${fixture}"></script>` }));
  await page.route("**/api/v1/access/me", async route => {
    accessReads++;
    await accessWait;
    await route.fulfill({ json: { is_ops: false, entries: [{ grant_id: "grant", domain: "org", level: "edit", enforcement: "ENFORCED", scope: { kind: "DEPARTMENT" } }] } });
  });
  await page.route("**/api/v1/access/granters", route => route.fulfill({ json: { count: 0, names: [] } }));
  await page.route("**/guard-page", async route => { pageReads++; await pageWait; await route.fulfill({ body: "" }); });
  try {
    await page.goto(`${server.resolvedUrls!.local[0]}guard-test?route=${path}`);
    const shell = page.getByRole("navigation", { name: "본문" });
    const loading = page.locator('[data-read-layout="list"]:visible');
    await browserExpect(shell).toBeVisible();
    const mounted = await shell.elementHandle();
    await browserExpect(loading).toBeVisible();
    expect(pageReads).toBe(path === "/signed-in" ? 1 : 0);
    releaseAccess();
    if (path === "/tenant") {
      await browserExpect(page.getByRole("region", { name: "이 화면에 접근 권한이 없습니다" })).toBeVisible();
      expect(pageReads).toBe(0);
    } else {
      await expect.poll(() => pageReads).toBe(1);
      await browserExpect(shell).toBeVisible();
      await browserExpect(loading).toBeVisible();
      releasePage();
      await browserExpect(page.getByRole("textbox", { name: "사유" })).toBeVisible();
    }
    expect(await mounted!.evaluate(el => el.isConnected)).toBe(true);
    if (path !== "/tenant") expect(accessReads).toBe(path === "/signed-in" ? 0 : 1);
    expect(errors).toEqual([]);
  } finally { releaseAccess(); releasePage(); await page.close(); expect(errors).toEqual([]); }
});
