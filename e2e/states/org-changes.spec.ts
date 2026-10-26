// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { expectAxe, fits } from "../a11y";
import { LONG_NAME } from "../mock/fixtures";
import { mockScreen } from "../mock/screen";
import { orgChange } from "../mock/org-changes";
import { orgChangeScreens, type OrgChangeState, type State } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

for (const screen of orgChangeScreens) for (const state of Object.keys(screen.states) as (State | OrgChangeState)[]) for (const width of [1440, 390]) {
  test(`${screen.key}: ${state} at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const fixture = await mockScreen(page, screen, state);
    try {
      await page.goto(screen.path);
      const main = page.getByRole("main");
      if (state === "loading") {
        await expect(main.locator('[aria-busy="true"]').last()).toBeVisible();
        await expect(main.locator("[data-read-layout]").last()).toHaveAttribute("data-read-layout", screen.key === "org-changes" ? "list" : "record");
        await expect(main.getByText(t("orgChange.list.empty.all"), { exact: true })).toHaveCount(0);
      } else if (state === "failed") {
        await expect(main.getByText(t("common.loadFailed.title"), { exact: true })).toBeVisible({ timeout: 20_000 });
        await expect(main.getByRole("button", { name: t("common.retry"), exact: true })).toBeEnabled();
        await expect(main.getByText(fixture.operationId, { exact: true })).toBeVisible();
      } else if (state === "refused") {
        const refusal = main.getByRole("region", { name: t("common.denied.title.plain") });
        await expect(refusal).toBeVisible();
        await expect(refusal).toContainText("김권한담당");
        await expect(refusal.getByRole("button", { name: t("common.denied.request"), exact: true })).toBeEnabled();
      } else if (state === "missing") {
        await expect(main.getByRole("heading", { name: t("common.read.notFound.title") })).toBeVisible();
        await expect(main.getByRole("link", { name: t("orgChange.list.title"), exact: true })).toHaveAttribute("href", "/org/changes");
      } else if (state === "empty") {
        await expect(main.getByRole("heading", { name: t("orgChange.list.empty.all") })).toBeVisible();
        await expect(main.getByRole("link", { name: t("orgChange.list.empty.action") })).toHaveAttribute("href", "/org");
      } else if (screen.key === "org-changes") {
        const table = main.getByRole("table", { name: t("orgChange.list.title") });
        await expect(table.getByRole("link", { name: "OC-2026-0001", exact: true })).toBeVisible();
        await expect(table.locator("tbody > tr")).toHaveCount(Math.min(fixture.count, 50));
        if (state === "long") await expect(table).toContainText(LONG_NAME.repeat(3));
        if (state === "large") {
          await main.getByRole("button", { name: t("common.page.next"), exact: true }).click();
          await expect(table.getByRole("link", { name: "OC-2026-0051", exact: true })).toBeVisible();
          await expect(table.locator("tbody > tr")).toHaveCount(50);
          await main.getByRole("button", { name: t("common.page.prev"), exact: true }).click();
          await expect(table.getByRole("link", { name: "OC-2026-0001", exact: true })).toBeVisible();
        }
      } else {
        const record = orgChange(state);
        await expect(main.getByRole("heading", { level: 1 })).toHaveText(t("orgChange.title.create", { name: state === "long" ? LONG_NAME.repeat(3) : "검증부서 1" }));
        await expect(main.locator("header")).toContainText(t(`enum.orgChangeStatus.${record.status}`));
        await expect(main.getByRole("region", { name: t("orgChange.proposal"), exact: true })).toContainText(state === "long" ? LONG_NAME.repeat(8) : "조직 운영 개선");
        await expect(main.getByRole("complementary", { name: t("orgChange.history"), exact: true }).getByRole("listitem")).toHaveCount(state === "large" ? 2000 : 3);
        if (state === "draft" || state === "prechecked") await expect(main.getByRole("region", { name: "사전 점검", exact: true })).toContainText("통과");
        if (state === "approval") await expect(main.getByRole("region", { name: t("orgChange.next.title") })).toContainText(t("orgChange.turn", { role: "인사" }));
        if (state === "rejected") await expect(main).toContainText("시행일을 다시 검토해 주십시오");
        if (state === "settling") await expect(main).toContainText("직책 정리");
      }
      await fits(page, `${screen.key}/${state}/${width}`);
      await expectAxe(page, `${screen.key}/${state}/${width}`);
      expect(errors).toEqual([]);
      expect(fixture.unexpected, "register every supporting read").toEqual([]);
    } finally {
      await page.close();
      fixture.release();
    }
  });
}

test("saved views use server filters and keep phone cards linked to their record @ui-state", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const screen = orgChangeScreens[0];
  const fixture = await mockScreen(page, screen, "populated");
  try {
    await page.goto(screen.path);
    const main = page.getByRole("main");
    const views = main.getByRole("group", { name: t("orgChange.list.views") });
    const table = main.getByRole("table", { name: t("orgChange.list.title") });
    for (const [view, count] of [["open", 2], ["ready", 1], ["done", 1], ["mine", 2]] as const) {
      const pick = views.getByRole("button", { name: `${t(`orgChange.list.view.${view}`)} ${fmtNumber(count)}`, exact: true });
      await pick.click();
      await expect(pick).toHaveAttribute("aria-pressed", "true");
      await expect(table.locator("tbody > tr")).toHaveCount(count);
    }
    const code = table.getByRole("link", { name: "OC-2026-0001", exact: true });
    await code.focus();
    await expect(code).toBeFocused();
    await code.press("Enter");
    await expect(page).toHaveURL(new RegExp(`${orgChangeScreens[1].path}$`));
    await expect(main.getByRole("heading", { level: 1 })).toHaveText(t("orgChange.title.create", { name: "검증부서 1" }));
    await fits(page, "org-change/linked/390");
    expect(fixture.unexpected).toEqual([]);
  } finally {
    await page.close();
    fixture.release();
  }
});
