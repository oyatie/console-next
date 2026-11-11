// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { mockScreen } from "../mock/screen";
import { mockOrgChangeCounts, type CountState } from "../mock/org-changes-web";
import { orgChangeScreens } from "./registry";
import { failure } from "../mock/fixtures";
import { mockRoute } from "../mock/route";

test.beforeAll(() => loadCatalog("ko"));

for (const path of ["/org/changes", "/org/history"]) test(`org counts use contracted reads on ${path} @ui-state`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const fixture = await mockScreen(page, orgChangeScreens[0], "empty");
  await mockRoute(page, "get", "/api/v1/org-structure/batches", { status: 200, json: { items: [] } });
  await mockRoute(page, "get", "/api/v1/entity-setup/batches", { status: 200, json: { items: [] } });
  const probes: string[] = [];
  await page.route(url => url.pathname === "/api/v1/org-changes/counts", async route => {
    probes.push(route.request().url());
    await route.fulfill({ status: 400, json: failure("bad_request") });
  });
  try {
    await page.goto(path);
    const tabs = page.getByRole("group", { name: t("orgChange.list.views") });
    await expect(tabs.getByRole("button", { name: "전체 0", exact: true })).toBeVisible();
    expect(probes, "the API has list totals, not a counts endpoint").toEqual([]);
    for (const theme of ["light", "dark"]) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      await fits(page, `${path}/${theme}`);
      await page.screenshot({ path: test.info().outputPath(`counts-${theme}.png`), fullPage: true });
    }
    await expectAxe(page, path);
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});
for (const state of ["loading", "failed", "counts-failed", "counts-loading", "populated"] as CountState[]) for (const width of [1440, 390]) {
  test(`org change counts: ${state} at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const screen = orgChangeScreens[0];
    const fixture = await mockScreen(page, screen, state === "loading" || state === "failed" ? state : "populated");
    const counts = await mockOrgChangeCounts(page, state);
    try {
      await page.goto(screen.path);
      const main = page.getByRole("main");
      const tabs = main.getByRole("group", { name: t("orgChange.list.views") });
      if (state === "failed" || state === "counts-failed") {
        await expect(tabs.locator('span[title]').first()).toHaveText("—", { timeout: 20_000 });
        await expect(main.getByRole("button", { name: t("common.retry"), exact: true })).toHaveCount(1);
        if (state === "failed") await expect(main.getByRole("alert")).toHaveCount(1);
      } else if (state === "loading" || state === "counts-loading") {
        await expect(tabs.locator('span[aria-hidden="true"]')).toHaveCount(6);
      } else {
        await expect(tabs.getByRole("button", { name: "전체 3", exact: true })).toBeVisible();
        expect(counts.requests).toHaveLength(7);
      }
      if (state !== "populated") await expect(tabs.getByRole("button").filter({ hasText: /\d/ })).toHaveCount(0);
      if (state === "loading" || state === "failed") {
        await expect(tabs.locator('button[aria-disabled="true"]')).toHaveCount(6);
        const first = tabs.getByRole("button").first();
        await first.focus();
        await expect(first).toBeFocused();
        await first.press("Enter");
        await expect(page).toHaveURL(/filter=all$/);
      } else {
        await expect(main.getByRole("link", { name: "OC-2026-0001", exact: true })).toBeVisible();
        await expect(tabs.locator('button[aria-disabled="true"]')).toHaveCount(0);
        if (state === "counts-failed") {
          await tabs.getByRole("button", { name: /^예정/ }).click();
          await expect(main.getByRole("link", { name: "OC-2026-0002", exact: true })).toBeVisible();
          await expect(main.getByRole("link", { name: "OC-2026-0001", exact: true })).toHaveCount(0);
        }
      }
      await fits(page, `org-counts/${state}/${width}`);
      await expectAxe(page, `org-counts/${state}/${width}`);
      if (state === "loading") {
        const loadingHeight = (await tabs.boundingBox())!.height;
        fixture.release();
        counts.release();
        await expect(main.getByRole("link", { name: "OC-2026-0001", exact: true })).toBeVisible();
        await expect(tabs.locator('button[aria-disabled="true"]')).toHaveCount(0);
        expect((await tabs.boundingBox())!.height, "the initial read must not resize the tab row").toBe(loadingHeight);
      }
      expect(fixture.unexpected).toEqual([]);
    } finally {
      counts.release();
      fixture.release();
      await page.close();
    }
  });
}

for (const width of [1440, 390]) test(`saved-view changes preserve the effective range and tab layout at ${width}px @ui-state`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const screen = orgChangeScreens[0];
  const fixture = await mockScreen(page, screen, "populated");
  const counts = await mockOrgChangeCounts(page, "populated");
  const listQueries: URL[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(url => url.pathname === screen.read, async route => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get("status") === "APPROVED" && query.get("limit") !== "1") await held;
    await route.fallback();
  });
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname === screen.read) listQueries.push(url);
  });
  try {
    await page.goto(`${screen.path}&effective_from=2026-11-01&effective_to=2026-11-30`);
    const tabs = page.getByRole("group", { name: t("orgChange.list.views") });
    await expect(tabs.getByRole("button", { name: "전체 3", exact: true })).toBeVisible();
    const height = (await tabs.boundingBox())!.height;
    await tabs.getByRole("button", { name: "예정 1", exact: true }).click();
    await expect(tabs.getByRole("button", { name: "예정 1", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect((await tabs.boundingBox())!.height, "the pending view must not resize the tab row").toBe(height);
    await expect(tabs.locator('button[aria-disabled="true"]')).toHaveCount(0);
    release();
    await expect(page.getByRole("link", { name: "OC-2026-0002", exact: true })).toBeVisible();
    expect((await tabs.boundingBox())!.height).toBe(height);
    expect(counts.requests).toHaveLength(7);
    for (const url of counts.requests) {
      expect(url.searchParams.get("effective_from")).toBe("2026-11-01");
      expect(url.searchParams.get("effective_to")).toBe("2026-11-30");
    }
    expect(listQueries.filter(url => url.searchParams.get("limit") === "1")).toHaveLength(7);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    release();
    fixture.release();
    counts.release();
    await page.close();
  }
});

for (const width of [1440, 390]) test(`a failed mine read leaves a failed open count and usable views at ${width}px @ui-state`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const screen = orgChangeScreens[0];
  const fixture = await mockScreen(page, screen, "populated");
  await page.route(url => url.pathname === screen.read, async route => {
    const query = new URL(route.request().url()).searchParams;
    if (query.has("drafted_by") && query.get("limit") !== "1") return route.fulfill({ status: 503, json: failure("service_unavailable") });
    await route.fallback();
  });
  try {
    await page.goto(screen.path);
    const tabs = page.getByRole("group", { name: t("orgChange.list.views") });
    const open = tabs.getByRole("button", { name: /^진행 중/ });
    await expect(open.locator("span[title]")).toHaveText("—", { timeout: 20_000 });
    await expect(tabs.locator('span[aria-hidden="true"]')).toHaveCount(0);
    await expect(tabs.locator('button[aria-disabled="true"]')).toHaveCount(0);
    await tabs.getByRole("button", { name: "예정 1", exact: true }).click();
    await expect(page.getByRole("link", { name: "OC-2026-0002", exact: true })).toBeVisible();
    await fits(page, `org-counts/mine-failed/${width}`);
    await expectAxe(page, `org-counts/mine-failed/${width}`);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
    await page.close();
  }
});
