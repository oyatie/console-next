// SPDX-License-Identifier: LicenseRef-Proprietary
import { browserTestOptimizeDeps } from "../../../lib/browser-test";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { chromium, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

const [browserFixtureUrl] = Object.values(import.meta.glob<string>("./structure-members.browser-fixture.tsx", { query: "?url", import: "default", eager: true }));

const UNIT = "00000000-0000-0000-0000-000000000001";
const currentOrgUnit = { members: { headcount: 0, items: [{ employeeId: "e1", name: "김예시" }] } };
const currentEmployees = {
  items: [{ id: "e1", name: "김예시", status: "PRE_HIRE", employee_number: "E-001", org_unit_id: UNIT }],
  total: 1, limit: 100, offset: 0, next_cursor: null,
};

describe("directory retry in a browser", () => {
  let server: ViteDevServer;
  let browser: Browser;
  let page: Page;
  let directoryStatus: number;
  let reads: number;
  beforeAll(async () => {
    server = await createServer({
      configFile: false,
      cacheDir: ".cache/vite-members-test",
      optimizeDeps: { ...browserTestOptimizeDeps, entries: ["apps/web/src/reference/org/ui/structure-members.browser-fixture.tsx"] },
      server: { host: "127.0.0.1", port: 0, fs: { allow: [process.cwd(), dirname(realpathSync("node_modules/pretendard"))] } },
    });
    await server.listen();
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.route("**/members-test", (route) => route.fulfill({
      contentType: "text/html",
      body: `<div id="root"></div><script type="module" src="${browserFixtureUrl}"></script>`,
    }));
    await page.route("**/api/v1/org-structure/units/*/members*", (route) => route.fulfill({ json: currentOrgUnit.members }));
    await page.route("**/api/v1/employees?*", (route) => {
      reads++;
      const query = new URL(route.request().url()).searchParams;
      expect(query.get("org_unit_id")).toBe(UNIT);
      expect(query.get("status")).toBe("PRE_HIRE");
      return route.fulfill({
        status: directoryStatus,
        json: directoryStatus === 200
          ? { ...currentEmployees, items: currentEmployees!.items.slice(0, 1), total: 1 }
          : { code: directoryStatus === 403 ? "forbidden" : "unavailable" },
      });
    });
    await mount();
  }, 60_000);
  afterAll(async () => { await browser?.close(); await server?.close(); });

  async function mount() {
    directoryStatus = 200;
    reads = 0;
    await page.goto(`${server.resolvedUrls!.local[0]}members-test`);
    await browserExpect(page.getByText("입사 예정 1명", { exact: true })).toBeVisible();
  }
  beforeEach(mount, 60_000);

  test.each([403, 503])("visible counts recover after a cached %s refusal by clicking the rendered retry button", async (status) => {
    const count = page.getByText("입사 예정 1명", { exact: true });
    const member = page.getByRole("listitem");
    await browserExpect(page.getByRole("heading", { name: "사업장 직속 0명" })).toBeVisible();
    await browserExpect(member.getByText("입사 예정", { exact: true })).toBeVisible();
    await browserExpect(count).toBeVisible();
    expect(reads).toBe(1);

    directoryStatus = status;
    await page.getByRole("button", { name: "Refresh directory" }).click();
    await browserExpect(page.getByRole("status")).toContainText("입사 예정 인원을 불러오지 못했습니다");
    await browserExpect(count).toHaveCount(0);
    await browserExpect(member).toContainText("김예시");
    await browserExpect(member.getByText("입사 예정", { exact: true })).toHaveCount(0);
    expect(reads).toBe(2);

    directoryStatus = 200;
    const retry = page.getByRole("button", { name: "다시 불러오기" });
    await browserExpect(retry).toBeEnabled();
    await retry.click();
    await browserExpect(member.getByText("입사 예정", { exact: true })).toBeVisible();
    await browserExpect(count).toBeVisible();
    await browserExpect(page.getByRole("status")).toHaveCount(0);
    expect(reads).toBe(3);
  });
});
