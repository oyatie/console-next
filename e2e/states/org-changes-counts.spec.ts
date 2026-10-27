// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { mockScreen } from "../mock/screen";
import { mockOrgChangeCounts, type CountState } from "../mock/org-changes-web";
import { orgChangeScreens } from "./registry";
import { failure } from "../mock/fixtures";

test.beforeAll(() => loadCatalog("ko"));
for (const state of ["loading", "failed", "counts-failed", "counts-loading", "populated", "legacy"] as CountState[]) for (const width of [1440, 390]) {
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
        expect(counts.requests).toHaveLength(1);
      }
      if (!["populated", "legacy"].includes(state)) await expect(tabs.getByRole("button").filter({ hasText: /\d/ })).toHaveCount(0);
      if (state === "loading" || state === "failed") {
        await expect(tabs.locator('button[aria-disabled="true"]')).toHaveCount(6);
        const first = tabs.getByRole("button").first();
        await first.focus();
        await expect(first).toBeFocused();
        await first.press("Enter");
        await expect(page).toHaveURL(/view=all$/);
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
    if (new URL(route.request().url()).searchParams.get("status") === "APPROVED") await held;
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
    expect(counts.requests).toHaveLength(1);
    expect(counts.requests[0]!.searchParams.get("effective_from")).toBe("2026-11-01");
    expect(counts.requests[0]!.searchParams.get("effective_to")).toBe("2026-11-30");
    expect(listQueries.some(url => url.searchParams.get("limit") === "1")).toBe(false);
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
    if (new URL(route.request().url()).searchParams.has("drafted_by")) return route.fulfill({ status: 503, json: failure("service_unavailable") });
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
