// SPDX-License-Identifier: LicenseRef-Proprietary
import { installFaultClock } from "./fault-clock";
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { failure, id } from "../mock/fixtures";
import { filtersFixture } from "./access-log-filters-fixture";
import { expectStable, recordShifts } from "../stability";

for (const state of ["available", "absent", "failed", "search_invalid"] as const) {
  test(`access-log actor availability waits for loaded choices: ${state} @ui-state`, async ({ page }, testInfo) => {
    if (state === "failed") await installFaultClock(page);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.addInitScript(() => localStorage.setItem("console.theme", "dark"));
    const fixture = await filtersFixture(page);
    let release!: () => void;
    const response = new Promise<void>(resolve => { release = resolve; });
    await page.route(url => url.pathname === "/api/v1/access/access-log", async route => {
      await response;
      if (state === "failed" || state === "search_invalid") {
        await route.fulfill({ status: state === "failed" ? 503 : 422, json: { error: { code: state === "failed" ? "service_unavailable" : "search_invalid", message: "unavailable" } } });
      } else await route.fallback();
    });
    try {
      await page.goto(`/audit/access-log?period=2026-10&actor=${id(state === "absent" ? 102 : 101)}${state === "search_invalid" ? "&search=invalid" : ""}`);
      await expect(page.getByRole("status", { name: /^불러오는 중/ })).toBeVisible();
      await expect(page.getByText("선택할 수 없는 접속자", { exact: true })).toHaveCount(0);
      await expect(page.getByLabel("적용한 필터", { exact: true })).toHaveCount(0);
      release();
      if (state === "failed" || state === "search_invalid") {
        await expect(page.getByRole("button", { name: "다시 불러오기", exact: true })).toBeVisible();
        await expect(page.getByText("선택할 수 없는 접속자", { exact: true })).toHaveCount(0);
        await expect(page.getByLabel("적용한 필터", { exact: true })).toHaveCount(0);
      } else {
        await expect(page.getByRole("grid")).toBeVisible();
        await expect(page.getByLabel("적용한 필터", { exact: true })).toHaveText(`접속자${state === "available" ? "김민수" : "선택할 수 없는 접속자"}`);
      }
      await fits(page, `audit actor ${state}`);
      await expectAxe(page, `audit actor ${state}`);
      await page.screenshot({ path: testInfo.outputPath(`actor-${state}.png`), fullPage: true });
      expect(fixture.unexpected).toEqual([]);
    } finally { release(); fixture.release(); }
  });
}

test("access-log keeps clear search in place and presents the applied filters together @ui-state", async ({ page }) => {
  await loadCatalog("ko");
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await filtersFixture(page);
  const read = Promise.withResolvers<void>();
  const requested = Promise.withResolvers<void>();
  await page.route(url => url.pathname === "/api/v1/access/access-log", async route => {
    requested.resolve();
    await read.promise;
    await route.fallback();
  });
  const clearSearch = page.getByRole("button", { name: t("accessLog.clearSearch"), exact: true });
  const summary = page.getByLabel(t("accessLog.appliedFilters"), { exact: true });
  const review = page.getByRole("button", { name: t("accessLog.review.open"), exact: true });
  try {
    const query = new URLSearchParams({ period: "2026-10", actor: fixture.actor.id, action: "employee.export",
      target_type: "employee", from: "2026-10-05", to: "2026-10-20" });
    await page.goto(`/audit/access-log?${query}`);
    await requested.promise;
    await expect(clearSearch).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const before = await clearSearch.boundingBox();
    await expect(summary).toHaveCount(0);
    await expect(review).toBeDisabled();
    read.resolve();
    await expect(summary.locator("dd")).toHaveText([fixture.actor.label, t("accessLog.action.employee.export"),
      t("accessLog.target.employee"), "2026. 10. 05.", "2026. 10. 20."]);
    await expect(review).toBeEnabled();
    expect(await clearSearch.boundingBox()).toEqual(before);
    expect(fixture.unexpected).toEqual([]);
  } finally { read.resolve(); fixture.release(); }
});

test("access-log keeps the stale-filter alert in place while choices load @ui-state", async ({ page }) => {
  await loadCatalog("ko");
  await page.setViewportSize({ width: 390, height: 900 });
  await page.addInitScript(recordShifts);
  await page.addInitScript(() => localStorage.setItem("console.theme", "dark"));
  const fixture = await filtersFixture(page);
  const choices = Promise.withResolvers<void>();
  await page.route(url => url.pathname === "/api/v1/access/access-log", async route => {
    if (new URL(route.request().url()).searchParams.has("action")) {
      await route.fulfill({ status: 422, json: failure("filter_invalid") });
    } else {
      await choices.promise;
      await route.fallback();
    }
  });
  try {
    const query = new URLSearchParams({ period: "2026-10", actor: fixture.actor.id, action: "unavailable",
      target_type: "employee", from: "2026-10-05", to: "2026-10-20" });
    await page.goto(`/audit/access-log?${query}`);
    await expect(page.getByRole("alert").getByRole("heading", { name: t("accessLog.filterInvalid") })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    choices.resolve();
    await expect(page.getByLabel(t("accessLog.appliedFilters"), { exact: true })).toContainText(fixture.actor.label);
    await expectStable(page, "access-log stale filter choices");
    await expect(page.getByRole("button", { name: t("accessLog.review.open"), exact: true })).toBeEnabled();
    expect(fixture.unexpected).toEqual([]);
  } finally { choices.resolve(); fixture.release(); }
});
