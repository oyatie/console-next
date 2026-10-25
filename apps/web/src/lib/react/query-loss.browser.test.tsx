// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { chromium, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

const [fixture] = Object.values(import.meta.glob<string>("./query-loss.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
let server: ViteDevServer;
let browser: Browser;
let page: Page;
let refetchPage: Page;
let gatePage: Page;
let responseStatus = 200;
beforeAll(async () => {
  server = await createServer({
    configFile: false, cacheDir: ".cache/vite-query-loss-test",
    optimizeDeps: { entries: ["apps/web/src/lib/react/query-loss.browser-fixture.tsx"], include: ["react", "react/jsx-dev-runtime", "react-dom/client", "@tanstack/react-query", "@tanstack/react-router", "intl-messageformat", "lucide-react", "openapi-fetch", "react-aria-components"] },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [process.cwd(), dirname(realpathSync("node_modules/pretendard"))] } },
  });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  refetchPage = await browser.newPage();
  gatePage = await browser.newPage();
  await page.route("**/query-loss-test", route => route.fulfill({ contentType: "text/html", body: `<div id="root"></div><script type="module" src="${fixture}"></script>` }));
  await page.route("**/api/v1/org-changes/record", route => route.fulfill({
    status: responseStatus,
    json: responseStatus === 200 ? { reason: "saved record" } : { error: { code: responseStatus === 404 ? "not_found" : "forbidden", message: "lost" } },
  }));
  await page.goto(`${server.resolvedUrls!.local[0]}query-loss-test`, { waitUntil: "networkidle" });
  await page.getByLabel("사유").waitFor();
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test.each([403, 404])("a real %s refetch keeps the mounted editor and typed draft, then recovers", async status => {
  responseStatus = 200;
  await page.reload();
  const draft = page.getByLabel("사유");
  await draft.fill("unsaved local draft");
  const mountedEditor = await draft.elementHandle();
  responseStatus = status;
  await page.getByRole("button", { name: "다시 불러오기", exact: true }).click();
  await browserExpect(page.getByRole("status")).toContainText(status === 404 ? "이 항목이 삭제되어" : "이 항목을 볼 권한이 없어졌습니다", { timeout: 2000 });
  await browserExpect(draft).toHaveValue("unsaved local draft");
  expect(await mountedEditor!.evaluate(el => el.isConnected)).toBe(true);
  expect(await draft.evaluate(el => Boolean(el.closest("[inert]")))).toBe(true);
  responseStatus = 200;
  await page.getByRole("button", { name: "다시 불러오기", exact: true }).click();
  await browserExpect(page.getByRole("status")).toHaveCount(0);
  await browserExpect(draft).toHaveValue("unsaved local draft");
  await draft.fill("draft after recovery");
  expect(await mountedEditor!.evaluate(el => el.isConnected)).toBe(true);
}, 30_000);


test("Chromium: a changed read keeps the mounted draft and focus through pending and failure", async () => {
  const testPage = refetchPage;
  let hold = false;
  let status = 200;
  let release!: () => void;
  const wait = new Promise<void>(done => { release = done; });
  await testPage.route("**/query-loss-test", route => route.fulfill({ contentType: "text/html", body: `<div id="root"></div><script type="module" src="${fixture}"></script>` }));
  await testPage.route("**/api/v1/org-changes/record", async route => {
    if (hold) await wait;
    await route.fulfill(status !== 200 ? { status, json: { error: { code: "service_unavailable", message: "unavailable" } } } : { json: { reason: "saved record" } });
  });
  try {
    await testPage.goto(`${server.resolvedUrls!.local[0]}query-loss-test`);
    const draft = testPage.getByLabel("사유");
    await draft.fill("unsaved local draft");
    const mounted = await draft.elementHandle();
    hold = true;
    status = 503;
    const control = testPage.getByRole("button", { name: "돌아가기", exact: true });
    await control.focus();
    await control.press("Enter");
    await browserExpect(testPage.locator('[aria-busy="true"]')).toBeVisible();
    await browserExpect(control).toBeFocused();
    await browserExpect(draft).toHaveValue("unsaved local draft");
    release();
    await browserExpect(testPage.getByRole("status")).toContainText("마지막으로 불러온 내용", { timeout: 2000 });
    await browserExpect(control).toBeFocused();
    await browserExpect(draft).toHaveValue("unsaved local draft");
    expect(await mounted!.evaluate(el => el.isConnected)).toBe(true);
    await browserExpect(testPage.locator("[data-read-layout]")).toHaveCount(0);
    await testPage.context().setOffline(true);
    await browserExpect(testPage.getByRole("status")).toContainText("오프라인");
    await browserExpect(draft).toHaveValue("unsaved local draft");
    expect(await mounted!.evaluate(el => el.isConnected)).toBe(true);
    await testPage.context().setOffline(false);
    hold = false; status = 200;
    await testPage.getByRole("button", { name: "다시 불러오기", exact: true }).first().click();
    await browserExpect(testPage.getByRole("status")).toHaveCount(0);
    await browserExpect(draft).toHaveValue("unsaved local draft");
    expect(await mounted!.evaluate(el => el.isConnected)).toBe(true);
    status = 403;
    await control.press("Enter");
    await browserExpect(testPage.getByRole("region", { name: "이 화면에 접근 권한이 없습니다" })).toBeVisible();
    await browserExpect(draft).toHaveCount(0);
    status = 503;
    await control.press("Enter");
    await browserExpect(testPage.getByText("불러오지 못했습니다", { exact: true })).toBeVisible();
    await browserExpect(draft).toHaveCount(0);
  } finally { release(); await testPage.close(); }
}, 30_000);

test.each([403, 404])("page gate %s suppresses cached facts and controls through a changed read until a fresh answer", async refused => {
  const p = gatePage;
  let status = 200;
  let hold = false;
  let release!: () => void;
  const wait = new Promise<void>(done => { release = done; });
  await p.route("**/query-loss-test?page-gate", route => route.fulfill({ contentType: "text/html", body: `<div id="root"></div><script type="module" src="${fixture}"></script>` }));
  await p.route("**/api/v1/org-changes/record", async route => {
    if (hold) await wait;
    await route.fulfill({ status, json: status === 200 ? { reason: "saved record" } : { error: { code: "forbidden" } } });
  });
  try {
    await p.goto(`${server.resolvedUrls!.local[0]}query-loss-test?page-gate`);
    await browserExpect(p.getByLabel("사유")).toBeVisible();
    status = refused;
    await p.getByRole("button", { name: "다시 불러오기", exact: true }).click();
    await browserExpect(p.getByLabel("사유")).toHaveCount(0);
    const change = p.getByRole("button", { name: "돌아가기", exact: true });
    hold = true;
    await change.click();
    await browserExpect(p.getByText(refused === 403 ? "이 화면에 접근 권한이 없습니다" : "기록을 찾을 수 없습니다", { exact: true })).toBeVisible();
    await browserExpect(p.getByLabel("사유")).toHaveCount(0);
    status = 503; release();
    await browserExpect(p.getByText("불러오지 못했습니다", { exact: true })).toBeVisible();
    await browserExpect(p.getByLabel("사유")).toHaveCount(0);
    hold = false; status = 200;
    await change.click();
    await browserExpect(p.getByLabel("사유")).toHaveValue("saved record");
  } finally { release(); await p.unrouteAll({ behavior: "wait" }); }
}, 30_000);
