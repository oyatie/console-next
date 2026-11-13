// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fmtMonth } from "@console/i18n/format";
import { expectAxe, fits } from "../a11y";
import { attendanceBoardScreens } from "../states/attendance";
import { mockScreen } from "./screen";
import { mockRoute } from "./route";
import { attendanceLayer } from "./attendance-board";
import { failure, id } from "./fixtures";

test.beforeAll(() => loadCatalog("ko"));

for (const width of [1440, 1280, 390]) for (const populated of [false, true]) {
  test(`calendar waits for ${populated ? "populated" : "empty"} history at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => localStorage.setItem("console.theme", "dark"));
    const screen = attendanceBoardScreens.find(s => s.key === "attendance-calendar")!;
    const fixture = await mockScreen(page, screen, "populated");
    const held = Promise.withResolvers<void>();
    const requested = Promise.withResolvers<void>();
    await mockRoute(page, "get", "/api/v1/attendance/schedule/layers", async () => {
      requested.resolve();
      await held.promise;
      return { status: 200, json: { items: populated ? [attendanceLayer] : [] } };
    });
    const calendar = page.waitForResponse(response => new URL(response.url()).pathname === screen.read);
    await page.goto(screen.path);
    await requested.promise;
    await (await calendar).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const assign = page.getByRole("button", { name: t("attendanceSchedule.assign.open"), exact: true });
    try {
      // The history shares the calendar's grid row: exposing the action before it arrives moves the action.
      await expect(assign).toHaveCount(0);
    } finally { held.resolve(); }
    await expect(assign).toBeVisible();
    if (populated) await expect(page.getByRole("table", { name: t("attendanceSchedule.history.title") })).toBeVisible();
    else await expect(page.getByRole("heading", { name: t("attendanceSchedule.history.none"), exact: true })).toBeVisible();
    await assign.scrollIntoViewIfNeeded();
    const before = await assign.boundingBox();
    await fits(page, `calendar ${width}`);
    await expectAxe(page, `calendar ${width}`);
    expect(await assign.boundingBox()).toEqual(before);
    await page.screenshot({ path: test.info().outputPath("calendar.png") });
    expect(fixture.unexpected).toEqual([]);
  });
}

for (const width of [1440, 1280, 390]) {
  test(`scope switch keeps tree search and focus at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => localStorage.setItem("console.theme", "dark"));
    const screen = attendanceBoardScreens.find(s => s.key === "attendance-calendar")!;
    const fixture = await mockScreen(page, screen, "populated");
    await mockRoute(page, "get", "/api/v1/attendance/schedule/tree", { status: 200, json: {
      date: "2026-10-04", people_total: 3, people_unscheduled: 0, holidays_loaded: true,
      nodes: [
        { id: id(4), name: "본사", kind: "WORKPLACE", people: 2, unscheduled: 0 },
        { id: id(5), name: "본점", kind: "WORKPLACE", people: 1, unscheduled: 0 },
      ],
    } });
    const held = Promise.withResolvers<void>();
    const requested = Promise.withResolvers<void>();
    await mockRoute(page, "get", "/api/v1/attendance/schedule/layers", async request => {
      if (new URL(request.url()).searchParams.get("scope_id") === id(5)) {
        requested.resolve();
        await held.promise;
        return { status: 200, json: { items: [{ ...attendanceLayer, id: id(703), scope_id: id(5), scope_name: "본점", pattern_name: "본점 근무" }] } };
      }
      return { status: 200, json: { items: [attendanceLayer] } };
    });
    const initialReads = Promise.all([screen.read, "/api/v1/attendance/schedule/layers"].map(path =>
      page.waitForResponse(response => new URL(response.url()).pathname === path).then(response => response.finished())));
    await page.goto(screen.path);
    await initialReads;
    const cancel = page.getByRole("button", { name: t("attendanceSchedule.history.cancelOne", { pattern: attendanceLayer.pattern_name }), exact: true });
    await expect(cancel).toBeEnabled();
    const find = page.getByRole("searchbox", { name: t("attendanceSchedule.tree.find") });
    await find.fill("본");
    const original = await find.elementHandle();
    const branch = page.getByRole("treegrid", { name: t("attendanceSchedule.tree.label") }).getByRole("row", { name: /^본점/ });
    await branch.click();
    await requested.promise;
    try {
      await expect(find).toHaveValue("본");
      expect(await original!.evaluate(element => element.isConnected)).toBe(true);
      await expect(branch).toBeFocused();
      await expect(cancel).toBeDisabled();
    } finally { held.resolve(); }
    await expect(page.getByRole("button", { name: t("attendanceSchedule.history.cancelOne", { pattern: "본점 근무" }), exact: true })).toBeEnabled();
    await expect(find).toHaveValue("본");
    await expect(branch).toBeFocused();
    expect(await original!.evaluate(element => element.isConnected)).toBe(true);
    await original!.dispose();
    await fits(page, `scope switch ${width}`);
    expect(fixture.unexpected).toEqual([]);
  });
}

