// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { chromium, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { browserTestOptimizeDeps } from "../../../lib/browser-test";
import { employees, failure, id } from "../../../../../../e2e/mock/fixtures";

const [fixture] = Object.values(import.meta.glob<string>("./dept-details.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));
let server: ViteDevServer, browser: Browser, page: Page;
beforeAll(async () => {
  server = await createServer({ configFile: false, cacheDir: ".cache/vite-dept-details-test", optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/features/org/ui/dept-details.browser-fixture.tsx"] }, server: { host: "127.0.0.1", port: 0, fs: { allow: [process.cwd(), dirname(realpathSync("node_modules/pretendard"))] } } });
  await server.listen();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("**/dept-details-test*", route => route.fulfill({ contentType: "text/html", body: `<div id="root"></div><script type="module" src="${fixture}"></script>` }));
  await page.route("**/api/v1/employees?*", route => route.fulfill({ json: { items: employees(1).map(p => ({ ...p, org_unit_id: id(100), name: "김부서장" })), total: 1, limit: 20, offset: 0, next_cursor: null } }));
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

test.each([200, 403, 409])("head appointment focuses the picker, preserves code/version, and handles %s", async status => {
  let body: unknown;
  await page.route("**/api/v1/org-structure/units/*/details", async route => {
    body = route.request().postDataJSON();
    expect(route.request().headers()["idempotency-key"]).toBeTruthy();
    await route.fulfill({ status, json: status === 200 ? { id: id(100), version: 8, batch_id: id(9), change_mode: "GOVERNED" } : failure(status === 403 ? "forbidden" : "stale_revision") });
  });
  await page.goto(`${server.resolvedUrls!.local[0]}dept-details-test`);
  const picker = page.getByRole("combobox", { name: "부서장", exact: true });
  await browserExpect(picker).toBeFocused();
  await browserExpect(page.getByRole("textbox", { name: /부서 코드/ })).toHaveCount(0);
  await picker.press("ArrowDown");
  await page.getByRole("option", { name: /김부서장/ }).click();
  await browserExpect(page.getByText(/오늘\(.+\)부터 부서장으로 기록됩니다/)).toBeVisible();
  await page.getByRole("button", { name: "부서장 지정", exact: true }).click();
  if (status === 200) await browserExpect(page.getByRole("status")).toContainText("저장했습니다");
  else {
    await browserExpect(page.getByRole("alert")).toBeVisible();
    await browserExpect(page.getByRole("link", { name: /김부서장/ })).toBeVisible();
    await browserExpect(page.getByRole("status").filter({ hasText: "저장했습니다" })).toHaveCount(0);
  }
  expect(body).toEqual({ expected_version: 7, code: "QA-1", head_employee_id: id(100) });
});

test("the existing details form still edits a code without appointing a head", async () => {
  let body: unknown;
  await page.route("**/api/v1/org-structure/units/*/details", async route => {
    body = route.request().postDataJSON();
    await route.fulfill({ json: { id: id(100), version: 8, batch_id: id(9), change_mode: "GOVERNED" } });
  });
  await page.goto(`${server.resolvedUrls!.local[0]}dept-details-test?mode=details`);
  await page.getByRole("textbox", { name: /부서 코드/ }).fill("QA-2");
  await page.getByRole("button", { name: "부서 정보 1개 변경", exact: true }).click();
  await browserExpect(page.getByRole("status")).toContainText("저장했습니다");
  expect(body).toEqual({ expected_version: 7, code: "QA-2", head_employee_id: null });
});
