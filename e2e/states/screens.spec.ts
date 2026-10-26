// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { expectAxe, fits } from "../a11y";
import { id, LONG_NAME } from "../mock/fixtures";
import { mockScreen } from "../mock/screen";
import { screens, type State } from "./registry";

test.beforeAll(() => loadCatalog("ko"));

for (const screen of screens) for (const state of Object.keys(screen.states) as State[]) for (const width of [1440, 390]) {
  test(`${screen.key}: ${state} at ${width}px @ui-state`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const fixture = await mockScreen(page, screen, state);
    try {
      const requested = page.waitForRequest(request => new URL(request.url()).pathname === screen.read);
      await page.goto(screen.path);
      await requested;
      const main = page.getByRole("main");
      if (state === "loading") {
        await expect(main.locator('[aria-busy="true"]').last()).toBeVisible();
        await expect(main.locator("[data-read-layout]").last()).toBeVisible();
        await expect(main.getByText(t("home.noWork.title"), { exact: true })).toHaveCount(0);
        await expect(main.locator("#first-run, #first-run-title")).toHaveCount(0);
      } else if (state === "failed") {
        await expect(main.getByText("불러오지 못했습니다", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
        await expect(main.getByRole("button", { name: "다시 불러오기", exact: true }).first()).toBeVisible();
        await expect(main.getByText(fixture.operationId, { exact: true }).first()).toBeVisible();
      } else if (state === "refused") {
        const refusal = main.getByRole("region", { name: "이 화면에 접근 권한이 없습니다" });
        await expect(refusal).toBeVisible();
        await expect(refusal).toContainText("김권한담당");
        await expect(refusal.getByRole("button", { name: t("common.denied.request"), exact: true })).toBeVisible();
      } else if (state === "empty") {
        await expect(screen.key === "home" ? main.getByText(t("home.noWork.title"), { exact: true }) : main.locator(screen.key === "people" ? "#first-run" : "#first-run-title")).toBeVisible();
      } else {
        await expect(main.locator('[aria-busy="true"]')).toHaveCount(0);
        if (screen.key === "home") {
          const rows = main.getByRole("region", { name: "업무함", exact: true }).getByRole("listitem");
          await expect(rows).toHaveCount(Math.min(fixture.count, 100));
          await expect(rows.first()).toContainText(state === "long" ? LONG_NAME : "검증직원 1");
          if (state === "large") {
            await main.getByRole("button", { name: t("home.inbox.more"), exact: true }).click();
            await expect(rows).toHaveCount(200);
            await expect(rows.last()).toContainText("UI-0200");
          }
        } else if (screen.key === "people") {
          await expect(main.getByText("UI-0001", { exact: true })).toBeVisible();
          if (state === "long") await expect(main.getByText(LONG_NAME, { exact: true }).first()).toBeVisible();
          if (state === "large") {
            await expect(main.getByRole("note").filter({ hasText: "2,000" })).toBeVisible();
            const table = main.getByRole("grid");
            for (let loaded = 100; loaded < fixture.count; loaded += 100) {
              const nextPage = page.waitForResponse(response => {
                const url = new URL(response.url());
                return url.pathname === screen.read && url.searchParams.get("cursor") === id(100 + loaded - 1) && !url.searchParams.has("offset");
              });
              await table.evaluate(el => { el.scrollTop = el.scrollHeight; });
              await nextPage;
              await expect(main.getByText(t("roster.foot.range", { shown: loaded + 100, total: fixture.count }), { exact: true })).toBeVisible();
            }
            await table.evaluate(el => { el.scrollTop = el.scrollHeight; });
            await expect(table.getByText("UI-2000", { exact: true })).toBeVisible();
            expect(await table.getByRole("row").count()).toBeLessThan(100);
          }
        } else {
          await expect(main.getByRole("tree", { name: "전체 조직도" })).toBeVisible();
          await expect(main.getByRole("treeitem").filter({ hasText: state === "long" ? LONG_NAME : "검증법인" }).first()).toBeVisible();
        }
      }
      if (screen.key === "org") await main.getByRole("group", { name: "보기", exact: true }).getByRole("button", { name: "조직도", exact: true }).click({ trial: true });
      await fits(page, `${screen.key}/${state}/${width}`);
      await expectAxe(page, `${screen.key}/${state}/${width}`);
      expect(errors).toEqual([]);
      expect(fixture.unexpected, "add every supporting API read to the typed fixture").toEqual([]);
    } finally {
      await page.close();
      fixture.release();
    }
  });
}