test("history outage stays inline and can recover without replacing the calendar", async ({ page }) => {
  const screen = attendanceBoardScreens.find(s => s.key === "attendance-calendar")!;
  const fixture = await mockScreen(page, screen, "populated");
  await mockRoute(page, "get", "/api/v1/attendance/schedule/layers", { status: 503, json: failure("service_unavailable") });
  await page.goto(screen.path);
  const retry = page.getByRole("button", { name: t("common.retry"), exact: true });
  await expect(retry).toBeVisible({ timeout: 30_000 });
  const grid = page.getByRole("grid", { name: t("attendanceSchedule.calendar.label", { scope: "본사", month: fmtMonth("2026-10") }) });
  await expect(grid).toBeVisible();
  const find = page.getByRole("searchbox", { name: t("attendanceSchedule.tree.find") });
  await find.fill("본");
  const original = await find.elementHandle();
  await mockRoute(page, "get", "/api/v1/attendance/schedule/layers", { status: 200, json: { items: [attendanceLayer] } });
  await retry.click();
  await expect(page.getByRole("table", { name: t("attendanceSchedule.history.title") })).toBeVisible();
  await expect(grid).toBeVisible();
  await expect(find).toHaveValue("본");
  expect(await original!.evaluate(element => element.isConnected)).toBe(true);
  await original!.dispose();
  expect(fixture.unexpected).toEqual([]);
});

for (const width of [1280, 390]) {
  test(`history refilling reserves the assign position at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const screen = attendanceBoardScreens.find(s => s.key === "attendance-calendar")!;
    const fixture = await mockScreen(page, screen, "populated");
    await mockRoute(page, "get", "/api/v1/attendance/schedule/layers", { status: 200, json: { items: [] } });
    const initialReads = Promise.all([screen.read, "/api/v1/attendance/schedule/layers"].map(path =>
      page.waitForResponse(response => new URL(response.url()).pathname === path).then(response => response.finished())));
    await page.goto(screen.path);
    await initialReads;
    const assign = page.getByRole("button", { name: t("attendanceSchedule.assign.open"), exact: true });
    await expect(assign).toBeVisible();
    await assign.scrollIntoViewIfNeeded();
    const before = await assign.evaluate(element => element.getBoundingClientRect().top + scrollY);
    await mockRoute(page, "get", "/api/v1/attendance/schedule/layers", { status: 200, json: { items: [attendanceLayer] } });
    await page.reload();
    await expect(page.getByRole("table", { name: t("attendanceSchedule.history.title") })).toBeVisible();
    await assign.scrollIntoViewIfNeeded();
    expect(await assign.evaluate(element => element.getBoundingClientRect().top + scrollY)).toBe(before);
    await fits(page, `history refilling ${width}`);
    await page.screenshot({ path: test.info().outputPath("history-refilled.png") });
    expect(fixture.unexpected).toEqual([]);
  });
}

for (const status of [403, 404]) {
  test(`history ${status} keeps the read refusal boundary`, async ({ page }) => {
    const screen = attendanceBoardScreens.find(s => s.key === "attendance-calendar")!;
    const fixture = await mockScreen(page, screen, "populated");
    await page.route(url => url.pathname === "/api/v1/attendance/schedule/layers", route => route.fulfill({
      status, json: failure(status === 403 ? "forbidden" : "not_found"),
    }));
    await page.goto(screen.path);
    await expect(page.getByRole("heading", { name: t(status === 403 ? "common.denied.title.plain" : "common.read.notFound.title"), exact: true })).toBeVisible();
    await expect(page.getByRole("searchbox", { name: t("attendanceSchedule.tree.find") })).toHaveCount(0);
    await expect(page.getByRole("button", { name: t("attendanceSchedule.assign.open"), exact: true })).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  });
}
