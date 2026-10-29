// SPDX-License-Identifier: LicenseRef-Proprietary
import { loadCatalog, t } from "@console/i18n";
import { expect, test } from "@playwright/test";
import { expectAxe, fits } from "../a11y";
import { exitTrail, mockExitCase } from "../mock/people-exits";
import { peopleExitScreens, type ExitCaseState } from "./people-exits";
import { mockScreen } from "../mock/screen";
import { screens } from "./registry";
import { mockRoute } from "../mock/route";

const exitCaseScreen = peopleExitScreens[0];

test.beforeAll(() => loadCatalog("ko"));

for (const state of Object.keys(exitCaseScreen.states) as ExitCaseState[]) for (const width of [1440, 1200, 390]) {
  test(`exit-case ${state} at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const fixture = await mockScreen(page, screens[1], "populated");
    await mockExitCase(page, state);
    try {
      await page.goto(exitCaseScreen.path);
      const main = page.getByRole("main");
      if (state === "missing") await expect(main.getByRole("heading", { name: t("common.read.notFound.title") })).toBeVisible();
      else if (state === "failed") await expect(main.getByRole("button", { name: t("common.retry"), exact: true })).toBeVisible({ timeout: 20_000 });
      else {
        const board = main.getByRole("region", { name: "단계별 업무", exact: true });
        await expect(board).toBeVisible();
        const legs = ["결재", "인수인계", "정산·급여", "접근·장비", "서류", "법정 신고"].map(name => board.getByRole("region", { name, exact: true }));
        for (const leg of legs) await expect(leg).toBeVisible();
        await expect(main.getByRole("region", { name: "사건 일정", exact: true }).getByText("오늘", { exact: true })).toBeVisible();
        await expect(legs[2]!).toContainText("D-3");
        await expect(legs[2]!.getByText("급여 연동 전", { exact: true })).toHaveCount(3);
        await expect(legs[2]!).not.toContainText("D+9");
        await expect(board).not.toContainText("2099");
        for (const item of exitTrail().items.filter(item => item.kind !== "FIL")) await expect(board).toContainText(item.label);
        if (state === "closed") await expect(board.getByRole("button")).toHaveCount(0);
        else await expect(legs[2]!.getByRole("button", { name: "증빙 확인 완료", exact: true })).toHaveCount(4);
        const boxes = await Promise.all(legs.map(leg => leg.boundingBox()));
        if (width >= 1360) expect(new Set(boxes.map(box => box!.y)).size).toBe(1);
        else if (width === 1200) expect(boxes[3]!.y).toBeGreaterThan(boxes[0]!.y);
        else for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.y).toBeGreaterThanOrEqual(boxes[i - 1]!.y + boxes[i - 1]!.height);
      }
      await fits(page, `exit-case/${state}/${width}`);
      await expectAxe(page, `exit-case/${state}/${width}`);
      expect(fixture.unexpected).toEqual([]);
    } finally { await page.close(); fixture.release(); }
  });
}

test("exit board is discoverable in /_gallery @ui-state", async ({ page }) => {
  const fixture = await mockScreen(page, screens[1], "populated");
  try {
    await page.goto("/_gallery");
    await expect(page.locator("#gallery-exit-board").getByRole("region", { name: "단계별 업무", exact: true })).toBeVisible();
  } finally { await page.close(); fixture.release(); }
});

test("P1-1 each leg exposes its cards as a list @ui-state", async ({ page }) => {
  const fixture = await mockScreen(page, screens[1], "populated");
  await mockExitCase(page, "reported");
  try {
    await page.goto(exitCaseScreen.path);
    await expect(page.getByRole("region", { name: "퇴직" })).toHaveCount(1);
    const action = page.locator("#exit-now");
    await expect(action).toBeVisible();
    const ribbon = page.getByRole("region", { name: "사건 일정", exact: true });
    expect((await action.boundingBox())!.y).toBeLessThan((await ribbon.boundingBox())!.y);
    for (const item of exitTrail().items) {
      await expect(page.getByRole("listitem").and(page.locator(`[id="item-${item.id}"]`))).toBeVisible();
    }
  } finally { await page.close(); fixture.release(); }
});

test("P1-2 blocking payroll documents keep their legal date and completion path @ui-state", async ({ page }) => {
  const fixture = await mockScreen(page, screens[1], "populated");
  await mockExitCase(page, "reported");
  try {
    await page.goto(exitCaseScreen.path);
    for (const key of ["X8", "X14", "X15"]) {
      const item = exitTrail().items.find(item => item.item_key === key)!;
      const card = page.locator(`[id="item-${item.id}"]`);
      await expect(card.locator('time[datetime="2026-11-09"]')).toBeVisible();
      await expect(card.getByRole("button", { name: "증빙 확인 완료", exact: true })).toBeEnabled();
      await expect(card).not.toContainText("D+9");
    }
  } finally { await page.close(); fixture.release(); }
});

test("P1-3 header and countdown follow the tenant deadline window @ui-state", async ({ page }) => {
  const fixture = await mockScreen(page, screens[1], "populated");
  await mockExitCase(page, "reported");
  const settings = (days: number) => mockRoute(page, "get", "/api/v1/settings", { status: 200, json: { can_change: false, items: [{
    key: "display.deadline_due_soon_days", kind: { type: "int", unit: "days" }, default: days, value: days,
    looser_when: "neutral", governance: "read_only", legal_basis: null, version: "code_default", effective_from: null, scheduled: [],
    source: { layer: "code_default", scope_entity_id: null },
    chain: [
      { layer: "tenant", scope_entity_id: null, value: null, effective_from: null, deciding: false },
      { layer: "code_default", scope_entity_id: null, value: days, effective_from: null, deciding: true },
    ],
  }] } });
  try {
    for (const days of [2, 12]) {
      await settings(days);
      await page.goto(exitCaseScreen.path);
      const leg = page.getByRole("region", { name: "정산·급여", exact: true });
      const chip = leg.getByText("D-3", { exact: true });
      await expect(chip).toBeVisible();
      await expect(chip).toHaveClass(new RegExp(days === 2 ? "far" : "due"));
      await expect(leg.getByText("기한 임박", { exact: true })).toHaveCount(days === 2 ? 0 : 1);
    }
  } finally { await page.close(); fixture.release(); }
});

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`close refusal opens blocking item ${width} ${theme} @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const fixture = await mockScreen(page, screens[1], "populated");
    await mockExitCase(page, "reported");
    const problem: import("@console/api").components["schemas"]["LifecycleProblem"] = {
      type: "about:blank", title: "Conflict", status: 409, error: { code: "lifecycle.refuse.close_blocked", message: "internal basis" },
    };
    await page.route(url => url.pathname === `/api/v1/lifecycle-cases/${exitTrail().id}/close`, route => route.fulfill({ status: 409, contentType: "application/problem+json", json: problem }));
    await page.goto(exitCaseScreen.path);
    await page.locator("html").evaluate((el, value) => el.dataset.theme = value, theme);
    await page.getByRole("button", { name: t("lifecycle.trail.close"), exact: true }).click();
    const refusal = page.getByRole("alert");
    await expect(refusal).toContainText(t("lifecycle.refuse.close_blocked"));
    await expect(refusal.getByText("lifecycle.refuse.close_blocked", { exact: true })).toBeVisible();
    const link = refusal.getByRole("link", { name: t("lifecycle.trail.openBlocking"), exact: true });
    await expect(link).toHaveAttribute("href", `${exitCaseScreen.path}#item-${exitTrail().items[0]!.id}`);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`#item-${exitTrail().items[0]!.id}$`));
    await fits(page, `close-refusal/${width}/${theme}`);
    await expectAxe(page, `close-refusal/${width}/${theme}`);
    expect(fixture.unexpected).toEqual([]);
  });
}
